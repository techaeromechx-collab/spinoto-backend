'use strict';

/**
 * /api/hub-payouts — money going OUT to workshops.
 *
 * This controller is thin on purpose. Every rule about money — what may be paid,
 * how much, whether a transfer is already in flight, when the ledger moves —
 * lives in services/payouts.service.js, because there are three screens that can
 * start a payout and a rule enforced in one of them is a rule that does not
 * exist.
 *
 * What IS here: permission gating, hub scoping, and shaping rows for a screen.
 *
 * ── NOTHING HERE RUNS ON A SCHEDULE ─────────────────────────────────────────
 * There is no endpoint that pays everything due, and no cron entry anywhere that
 * calls one. Every payout in this system happens because a person pressed a
 * button and saw the amount first. That is a deliberate constraint, not a gap to
 * be filled in later without discussion — see the top of payouts.service.js.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { hubScopeSql } = require('../utils/hubScope');
const {
  requestPayout, refreshPayout, registerHubForPayouts, hubPayoutReadiness,
  OPEN_STATUSES,
} = require('../services/payouts.service');
const { payoutGatewayStatus } = require('../services/gateway');

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    }
    if (err.code === '23505') {
      // The partial unique index on gateway_payout_id, or on (payout, invoice).
      // Both mean the same thing to a person: this has already been done.
      return res.status(409).json({ error: 'This payout has already been recorded.' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

const PAYOUT_SELECT = `
  SELECT
    p.id, p.payout_ref, p.gateway, p.mode, p.hub_id, p.amount, p.currency,
    p.status, p.method, p.gateway_payout_id, p.utr, p.failure_reason,
    p.notes, p.created_at, p.updated_at, p.processed_at, p.reversed_at,
    h.hub_name,
    -- Last four only. A payouts list is a screen people screenshot into support
    -- chats; a full account number on it is a full account number in a chat.
    RIGHT(h.bank_account_number, 4) AS account_last4,
    h.bank_name,
    u.name AS requested_by_name,
    (SELECT json_agg(json_build_object(
              'purchase_invoice_id', l.purchase_invoice_id,
              'amount', l.amount,
              'token', lpi.public_token)
            ORDER BY l.purchase_invoice_id)
       FROM hub_payout_lines l
       LEFT JOIN purchase_invoices lpi ON lpi.id = l.purchase_invoice_id
      WHERE l.hub_payout_id = p.id) AS lines
  FROM hub_payouts p
  JOIN hubs h ON h.id = p.hub_id
  LEFT JOIN users u ON u.id = p.requested_by
`;

/**
 * WHAT LEFT THE ACCOUNT, whichever way it moved.
 *
 * ── WHY THIS READS hub_payments AND NOT hub_payouts ─────────────────────────
 * The question this screen exists to answer — "what did we pay each hub this
 * month" — is a question about MONEY, and the table that means money-that-left
 * is hub_payments. Both kinds of payout are already in it: one recorded from a
 * banking app, one written when a transfer confirmed, the second carrying a
 * hub_payout_id as well.
 *
 * Reading hub_payouts instead would answer a narrower question — what the
 * provider sent — and leave every payment made by hand out of the total. An
 * accountant then adds two screens together by hand, with no way to check
 * nothing was counted twice. One SUM over one table is the whole point.
 *
 * ── GROUPING ────────────────────────────────────────────────────────────────
 * One line per PAYMENT, not per invoice. A transfer covering three invoices is
 * three ledger rows (migration 105 explains why they can never be collapsed in
 * the table) but it was one movement of money and the bank statement shows one
 * line. payment_batch_id is the shared key for both a bulk manual payment and a
 * gateway payout — which is why a confirmed payout writes its payout_ref there.
 *
 * The 'b:' / 'p:' prefixes keep the two key spaces apart. Without them a batch
 * id that happened to equal a row id would merge two unrelated payments into one
 * line, and the total would still look right.
 */
const LEDGER_PAYOUTS = `
  WITH rows AS (
    SELECT
      hp.id, hp.paid_at, hp.amount, hp.method, hp.reference_no, hp.notes,
      hp.purchase_invoice_id, hp.hub_payout_id, hp.created_by,
      pi.hub_id, pi.public_token,
      CASE WHEN hp.payment_batch_id IS NOT NULL
           THEN 'b:' || hp.payment_batch_id
           ELSE 'p:' || hp.id::text END AS group_key
    FROM hub_payments hp
    JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
    %WHERE%
  )
  SELECT
    r.group_key,
    r.hub_id,
    h.hub_name,
    -- Last four only. This screen gets screenshotted into support chats.
    RIGHT(h.bank_account_number, 4) AS account_last4,
    h.bank_name,
    MIN(r.paid_at)              AS paid_at,
    SUM(r.amount)               AS amount,
    MIN(r.method)               AS method,
    MIN(r.reference_no)         AS reference_no,
    -- MAX over a column that is either NULL on every row of a group or set on
    -- every row: a batch is entirely by-hand or entirely a transfer, because a
    -- payout writes its own payment_batch_id and nothing else shares it.
    MAX(r.hub_payout_id)        AS hub_payout_id,
    MAX(po.payout_ref)          AS payout_ref,
    MAX(po.status)              AS payout_status,
    MAX(po.utr)                 AS utr,
    MIN(u.name)                 AS recorded_by,
    -- ONE ENTRY PER INVOICE, not per ledger row.
    --
    -- A group can legitimately hold two rows for the same purchase invoice — a
    -- split payment recorded twice under one batch id, or a correction. Aggregated
    -- straight, that renders the same PI number twice and hands React two children
    -- with the same key, which is the warning the customer Payments tab and the
    -- Payments list have both already had to be fixed for. Summed per invoice
    -- here, so the cell is right and the keys are unique by construction rather
    -- than by luck.
    (SELECT json_agg(x ORDER BY x->>'purchase_invoice_id')
       FROM (SELECT json_build_object(
                      'purchase_invoice_id', r2.purchase_invoice_id,
                      'amount', SUM(r2.amount),
                      'token', MIN(r2.public_token)) AS x
               FROM rows r2
              WHERE r2.group_key = r.group_key AND r2.hub_id = r.hub_id
              GROUP BY r2.purchase_invoice_id) s) AS invoices,
    COUNT(DISTINCT r.purchase_invoice_id)::int AS invoice_count
  FROM rows r
  JOIN hubs h ON h.id = r.hub_id
  LEFT JOIN hub_payouts po ON po.id = r.hub_payout_id
  LEFT JOIN users u ON u.id = r.created_by
  GROUP BY r.group_key, r.hub_id, h.hub_name, h.bank_account_number, h.bank_name
`;

/**
 * GET /api/hub-payouts
 *
 * Three lists, deliberately separate rather than one with a status column:
 *
 *   paid       money that left. The only one that carries a total.
 *   in_flight  sent, not yet confirmed. NOT money — see the comment on the
 *              summary below for why mixing it in breaks a reconciliation.
 *   reversed   money that left and came back. Its ledger rows were deleted, so
 *              it contributes nothing to any total, but the record survives on
 *              hub_payouts and hiding it would make a bounced transfer simply
 *              vanish from the month it happened in.
 */
function listPayouts(req, res, next) {
  handle(req, res, next, async () => {
    // ── Paid ────────────────────────────────────────────────────────────────
    const conditions = [];
    const params = [];

    const hubScope = hubScopeSql(req, params, 'pi.hub_id');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`pi.hub_id = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`hp.paid_at::date >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`hp.paid_at::date <= $${params.length}::date`);
    }
    // 'bank' | 'hand'. The tag is a filter as well as a label, because "show me
    // only what I typed in" is the first thing anyone asks when a figure is off.
    if (req.query.source === 'bank') conditions.push('hp.hub_payout_id IS NOT NULL');
    if (req.query.source === 'hand') conditions.push('hp.hub_payout_id IS NULL');

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10)));

    const paid = await pool.query(
      `${LEDGER_PAYOUTS.replace('%WHERE%', where)} ORDER BY paid_at DESC LIMIT ${limit}`,
      params);

    // ── In flight and reversed ──────────────────────────────────────────────
    // Both come from hub_payouts, because neither has ledger rows to read: one
    // has not written them yet, the other had them deleted.
    const pConditions = [];
    const pParams = [];
    const pScope = hubScopeSql(req, pParams, 'p.hub_id');
    if (pScope) {
      pConditions.push(pScope);
    } else if (req.query.hub_id) {
      pParams.push(Number(req.query.hub_id));
      pConditions.push(`p.hub_id = $${pParams.length}`);
    }

    // In flight is NOT date-filtered. A transfer sent in July and still stuck
    // today is exactly what someone opening this screen in August needs to see;
    // filtering it into the past is how it stops being anybody's problem.
    const flight = await pool.query(
      `${PAYOUT_SELECT}
        WHERE p.status IN ('created','queued','processing')
          ${pConditions.length ? `AND ${pConditions.join(' AND ')}` : ''}
        ORDER BY p.created_at DESC`, pParams);

    // Reversed and failed DO follow the date filter — they belong to the month
    // the money moved in.
    const rParams = [...pParams];
    const rConditions = [...pConditions];
    if (req.query.from) {
      rParams.push(req.query.from);
      rConditions.push(`p.created_at::date >= $${rParams.length}::date`);
    }
    if (req.query.to) {
      rParams.push(req.query.to);
      rConditions.push(`p.created_at::date <= $${rParams.length}::date`);
    }
    const problems = await pool.query(
      `${PAYOUT_SELECT}
        WHERE p.status IN ('reversed','failed')
          ${rConditions.length ? `AND ${rConditions.join(' AND ')}` : ''}
        ORDER BY p.updated_at DESC LIMIT 50`, rParams);

    res.json({
      items: paid.rows,
      in_flight: flight.rows,
      problems: problems.rows,
    });
  });
}

/**
 * GET /api/hub-payouts/export — the same rows as a CSV.
 *
 * One file rather than two, which is the entire reason this screen was widened:
 * an accountant reconciling a month should not be adding a gateway report to a
 * hand-kept list and hoping nothing appears in both.
 *
 * In-flight transfers are NOT in it. A CSV has no way to show the distinction
 * this screen makes with a separate strip, and an unconfirmed transfer inside a
 * column somebody sums is worse than an omission they can ask about.
 */
function exportPayouts(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params = [];
    const hubScope = hubScopeSql(req, params, 'pi.hub_id');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`pi.hub_id = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`hp.paid_at::date >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`hp.paid_at::date <= $${params.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const r = await pool.query(
      `${LEDGER_PAYOUTS.replace('%WHERE%', where)} ORDER BY paid_at ASC`, params);

    // Quote everything and double any embedded quote. A hub named
    // O'Reilly's, Ahmedabad or a note containing a comma would otherwise shift
    // every following column — silently, in a file nobody re-reads.
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Paid on', 'Hub', 'Invoices', 'Amount', 'Method', 'How', 'Bank reference', 'Our reference', 'Recorded by'];
    const lines = [header.map(esc).join(',')];

    for (const row of r.rows) {
      lines.push([
        row.paid_at ? new Date(row.paid_at).toISOString().slice(0, 10) : '',
        row.hub_name,
        (row.invoices || []).map(i => `PI-${String(i.purchase_invoice_id).padStart(6, '0')}`).join(' '),
        Number(row.amount).toFixed(2),
        row.method,
        row.hub_payout_id ? 'Bank transfer' : 'By hand',
        row.utr || row.reference_no || '',
        row.payout_ref || '',
        row.recorded_by || '',
      ].map(esc).join(','));
    }

    const total = r.rows.reduce((s, x) => s + Number(x.amount), 0);
    lines.push('');
    lines.push([esc(''), esc('TOTAL'), esc(''), esc(total.toFixed(2))].join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="hub-payouts-${req.query.from || 'all'}-to-${req.query.to || 'all'}.csv"`);
    // A BOM, so Excel on Windows opens ₹ and hub names with Indian-language
    // characters as UTF-8 instead of mojibake. The file is for an accountant,
    // and it will be opened in Excel.
    res.send('﻿' + lines.join('\n'));
  });
}

/**
 * GET /api/hub-payouts/summary
 *
 * The three figures at the top of the screen, plus the hubs that cannot be paid.
 *
 * "Due now" is computed from purchase_invoices, not from hub_payouts — it is
 * what SHOULD be paid, and the whole point is that no payout exists for it yet.
 */
function payoutSummary(req, res, next) {
  handle(req, res, next, async () => {
    const dueParams = [];
    const dueScope = hubScopeSql(req, dueParams, 'pi.hub_id');
    // Pushed BEFORE the query is built so $n is whatever position it landed in —
    // hubScopeSql may or may not have taken $1 already, depending on the session.
    dueParams.push(OPEN_STATUSES);
    const openIdx = dueParams.length;

    const due = await pool.query(
      `SELECT COALESCE(SUM(pi.grand_total - COALESCE(pi.amount_paid,0)), 0) AS amount,
              COUNT(*)::int AS invoices,
              COUNT(DISTINCT pi.hub_id)::int AS hubs
         FROM purchase_invoices pi
        WHERE pi.status = 'approved'
          AND pi.payment_status <> 'paid'
          AND pi.payout_due_date IS NOT NULL
          AND pi.payout_due_date <= CURRENT_DATE
          -- Money already on its way is not money still due. Without this the
          -- headline double-counts every payout in flight, which is exactly the
          -- period a person is most likely to be looking at this screen.
          AND NOT EXISTS (
                SELECT 1 FROM hub_payout_lines l
                  JOIN hub_payouts hp ON hp.id = l.hub_payout_id
                 WHERE l.purchase_invoice_id = pi.id
                   AND hp.status = ANY($${openIdx}::text[]))
          ${dueScope ? `AND ${dueScope}` : ''}`,
      dueParams);

    // ── What actually left, over the period on screen ───────────────────────
    //
    // From hub_payments, not hub_payouts: this is the figure an accountant
    // reconciles against a bank statement, and a statement does not care which
    // button was pressed. The by-transfer split is a FILTER on the same SUM
    // rather than a second query — two queries could disagree, and the whole
    // point of this screen is that they cannot.
    const ledgerParams = [];
    const ledgerScope = hubScopeSql(req, ledgerParams, 'pi.hub_id');
    const ledgerWhere = [ledgerScope].filter(Boolean);
    if (req.query.from) {
      ledgerParams.push(req.query.from);
      ledgerWhere.push(`hp.paid_at::date >= $${ledgerParams.length}::date`);
    } else {
      ledgerWhere.push(`hp.paid_at >= date_trunc('month', CURRENT_DATE)`);
    }
    if (req.query.to) {
      ledgerParams.push(req.query.to);
      ledgerWhere.push(`hp.paid_at::date <= $${ledgerParams.length}::date`);
    }

    const ledger = await pool.query(
      `SELECT
         COALESCE(SUM(hp.amount), 0) AS paid,
         COALESCE(SUM(hp.amount) FILTER (WHERE hp.hub_payout_id IS NOT NULL), 0) AS paid_by_transfer,
         COALESCE(SUM(hp.amount) FILTER (WHERE hp.hub_payout_id IS NULL), 0) AS paid_by_hand,
         COUNT(DISTINCT COALESCE(hp.payment_batch_id, 'p:' || hp.id::text))::int AS payments,
         COUNT(DISTINCT pi.hub_id)::int AS hubs
       FROM hub_payments hp
       JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
       ${ledgerWhere.length ? `WHERE ${ledgerWhere.join(' AND ')}` : ''}`,
      ledgerParams);

    // ── Not money yet ───────────────────────────────────────────────────────
    //
    // Kept as its own figure and never folded into the one above. A transfer
    // that has been sent but not confirmed is not in the bank statement, and
    // including it makes the month fail to balance by exactly that amount —
    // for a reason that is invisible on the screen showing the total.
    const flightParams = [];
    const flightScope = hubScopeSql(req, flightParams, 'p.hub_id');
    const rest = await pool.query(
      `SELECT
         COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('created','queued','processing')), 0) AS in_flight,
         COUNT(*)      FILTER (WHERE p.status IN ('created','queued','processing'))::int AS in_flight_count,
         COUNT(*)      FILTER (WHERE p.status IN ('failed','reversed')
                                 AND p.updated_at >= CURRENT_DATE - INTERVAL '30 days')::int AS problems
       FROM hub_payouts p
       ${flightScope ? `WHERE ${flightScope}` : ''}`,
      flightParams);

    // Which hubs have work waiting and cannot be paid automatically. This is the
    // warning band, and it is the honest version of the screen: the alternative
    // is letting somebody press Pay and discover it then.
    const blockedParams = [];
    const blockedScope = hubScopeSql(req, blockedParams, 'h.id');
    const blocked = await pool.query(
      `SELECT h.id, h.hub_name, h.payout_status,
              (h.bank_account_number IS NULL OR h.bank_ifsc IS NULL
                OR h.account_holder_name IS NULL) AS missing_bank_details,
              COALESCE(SUM(pi.grand_total - COALESCE(pi.amount_paid,0)), 0) AS outstanding
         FROM hubs h
         JOIN purchase_invoices pi
           ON pi.hub_id = h.id AND pi.status = 'approved' AND pi.payment_status <> 'paid'
        WHERE h.deleted_at IS NULL
          AND (h.payout_fund_account_id IS NULL OR h.payout_status <> 'verified')
          ${blockedScope ? `AND ${blockedScope}` : ''}
        GROUP BY h.id, h.hub_name, h.payout_status,
                 h.bank_account_number, h.bank_ifsc, h.account_holder_name
        ORDER BY outstanding DESC`,
      blockedParams);

    res.json({
      due_now: Number(due.rows[0].amount),
      due_invoices: due.rows[0].invoices,
      due_hubs: due.rows[0].hubs,
      in_flight: Number(rest.rows[0].in_flight),
      in_flight_count: rest.rows[0].in_flight_count,
      // Named for what it is, not for a period: the caller chooses the window,
      // and calling it paid_this_month while it honours a from/to filter is how
      // a figure ends up meaning two different things on two screens.
      paid: Number(ledger.rows[0].paid),
      paid_by_transfer: Number(ledger.rows[0].paid_by_transfer),
      paid_by_hand: Number(ledger.rows[0].paid_by_hand),
      payments: ledger.rows[0].payments,
      paid_hubs: ledger.rows[0].hubs,
      problems: rest.rows[0].problems,
      blocked_hubs: blocked.rows.map(b => ({
        ...b,
        outstanding: Number(b.outstanding),
      })),
      gateway: payoutGatewayStatus(),
    });
  });
}

/**
 * POST /api/hub-payouts
 *
 * Body: { hub_id, lines: [{ purchase_invoice_id, amount }], notes }
 *
 * The amounts come from the client and are re-validated in the service against
 * the locked invoice rows. They are sent rather than derived server-side because
 * a partial payout is legitimate — a hub agreeing to take half now is a real
 * conversation — and the confirm dialog has to show exactly what will be sent.
 */
function createPayout(req, res, next) {
  handle(req, res, next, async () => {
    // A hub login must never be able to pay itself. Every other guard here is
    // about correctness; this one is about the fact that hub users authenticate
    // into this same application.
    if (req.user?.hub_id) {
      return res.status(403).json({ error: 'Payouts cannot be started from a hub login.' });
    }

    const data = z.object({
      hub_id: z.coerce.number().int().positive(),
      lines: z.array(z.object({
        purchase_invoice_id: z.coerce.number().int().positive(),
        amount: z.coerce.number().positive(),
      })).min(1).max(100),
      notes: z.string().trim().max(500).optional().nullable(),
    }).parse(req.body);

    const payout = await requestPayout({
      hubId: data.hub_id,
      lines: data.lines,
      userId: req.user?.id || null,
      notes: data.notes || null,
    });

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'hub_payout',
      entityId: payout.id,
      description:
        `Bank payout ${payout.payout_ref} started: ₹${Number(payout.amount).toFixed(2)} to hub ${data.hub_id} ` +
        `across ${data.lines.length} invoice(s) — ` +
        data.lines.map(l => `PI-${String(l.purchase_invoice_id).padStart(6, '0')} ₹${Number(l.amount).toFixed(2)}`).join(', ') +
        ` — status ${payout.status}`,
    });

    const full = await pool.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [payout.id]);
    res.status(201).json({ item: full.rows[0] });
  });
}

/**
 * POST /api/hub-payouts/:id/refresh
 *
 * Asks the provider what actually happened. Needed because money leaving has no
 * second channel — a missed webhook leaves a payout in flight for ever.
 */
function refresh(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const out = await refreshPayout(id);
    const full = await pool.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [id]);
    res.json({ item: full.rows[0], unchanged: out.unchanged === true });
  });
}

/** GET /api/hub-payouts/hubs/:hubId/readiness */
function readiness(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.hubId);
    res.json(await hubPayoutReadiness(hubId));
  });
}

/** POST /api/hub-payouts/hubs/:hubId/register */
function register(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.hubId);
    const out = await registerHubForPayouts(hubId, { userId: req.user?.id });

    if (!out.already) {
      logActivity({
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'UPDATE',
        entity: 'hub',
        entityId: hubId,
        description:
          `Hub registered for bank payouts — account ending ${out.account_last4 || '????'} (${out.ifsc || 'no IFSC'}). ` +
          `Every automatic payout to this hub now goes to that account.`,
      });
    }
    res.json(out);
  });
}

module.exports = { listPayouts, payoutSummary, exportPayouts, createPayout, refresh, readiness, register };
