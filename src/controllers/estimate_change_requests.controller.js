'use strict';

/**
 * estimate_change_requests.controller.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Reviewing a hub's proposed edit to an estimate: list, read, approve, reject.
 *
 * HOW APPROVAL APPLIES THE CHANGE
 * ───────────────────────────────
 * It calls the THREE handlers that already exist and are already trusted:
 *
 *     estimates.controller        updateEstimate
 *     purchase_invoices.controller syncPurchaseInvoiceFromEstimate
 *     customer_invoices.controller syncCustomerInvoiceFromEstimate
 *
 * — the same code the staff "Update Invoices" button runs today. It does NOT
 * reimplement the pricing. That is the single most important property of this
 * file: an approval and a manual staff sync must produce byte-identical
 * results, and the only way to guarantee that is for both to execute the same
 * function. A second implementation of "what does this estimate total" is how
 * an invoice comes to say one thing on one screen and another elsewhere, which
 * is the exact class of bug this whole feature exists to end.
 *
 * They are Express handlers, so `invoke` below drives them with a synthetic
 * request and captures their reply. That is unusual enough to deserve the
 * explanation: the alternative was extracting the body of three
 * money-handling functions into client-accepting cores in one pass, which is a
 * far larger change to far more dangerous code than this feature justifies.
 *
 * WHY THIS IS NOT ONE TRANSACTION
 * ───────────────────────────────
 * Each of the three opens its own. Welding them together needs that same
 * refactor. Instead, `preflight` asks — before anything is written — whether
 * every step CAN succeed: invoice present, not paid, estimate still there.
 * Those are the conditions the syncs actually refuse on, so after a clean
 * preflight there is nothing left to refuse.
 *
 * If one still fails, the request is marked 'failed' with the error rather than
 * 'approved', and the reviewer sees it needs attention with a Retry. That is a
 * visible, recorded, retryable inconsistency — against today's behaviour, where
 * the same divergence happens silently and stays for ever.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const {
  preflight, readTotals, inr, reviewerIds, notify, NOTIF_TYPE_DECIDED,
} = require('../services/estimateChangeRequests.service');
const { isHubUser } = require('../utils/hubScope');
const { logActivity } = require('../services/activityLog.service');
const { emitInvalidate } = require('../socket');

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    }
    if (err.code === '42P01' && /estimate_change_requests/i.test(err.message || '')) {
      console.error('[estimate-change-requests] missing table — migration 180 not applied:', err.message);
      return res.status(503).json({
        error: 'Database is behind the code: run `npm run db:migrate` in backend/ to apply migration 180.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

/**
 * Run an existing Express handler and get its result as a promise.
 *
 * `next` is wired to reject, so an unhandled throw inside the handler surfaces
 * here instead of vanishing. A >=400 reply also rejects, carrying the handler's
 * own error text — which is what the reviewer should read, because those
 * messages ("Cannot sync — Customer Invoice is already paid.") were written
 * for exactly this situation and are better than anything restated here.
 */
function invoke(fn, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { user, params, body, query, headers: {} };
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(payload) {
        if (code >= 400) {
          reject(Object.assign(new Error(payload?.error || `Failed with ${code}`), { status: code }));
        } else {
          resolve(payload);
        }
      },
    };
    try { fn(req, res, reject); } catch (err) { reject(err); }
  });
}

const LIST_SELECT = `
  SELECT r.*,
         e.public_token          AS estimate_token,
         h.hub_name,
         ru.name                 AS requested_by_name,
         du.name                 AS decided_by_name
    FROM estimate_change_requests r
    LEFT JOIN estimates e ON e.id = r.estimate_id
    LEFT JOIN hubs      h ON h.id = r.hub_id
    LEFT JOIN users    ru ON ru.id = r.requested_by
    LEFT JOIN users    du ON du.id = r.decided_by`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimate-change-requests?status=pending&estimate_id=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * A hub sees only its own requests; staff see everything.
 *
 * Scoped on hub_id from the SESSION, never from the query string — the same
 * override rule utils/hubScope.js states. A hub reading another hub's proposed
 * prices would be a pricing leak between competitors.
 */
function listChangeRequests(req, res, next) {
  handle(req, res, next, async () => {
    const q = z.object({
      status:      z.string().trim().max(20).optional(),
      estimate_id: z.coerce.number().int().positive().optional(),
      limit:       z.coerce.number().int().min(1).max(200).optional().default(100),
    }).parse(req.query || {});

    const params = [];
    const where  = [];

    if (isHubUser(req)) {
      params.push(req.user.hub_id);
      where.push(`r.hub_id = $${params.length}`);
    }
    if (q.status)      { params.push(q.status);      where.push(`r.status = $${params.length}`); }
    if (q.estimate_id) { params.push(q.estimate_id); where.push(`r.estimate_id = $${params.length}`); }

    params.push(q.limit);
    const r = await pool.query(
      `${LIST_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.requested_at DESC
       LIMIT $${params.length}`,
      params
    );

    /* The badge count the Estimates chip reads. Staff only — a hub cannot act
       on it, and a number it can never change is noise.

       The status set here is EXACTLY the one the chip filters on
       (listEstimates ?change_requested=1) and exactly the one the estimate row
       reports as change_request_id. Three places, one definition, because a
       badge that says 3 next to a filter that shows 2 is worse than no badge —
       the reader stops trusting the number and opens everything anyway. */
    const pending = isHubUser(req) ? null : await pool.query(
      `SELECT COUNT(*)::int AS n FROM estimate_change_requests
        WHERE status IN ('pending','applying','failed')`);

    res.json({ items: r.rows, pending_count: pending ? pending.rows[0].n : null });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimate-change-requests/:id
// ─────────────────────────────────────────────────────────────────────────────
/** One request, plus a LIVE preflight — so the reviewer is told about a paid
 *  invoice while reading, not after pressing Approve. */
function getChangeRequest(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query(`${LIST_SELECT} WHERE r.id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Change request not found' });

    if (isHubUser(req) && row.hub_id !== req.user.hub_id) {
      // 404 not 403 — the reasoning is in utils/hubScope.js assertHubOwns.
      return res.status(404).json({ error: 'Change request not found' });
    }

    const check = await preflight(pool, row.estimate_id);
    res.json({ item: row, current: check.totals, blockers: check.reasons });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimate-change-requests/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
function approveChangeRequest(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // Belt and braces alongside the route gate: a hub must never decide its own
    // request, and a hub login can legitimately hold EDIT_ESTIMATE. Checked on
    // the role, the same pattern syncPurchaseInvoiceFromEstimate uses.
    if (isHubUser(req)) {
      return res.status(403).json({ error: 'A change request can only be approved by Spinoto.' });
    }

    /* Claim the request before doing any work.
     *
     * A single UPDATE ... WHERE status IN ('pending','failed') is the claim:
     * exactly one caller can win it, because the row lock is taken by the
     * UPDATE itself. Two reviewers pressing Approve at the same instant would
     * otherwise both read 'pending', both pass the check, and both apply the
     * change — charging the discount twice.
     *
     * 'applying' is a real status in the CHECK constraint (migration 180), not
     * a write that quietly no-ops. A row still sitting in 'applying' means the
     * process died mid-apply, and that is worth being able to see. */
    const claim = await pool.query(
      `UPDATE estimate_change_requests
          SET status = 'applying', updated_at = NOW()
        WHERE id = $1 AND status IN ('pending','failed')
      RETURNING *`,
      [id]
    );
    const row = claim.rows[0];
    if (!row) {
      const cur = await pool.query(`SELECT status FROM estimate_change_requests WHERE id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'Change request not found' });
      return res.status(409).json({ error: `This request is already ${cur.rows[0].status}.` });
    }

    /** Hand the claim back if we bail out before applying anything. */
    const release = (status, note) => pool.query(
      `UPDATE estimate_change_requests SET status = $1, decision_note = COALESCE($2, decision_note), updated_at = NOW() WHERE id = $3`,
      [status, note || null, id]
    ).catch(() => {});

    const check = await preflight(pool, row.estimate_id);
    if (!check.ok) {
      // Nothing was written, so the request goes back to pending — a paid
      // invoice is a reason to decide differently, not a reason to lose the
      // hub's request.
      await release('pending');
      return res.status(409).json({ error: check.reasons.join(' '), blockers: check.reasons });
    }

    const before = check.totals;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

    // ── Apply. Estimate first, then the invoices derived from it. ───────────
    const { updateEstimate } = require('./estimates.controller');
    const { syncPurchaseInvoiceFromEstimate } = require('./purchase_invoices.controller');
    const { syncCustomerInvoiceFromEstimate } = require('./customer_invoices.controller');

    const done = [];
    try {
      /* req.user is the REVIEWER — a Spinoto session, never a hub. That is
       * what stops the replay looping back into the queue: updateEstimate's
       * hub branch tests the session, not a flag in the body, so there is no
       * "already approved" token for a hub to forge. */
      await invoke(updateEstimate, {
        user: req.user,
        params: { id: String(row.estimate_id) },
        body: payload,
      });
      done.push('estimate');

      if (before.pi_id) {
        await invoke(syncPurchaseInvoiceFromEstimate, {
          user: req.user, params: { id: String(before.pi_id) },
        });
        done.push('purchase_invoice');
      }
      if (before.ci_id) {
        await invoke(syncCustomerInvoiceFromEstimate, {
          user: req.user, params: { id: String(before.ci_id) },
        });
        done.push('customer_invoice');
      }
    } catch (err) {
      // Recorded, not swallowed. 'failed' keeps the request visible and
      // retryable rather than leaving a half-applied change nobody can see —
      // which is precisely the state this feature exists to abolish.
      await pool.query(
        `UPDATE estimate_change_requests
            SET status = 'failed', decision_note = $1, updated_at = NOW() WHERE id = $2`,
        [`Applied: ${done.join(', ') || 'nothing'}. Then failed: ${err.message}`, id]
      );
      return res.status(500).json({
        error: `Applied ${done.join(', ') || 'nothing'}, then failed: ${err.message}`,
        applied: done,
        retryable: true,
      });
    }

    const after = await readTotals(pool, row.estimate_id);

    await pool.query(
      `UPDATE estimate_change_requests
          SET status = 'approved', decided_by = $1, decided_at = NOW(),
              after_totals = $2, updated_at = NOW()
        WHERE id = $3`,
      [req.user.id, JSON.stringify({
        estimate: Number(after?.estimate_total || 0),
        customer_invoice: after?.ci_id ? { id: after.ci_id, total: Number(after.ci_total || 0) } : null,
        purchase_invoice: after?.pi_id ? { id: after.pi_id, total: Number(after.pi_total || 0) } : null,
      }), id]
    );

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'estimate_change_approved', entity: 'estimate', entityId: row.estimate_id,
      description: `Approved hub change request #${id}: ${row.summary}. Updated ${done.join(', ')}.`,
    });

    await notifyHub(row, true, null, req.user);
    emitInvalidate('estimates', req);
    emitInvalidate('customer_invoices', req);
    emitInvalidate('purchase_invoices', req);

    res.json({ ok: true, applied: done, totals: after });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimate-change-requests/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
function rejectChangeRequest(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    if (isHubUser(req)) {
      return res.status(403).json({ error: 'A change request can only be decided by Spinoto.' });
    }
    const body = z.object({
      // Required, not optional. The reason IS the message the hub receives —
      // a rejection with no reason just restarts the conversation by phone,
      // which is the thing this feature removes.
      reason: z.string().trim().min(3, 'Give the hub a reason.').max(1000),
    }).parse(req.body || {});

    const r = await pool.query(
      `UPDATE estimate_change_requests
          SET status = 'rejected', decided_by = $1, decided_at = NOW(),
              decision_note = $2, updated_at = NOW()
        WHERE id = $3 AND status IN ('pending','failed')
      RETURNING *`,
      [req.user.id, body.reason, id]
    );
    if (!r.rows[0]) {
      return res.status(409).json({ error: 'That request is no longer pending.' });
    }

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'estimate_change_rejected', entity: 'estimate', entityId: r.rows[0].estimate_id,
      description: `Rejected hub change request #${id}: ${r.rows[0].summary}. Reason: ${body.reason}`,
    });

    await notifyHub(r.rows[0], false, body.reason, req.user);
    emitInvalidate('estimates', req);

    res.json({ ok: true, item: r.rows[0] });
  });
}

/** Tell the hub what was decided — and, on a rejection, why. */
async function notifyHub(row, approved, reason, decider) {
  try {
    const users = await pool.query(
      `SELECT id FROM users WHERE hub_id = $1 AND is_active = TRUE`, [row.hub_id]);
    const ids = users.rows.map(u => u.id);
    if (!ids.length) return;

    const est = `EST-${String(row.estimate_id).padStart(6, '0')}`;
    const title = approved
      ? `✅ ${est} change approved`
      : `❌ ${est} change not approved`;
    const body = [
      row.summary,
      approved ? 'The estimate and its invoices have been updated.' : null,
      reason ? `— "${String(reason).slice(0, 160)}"` : null,
    ].filter(Boolean).join(' · ');

    await notify(pool, ids, NOTIF_TYPE_DECIDED, title, body, '/estimates');
  } catch (err) {
    console.error('[estimate-change-requests] hub notify failed:', err.message);
  }
}

module.exports = {
  listChangeRequests,
  getChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
};
