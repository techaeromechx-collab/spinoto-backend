'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { fireWhatsAppEvent, fireWhatsAppEventDetached } = require('../services/whatsappAutomations.service');
const { getRoundingFunction } = require('../utils/math');
// syncPayoutDueDate is no longer required here: it moved inside
// recalcInvoiceState along with the status recalculation it belongs to, so
// every path that changes what an invoice has been paid re-anchors the hub
// payout automatically instead of each caller remembering to.
// readInvoiceBalance comes along too: the manual payment path used to size a
// payment against customer_invoices.amount_paid, which is a CACHE of the
// ledger. The gateway path has always read the ledger itself. Now both do.
const { recalcInvoiceState, readInvoiceBalance } = require('../services/invoiceBalance.service');
const { autoApplyForInvoice } = require('../services/advances.service');
const { generatePublicToken, resolveTokenToId } = require('../utils/publicToken');
const { resolveClaimForEstimate, unresolveClaimForEstimate } = require('./warranty_claims.controller');
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
const { validateInvoiceDate, validationError, istToday, toIstDate } = require('../utils/invoiceDate');
const { warrantyImpact, WARRANTY_ITEMS_SQL } = require('../utils/warrantyPreflight');
const { logActivity } = require('../services/activityLog.service');
const { buildSearchSql } = require('../utils/listSearch');
const { hubScopeSql, assertHubOwns } = require('../utils/hubScope');
const { maskMobile } = require('../utils/maskMobile');
const { isHubUser } = require('../utils/hubScope');
const maskFor = (req, v) => (isHubUser(req) ? maskMobile(v) : (v || ''));

// What the customer-invoice search box looks at. Declared once so the list and
// the CSV export cannot drift — they were already two copies of the same line,
// and an export that disagrees with the list it was exported from is worse than
// no export at all.
//
// 'ci' and 'inv' both accepted: the PDF says CI-000048, people say "invoice 48".
const CI_SEARCH = {
  textColumns: ['ci.customer_name', 'ci.mobile', 'ci.vehicle_number'],
  idColumn: 'ci.id',
  idPrefixes: ['ci', 'inv', 'invoice'],
};

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.status) return res.status(err.status).json({ error: err.message });
    // Postgres 42703 = undefined_column. Migrations 099 and 100 added
    // invoice_date and the backdating columns; until they're applied, every
    // endpoint here fails with a bare 500 that looks like a code fault rather
    // than a pending migration. Naming it is worth the four lines.
    if (err.code === '42703' && /invoice_date|backdat|original_invoice_date|updated_by/i.test(err.message || '')) {
      console.error('[customer_invoices] missing column — migrations not applied:', err.message);
      return res.status(503).json({
        error: 'Database is behind the code: the invoice-date columns are missing. ' +
               'Run `npm run db:migrate` in backend/ to apply migrations 099 and 100.',
        code: 'MIGRATION_PENDING',
        detail: err.message,
      });
    }
    next(err);
  });
}

const CI_SELECT = `
  SELECT
    ci.id, ci.public_token, ci.purchase_invoice_id, ci.estimate_id, est_ctx.public_token AS estimate_token, ci.appointment_id, ci.hub_id,
    est_ctx.warranty_claim_id,
    (SELECT wc.claim_code FROM warranty_claims wc WHERE wc.id = est_ctx.warranty_claim_id) AS warranty_claim_code,
    -- Fall back to appointment data if CI columns were stored as null
    COALESCE(ci.customer_name, a.customer_name) AS customer_name,
    COALESCE(ci.mobile,        a.mobile)        AS mobile,
    (SELECT public_token FROM customer_identities WHERE mobile = COALESCE(ci.mobile, a.mobile)) AS customer_token,
    COALESCE(ci.vehicle_number, a.vehicle_number) AS vehicle_number,
    -- Pickup logistics, printed under BILL TO when the job was a pickup.
    -- Sourced from the appointment: a customer invoice has no address of its
    -- own, and the pickup point is a property of the job, not the customer.
    a.pickup_required, a.pickup_address_line1, a.pickup_address_line2,
    a.pickup_city, a.pickup_pincode,
    ci.status, ci.subtotal_ex_gst, ci.total_gst, ci.grand_total, ci.amount_paid,
    ci.notes, ci.odometer_km, ci.created_at, ci.updated_at,
    -- invoice_date is the LEGAL date of the document (migration 099); it is
    -- what the customer, the reports and the printed invoice see. created_at
    -- stays alongside it as the system record of when the row was made, and
    -- is what the rounding cutover in utils/math.js keys off. Do not conflate
    -- the two.
    --
    -- ::text is deliberate. pg-types 2.x parses a DATE into a JS Date at
    -- LOCAL midnight, so on an IST server toISOString().slice(0,10) returns
    -- the PREVIOUS day — the same UTC/IST boundary bug utils/payoutSchedule.js
    -- was already bitten by. Casting to text hands JS a plain 'YYYY-MM-DD'
    -- string with no timezone to misinterpret. Filtering and ORDER BY below
    -- still use the real DATE column, so index use and ordering are unaffected.
    ci.invoice_date::text AS invoice_date,
    -- Optional header fields surfaced by invoice_config's header_fields
    -- toggles (migration 096). vehicle_number is already selected above.
    ci.po_number, ci.eway_bill_number, ci.custom_fields,
    -- Drives intra- vs inter-state tax (CGST/SGST vs IGST). NULL = derive it
    -- (B2B GSTIN state code, else the supplier's own state).
    ci.place_of_supply_code, ci.place_of_supply_name,
    ci.discount_mode, ci.transaction_discount_type,
    ci.transaction_discount_value, ci.transaction_discount_amount,
    ci.is_b2b, ci.b2b_company_name, ci.b2b_gst_number, ci.b2b_address,
    ('Spinoto ' || ar.name) AS hub_name, h.hub_name AS hub_full_name, h.gst_number AS hub_gst,
    (ci.grand_total - ci.amount_paid) AS balance,
    (SELECT COUNT(*)::int FROM invoice_payment_lines cip WHERE cip.customer_invoice_id = ci.id) AS payment_count,
    (SELECT pi.id FROM purchase_invoices pi WHERE pi.estimate_id = ci.estimate_id LIMIT 1) AS linked_purchase_invoice_id,
    (SELECT pi.public_token FROM purchase_invoices pi WHERE pi.estimate_id = ci.estimate_id LIMIT 1) AS linked_purchase_invoice_token,
    -- Must ask the SAME question as _hubPaidFor(), which is what actually
    -- refuses the delete. The UI reads this to decide whether to warn before
    -- deleting a payment; when it matched on estimate_id alone and the guard
    -- matched on both links, an invoice joined through purchase_invoice_id got
    -- no warning and then a 409 it had given the user no reason to expect.
    -- (linked_purchase_invoice_id/_token above stay estimate-scoped on purpose:
    --  they answer "which PI document", not "has the hub been paid".)
    (SELECT COALESCE(MAX(pi.amount_paid), 0) FROM purchase_invoices pi
      WHERE pi.id = ci.purchase_invoice_id OR pi.estimate_id = ci.estimate_id) AS linked_pi_amount_paid,

    -- How much of amount_paid arrived BEFORE this invoice existed.
    --
    -- Not an addition to what was paid — a slice of it. The printed invoice
    -- splits its Paid row into this and the remainder; adding it on top would
    -- count the same money twice. See documentAdapter.fromCustomerInvoice.
    --
    -- Read from the allocations, not from the payment's own amount: an advance
    -- of ₹2,000 split ₹1,500 here and ₹500 elsewhere has contributed ₹1,500 to
    -- THIS invoice, and that is the figure that belongs on it.
    (SELECT COALESCE(SUM(a.amount), 0)
       FROM payment_allocations a
       JOIN customer_invoice_payments p ON p.id = a.ledger_payment_id
      WHERE a.customer_invoice_id = ci.id
        AND p.payment_type = 'advance') AS advance_applied,

    -- The receipt voucher numbers behind that figure, so the invoice and the
    -- vouchers can be matched to each other without a person doing it by hand.
    (SELECT string_agg(DISTINCT p.voucher_no, ', ' ORDER BY p.voucher_no)
       FROM payment_allocations a
       JOIN customer_invoice_payments p ON p.id = a.ledger_payment_id
      WHERE a.customer_invoice_id = ci.id
        AND p.payment_type = 'advance'
        AND p.voucher_no IS NOT NULL) AS advance_vouchers,

    -- Vehicle details — from the linked appointment when present, otherwise
    -- (standalone estimate, no appointment) from the linked estimate's own
    -- vehicle columns.
    vt.name   AS vehicle_type_name,
    vm.name   AS make_name,
    vmod.name AS model_name,
    bt.name   AS body_type_name,
    cc.name   AS cc_category_name,
    cc.min_cc,
    cc.max_cc,
    vmod.engine_cc,
    (SELECT string_agg(sg.name, ', ') FROM segments sg WHERE sg.id = ANY(COALESCE(a.segment_ids, est_ctx.segment_ids))) AS segment_names

  FROM customer_invoices ci
  LEFT JOIN hubs           h    ON h.id    = ci.hub_id
  LEFT JOIN areas          ar   ON ar.id   = h.area_id
  LEFT JOIN appointments   a    ON a.id    = ci.appointment_id
  LEFT JOIN estimates      est_ctx ON est_ctx.id = ci.estimate_id
  LEFT JOIN vehicle_types  vt   ON vt.id   = COALESCE(a.vehicle_type_id, est_ctx.vehicle_type_id)
  LEFT JOIN vehicle_makes  vm   ON vm.id   = COALESCE(a.make_id, est_ctx.make_id)
  LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, est_ctx.model_id)
  LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, est_ctx.body_type_id)
  LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, est_ctx.cc_category_id)
`;

async function _getItems(ciId) {
  const r = await pool.query(
    `SELECT cii.id, cii.estimate_item_id, cii.item_type, cii.description, cii.quantity,
            cii.customer_rate, cii.gst_percent, cii.gst_amount, cii.total_inc_gst, cii.hsn_sac,
            cii.discount_type, cii.discount_value, cii.discount_amount,
            cii.warranty_months, cii.warranty_days, cii.warranty_km, cii.warranty_text,
            cii.guarantee_months, cii.guarantee_days, cii.guarantee_km, cii.guarantee_text,
            -- Optional line-item fields surfaced by invoice_config's item_columns
            -- toggles (migration 096). Always selected; the templates decide
            -- whether to render them.
            cii.item_description, cii.batch_no, cii.exp_date, cii.mfg_date,
            cii.is_free, cii.custom_values,
            wc.id AS claim_id, wc.claim_code, wc.status AS claim_status, wc.claim_type
     FROM customer_invoice_items cii
     LEFT JOIN LATERAL (
       SELECT id, claim_code, status, claim_type FROM warranty_claims
       WHERE customer_invoice_item_id = cii.id
       ORDER BY id DESC LIMIT 1
     ) wc ON TRUE
     WHERE cii.customer_invoice_id = $1 ORDER BY cii.id`,
    [ciId]
  );
  return r.rows;
}

async function _getPayments(ciId) {
  const r = await pool.query(
    // `source` and `txn_ref` are returned so the invoice screen can tell the
    // two kinds of payment apart. A gateway row cannot be edited or deleted
    // from here (see the payment handlers below), and a delete button that
    // only ever produces a 409 is worse than no button — the customer's money
    // is not in doubt, so the UI should say "refund" rather than offer an
    // action that will be refused.
    //
    // This view has no plain id column — it would be ambiguous between the
    // allocation and the payment behind it, so migration 134 named the two
    // apart. This asked for cip.id and failed at runtime with "column cip.id
    // does not exist". It wants the LEDGER row's id, because that is what the
    // edit and delete handlers below take.
    //
    // payment_type and voucher_no (migration 138) are returned so the screen can
    // render an applied advance as what it is. An advance's customer_invoice_id
    // is NULL — the money was taken against the estimate, before this invoice
    // existed — so the edit and delete handlers will not find it, and a pencil
    // that always 404s is worse than no pencil.
    `SELECT cip.payment_id AS id, cip.amount, cip.method, cip.reference_no,
            cip.paid_at, cip.notes, cip.source, cip.payment_type, cip.voucher_no,
            cip.payment_amount, pt.txn_ref,
            u.name AS created_by_name
     FROM invoice_payment_lines cip
     LEFT JOIN users u ON u.id = cip.created_by
     LEFT JOIN payment_transactions pt ON pt.id = cip.payment_transaction_id
     WHERE cip.customer_invoice_id = $1 ORDER BY cip.paid_at ASC`,
    [ciId]
  );
  return r.rows;
}

// Moved to services/invoiceBalance.service.js when gateway payments were added.
//
// It is the single place that decides an invoice's amount_paid and status, and
// it is now called from three directions — manual payments here, verified
// gateway captures in payments.service.js, and refunds. A second copy of this
// logic is how an invoice ends up PAID on one screen and PARTIALLY PAID on
// another, so the function moved rather than being duplicated.
//
// Behaviour is unchanged for every existing caller: the only difference is that
// processed refunds are now subtracted, and with no refunds in the system that
// is the same arithmetic it always did. The alias keeps the ~6 call sites in
// this file reading exactly as they did.
const _recalcStatus = recalcInvoiceState;

/**
 * Hub tenancy guard for the customer-invoice handlers whose own SELECT does not
 * already carry hub_id. One extra round trip, only on hub-portal requests.
 * Throws 404 (not 403) so ids can't be enumerated by status code.
 */
async function _assertCiHub(req, id, db = pool) {
  if (!req.user?.hub_id) return;
  const r = await db.query(`SELECT hub_id FROM customer_invoices WHERE id = $1`, [id]);
  assertHubOwns(req, r.rows[0], 'hub_id', 'Customer invoice');
}

function listCustomerInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const conditions = [], params = [];

    // ── User scoping ──────────────────────────────────────────────────────────
    // Hub-portal logins are pinned to their own hub, checked BEFORE the
    // permission tiers so granting one VIEW_INVOICE widens them within their
    // hub rather than across every hub.
    // Then: super admins and VIEW_INVOICE users see all; everyone else sees
    // only invoices raised from estimates they created.
    const hubScope = hubScopeSql(req, params, 'ci.hub_id');
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_INVOICE');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (!isAll) {
      params.push(req.user.id);
      conditions.push(
        `EXISTS (SELECT 1 FROM estimates e WHERE e.id = ci.estimate_id AND e.created_by = $${params.length})`
      );
    }

    const searchSql = buildSearchSql({ search: req.query.search, params, ...CI_SEARCH });
    if (searchSql) conditions.push(searchSql);
    // Skipped for hub logins — hubScope already pinned the hub above.
    if (!hubScope && req.query.hub_ids) {
      const ids = req.query.hub_ids.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`ci.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`ci.hub_id = $${params.length}`);
    }
    if (req.query.status) { params.push(req.query.status);         conditions.push(`ci.status = $${params.length}`); }
    if (req.query.vehicle_type) {
      // Match either via the linked appointment's vehicle type, or (for CIs
      // whose estimate was standalone, no appointment) the linked estimate's
      // own vehicle_type_id column.
      if (req.query.vehicle_type === '2W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = ci.appointment_id AND vt.name ILIKE '%2%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = ci.estimate_id AND vt.name ILIKE '%2%')
        )`);
      } else if (req.query.vehicle_type === '4W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = ci.appointment_id AND vt.name ILIKE '%4%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = ci.estimate_id AND vt.name ILIKE '%4%')
        )`);
      }
    }
    // Invoice-date range filter — inclusive on both ends. Now that
    // invoice_date is a DATE rather than a TIMESTAMPTZ, this is a plain
    // BETWEEN; the old `< to + INTERVAL '1 day'` trick existed only to reach
    // the end of the day on a timestamp column and is no longer needed.
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`ci.invoice_date >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`ci.invoice_date <= $${params.length}::date`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [dataRes, countRes] = await Promise.all([
      // The id tiebreaker matters: many invoices share a date, and without it
      // OFFSET pagination can repeat and skip rows between pages.
      pool.query(`${CI_SELECT} ${where} ORDER BY ci.invoice_date DESC, ci.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      // The sums ride along on the count query rather than running as a third
      // statement: it already scans exactly the rows the filters select, so the
      // totals cost nothing beyond three aggregates over a scan we were doing
      // anyway. Crucially they are computed HERE and not from `items` — the
      // page only holds `limit` rows, so summing client-side would report a
      // different figure at 10/page than at 100/page.
      pool.query(
        `SELECT COUNT(*)                                AS count,
                COALESCE(SUM(ci.grand_total), 0)        AS sum_total,
                COALESCE(SUM(ci.amount_paid), 0)        AS sum_paid,
                COALESCE(SUM(GREATEST(ci.grand_total - ci.amount_paid, 0)), 0) AS sum_due
           FROM customer_invoices ci ${where}`,
        params
      ),
    ]);
    const c = countRes.rows[0];
    res.json({
      items: dataRes.rows,
      total: parseInt(c.count, 10),
      // `due` is SUM(GREATEST(...)) in SQL — clamped PER INVOICE, then summed.
      // Both the obvious alternatives are wrong:
      //   SUM(grand_total - amount_paid)  — one customer's ₹200 overpayment
      //     silently cancels ₹200 another customer still owes.
      //   MAX(0, SUM(total) - SUM(paid))  — same netting, just hidden one level
      //     up; it only shows as zero once the credits exceed the debts.
      // Per-row clamping is the only version that answers "how much are we
      // actually waiting on".
      totals: {
        amount: parseFloat(c.sum_total),
        paid:   parseFloat(c.sum_paid),
        due:    parseFloat(c.sum_due),
      },
      page, limit,
    });
  });
}

function getCustomerInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    const item = r.rows[0];
    // Scoping the list is not enough — without this a hub login could read any
    // invoice by walking ids, and CI_SELECT carries the linked purchase-invoice
    // fields, i.e. another hub's payout and this job's margin. 404 rather than
    // 403 so the status code isn't an existence oracle. Covers /by-token/:token,
    // which resolves the token then delegates here.
    assertHubOwns(req, item, 'hub_id', 'Customer invoice');
    item.items    = await _getItems(id);
    item.payments = await _getPayments(id);
    await _attachCustomerCredit(item);
    res.json({ item });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/by-token/:token — resolves a public_token
// (used in shareable /customer-invoices/:token URLs) to the numeric id,
// then delegates to the exact same logic as GET /api/customer-invoices/:id.
// ─────────────────────────────────────────────────────────────────────────────
function getCustomerInvoiceByToken(req, res, next) {
  handle(req, res, next, async () => {
    const id = await resolveTokenToId(pool, 'customer_invoices', req.params.token);
    if (!id) return res.status(404).json({ error: 'Customer invoice not found' });
    req.params.id = String(id);
    return getCustomerInvoice(req, res, next);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional render-time enrichments.
//
// Both are driven by invoice_config flags and both need queries, so they're
// done here rather than in the (synchronous, pure) theme templates. Each is
// skipped entirely when its flag is off — no wasted queries on the common path.
// ─────────────────────────────────────────────────────────────────────────────

// Prior prices this customer paid for the same item, most recent first.
// Matched on mobile + item description, since there's no stable catalogue id on
// an invoice line. Excludes the invoice being printed.
async function _attachPriceHistory(invoice, limitPerItem = 2) {
  if (!invoice.mobile || !invoice.items?.length) return;
  const descriptions = [...new Set(invoice.items.map(i => i.description).filter(Boolean))];
  if (!descriptions.length) return;

  const r = await pool.query(
    // Ordered and labelled by invoice_date, not created_at: this is shown to
    // the customer as "what you paid last time", so it must follow the date
    // printed on those invoices rather than when the rows happened to be keyed in.
    `SELECT cii.description, cii.customer_rate AS rate, ci.invoice_date::text AS date
     FROM customer_invoice_items cii
     JOIN customer_invoices ci ON ci.id = cii.customer_invoice_id
     WHERE ci.mobile = $1 AND ci.id <> $2 AND cii.description = ANY($3::text[])
     ORDER BY ci.invoice_date DESC, ci.id DESC`,
    [invoice.mobile, invoice.id, descriptions]
  );

  const byDesc = new Map();
  for (const row of r.rows) {
    const list = byDesc.get(row.description) || [];
    if (list.length < limitPerItem) { list.push({ rate: row.rate, date: row.date }); byDesc.set(row.description, list); }
  }
  for (const it of invoice.items) it.price_history = byDesc.get(it.description) || [];
}

/**
 * Money this customer has already paid that is sitting on no invoice.
 *
 * ── WHY THE INVOICE HAS TO ASK ──────────────────────────────────────────────
 * An advance taken against an estimate applies ITSELF when the invoice is
 * generated — one estimate has one possible invoice, so there is no decision to
 * make. Money taken on account has no such destination, so it waits.
 *
 * Waiting is fine. Waiting UNSEEN is not: the customer paid, gets billed the
 * full amount, and the money they handed over sits in a list nobody opened.
 * That is precisely the failure this whole feature was built to prevent, and
 * on-account credit would quietly reintroduce it.
 *
 * So the invoice asks on every read, and the screen offers to apply it.
 *
 * Skipped once the invoice is settled — credit is only interesting where there
 * is a balance for it to meet — and never computed for a cancelled one.
 */
async function _attachCustomerCredit(invoice) {
  invoice.customer_credit = 0;
  if (!invoice.mobile || invoice.status === 'cancelled') return;
  if (Number(invoice.balance) <= 0.01) return;

  const r = await pool.query(
    // Less what has been applied AND less what has been given back. A refunded
    // balance is not credit, and offering it here would put money the customer
    // already has back on the screen as spendable.
    `SELECT COALESCE(SUM(
              p.amount
                - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                             WHERE a.ledger_payment_id = p.id), 0)
                - COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                             WHERE rf.ledger_payment_id = p.id
                               AND rf.status IN ('pending', 'processed')), 0)
            ), 0) AS credit
       FROM customer_invoice_payments p
      WHERE p.mobile = $1`,
    [invoice.mobile]
  );
  invoice.customer_credit = Number(r.rows[0]?.credit || 0);
}

// Total outstanding across ALL of this customer's invoices — deliberately
// different from invoice.balance, which is this one invoice's own balance.
async function _attachPartyBalance(invoice) {
  if (!invoice.mobile) return;
  const r = await pool.query(
    `SELECT COALESCE(SUM(grand_total - amount_paid), 0) AS outstanding
     FROM customer_invoices
     WHERE mobile = $1 AND status <> 'cancelled'`,
    [invoice.mobile]
  );
  invoice.party_balance = Number(r.rows[0]?.outstanding || 0);
}

// Company + config loading now lives in utils/renderDocument.js, shared by all
// three document types (estimate / customer invoice / purchase invoice).

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/:id/pdf?theme=xxx&share=1
//
// Renders the invoice as a themed PDF via Puppeteer (see utils/pdf.js).
// Theme precedence, highest first:
//   1. ?theme=          — explicit override, used by the settings live preview
//   2. ?share=1 + the auto_share_theme flag — the "Auto-apply theme for
//      sharing" setting, so an invoice sent to a customer can use a nicer
//      theme than the one used for in-house printing
//   3. company_settings.invoice_theme — the saved default
//   4. 'simple'         — final fallback
// ─────────────────────────────────────────────────────────────────────────────
function getCustomerInvoicePdf(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    const invoice = r.rows[0];
    assertHubOwns(req, invoice, 'hub_id', 'Customer invoice');
    invoice.items    = await _getItems(id);
    invoice.payments = await _getPayments(id);

    const company = await loadCompany();
    const { cfg, theme } = resolveRender(company, 'customer_invoice', req.user, {
      themeOverride: req.query.theme,
      share: req.query.share === '1' || req.query.share === 'true',
    });

    if (cfg.flags.price_history)      await _attachPriceHistory(invoice);
    if (cfg.flags.show_party_balance) await _attachPartyBalance(invoice);

    await sendPdf(res, {
      docType: 'customer_invoice', row: invoice, company, cfg, theme,
      baseUrl: req.get('origin') || req.get('referer'),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments against a customer invoice.
//
// THIS IS THE MONEY LEDGER, AND IT IS SHARED
// ──────────────────────────────────────────
// customer_invoice_payments holds BOTH the manual payments recorded here and
// the gateway payments captured in services/payments.service.js. Around a dozen
// other features read it: hub payout scheduling, warranty preflight, the
// payouts list, the public invoice PDF, the appointment and estimate deletion
// guards, the invoice-backdating floor and the invoice list.
//
// Two rules follow, and neither was enforced before:
//
//   1. A GATEWAY ROW IS NOT EDITABLE OR DELETABLE FROM HERE. It is money a bank
//      confirmed, with a payment_transactions row pointing at it. Deleting one
//      left that transaction stranded at 'captured' with no ledger row behind
//      it — the two-sources-of-truth state migration 122 exists to prevent —
//      and contradicted migration 124, which states plainly that gateway money
//      is append-only and reversed by refund.
//
//   2. EVERY MUTATION IS LOGGED. A payment is the thing in this system someone
//      is most likely to be asked to account for later, and a DELETE destroys
//      the only evidence it ever existed: created_by and created_at go with the
//      row. The log entry carries the amount, method and reference so the
//      question "who removed a ₹1,996 cash payment, and when" has an answer.
// ─────────────────────────────────────────────────────────────────────────────

/** 400/404/409 that handle() turns into a clean response instead of a 500. */
function payErr(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/**
 * How much the hub has already been paid for the job behind this invoice.
 *
 * ONE query, used by both the edit guard and the delete guard. They had
 * drifted: edit matched a purchase invoice on `ci.purchase_invoice_id` OR
 * `ci.estimate_id`, delete on `estimate_id` alone. So an invoice linked only
 * through purchase_invoice_id was frozen against having its payment date
 * moved, and NOT frozen against having the payment deleted outright — the
 * narrower guard sitting on the more destructive operation. The broader match
 * is the correct one for both.
 *
 * NULL = NULL is not true in SQL, so an invoice with neither link matches
 * nothing and returns 0, which is the right answer: no PI, no payout.
 */
async function _hubPaidFor(db, ciId) {
  const r = await db.query(
    `SELECT COALESCE(MAX(pi.amount_paid), 0) AS hub_paid
       FROM purchase_invoices pi
       JOIN customer_invoices ci ON ci.id = $1
      WHERE pi.id = ci.purchase_invoice_id
         OR pi.estimate_id = ci.estimate_id`,
    [ciId]
  );
  return Number(r.rows[0]?.hub_paid || 0);
}

/**
 * A payment date the database can actually store.
 *
 * This was a bare z.string() interpolated into a ::timestamptz cast, so
 * "yesterday" reached Postgres and came back as a 22007 — surfacing as a 500
 * that reads like a server fault rather than a typo in a form.
 *
 * A future date is refused rather than clamped. paid_at is the anchor for the
 * hub payout schedule (utils/payoutSchedule.js reads MAX(paid_at)), so a year
 * typed wrong pushes a real payout to a real hub out by that much, silently.
 */
const paidAtSchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, 'paid_at must be a date (YYYY-MM-DD)')
  .refine(v => !Number.isNaN(new Date(v).getTime()), 'paid_at is not a real date')
  .refine(v => v.slice(0, 10) <= istToday(), 'paid_at cannot be in the future')
  .optional().nullable();

function addPayment(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = z.object({
      amount:       z.coerce.number().positive(),
      method:       z.enum(['cash','upi','card','bank_transfer','other','app_payment']).default('cash'),
      reference_no: z.string().trim().max(100).optional().nullable(),
      paid_at:      paidAtSchema,
      notes:        z.string().trim().max(500).optional().nullable(),
    }).parse(req.body);

    await _assertCiHub(req, id);

    const client = await pool.connect();
    let recalcResult, payId, balanceBefore;
    try {
      await client.query('BEGIN');

      // The lock comes FIRST, and the balance is read from the LEDGER.
      //
      // Both halves matter, and neither was here before. Without the row lock,
      // two tills recording against the same invoice at the same moment both
      // read the same amount_paid, both decide there is room, and the invoice
      // quietly ends up overpaid with no error raised anywhere. And
      // customer_invoices.amount_paid is a CACHE of the ledger — the
      // authoritative balance is SUM(payments) − SUM(processed refunds), which
      // is exactly what the customer would be charged if they paid online in
      // the same second. The gateway path has always worked this way; this is
      // the manual path catching up.
      const lock = await client.query(
        `SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE`, [id]);
      if (!lock.rows[0]) throw payErr(404, 'Customer invoice not found');

      const inv = await readInvoiceBalance(client, id);
      if (['paid', 'cancelled'].includes(inv.status)) {
        throw payErr(400, `Cannot add payment to a ${inv.status} invoice`);
      }

      balanceBefore = inv.balance;
      if (data.amount > inv.balance + 0.01) {
        throw payErr(400,
          `Payment amount ₹${data.amount} exceeds outstanding balance ₹${inv.balance.toFixed(2)}`);
      }

      // hub_id is copied from the invoice AT THE MOMENT OF PAYMENT, not joined
      // at read time. Re-assigning an invoice to a different hub later must not
      // move money already collected, or the payout scheduled from it — see the
      // header of migration 131.
      //
      // ── mobile AND vehicle_number ARE NOT OPTIONAL ───────────────────────
      // They were missing from this INSERT, and the effect was silent. The
      // customer Payments tab finds money with `WHERE p.mobile = $1`
      // (payments.controller.listForCustomer), and NULL matches no number — so
      // every payment recorded here was invisible on the customer's own screen
      // while being perfectly correct on the invoice.
      //
      // It looked half-working rather than broken, because migration 135
      // backfilled these columns once from the invoice. Payments taken before
      // that migration appeared; every one taken after it did not, and nothing
      // anywhere reported a problem.
      //
      // Both values are already in hand: readInvoiceBalance COALESCEs the
      // invoice's own copies with the appointment's, which is the same source
      // migration 135's backfill used.
      const ins = await client.query(
        `INSERT INTO customer_invoice_payments (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by, hub_id, mobile, vehicle_number)
         VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()),$6,$7,$8,$9,$10)
         RETURNING id`,
        [id, data.amount, data.method, data.reference_no||null, data.paid_at||null, data.notes||null, req.user?.id||null,
         inv.hub_id || null, inv.mobile || null, inv.vehicle_number || null]
      );
      payId = ins.rows[0].id;

      // The allocation, in the SAME transaction as the payment.
      //
      // A payment recorded here is money handed over against a specific
      // invoice, so it is fully applied to that invoice immediately — the two
      // rows are one act and neither is meaningful alone. A payment with no
      // allocation is credit (money we are holding), which is a real state
      // from Phase 2 onward but is never what this handler produces.
      //
      // recalcInvoiceState reads allocations, so writing this after it would
      // recalculate a balance that does not yet include the payment just made.
      await client.query(
        `INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount, created_by)
         VALUES ($1,$2,$3,$4)`,
        [payId, id, data.amount, req.user?.id || null]
      );

      recalcResult = await _recalcStatus(client, id);

      // Queue the "payment received" WhatsApp message, on THIS transaction —
      // the receipt and the money commit or roll back together. AFTER recalc,
      // so the balance_due the message carries already includes this payment.
      // The dispatcher takes its own SAVEPOINT and never throws, and it
      // requires the template to be enabled + auto_send in Settings, so this
      // is a no-op until somebody switches it on.
      //
      // Keyed on the LEDGER row: two part-payments are two receipts, and a
      // retried request that reached here twice would still be one row and one
      // message. (invoice_paid, if this payment settles the invoice, fires
      // separately inside recalcInvoiceState — different template, different
      // question.)
      await fireWhatsAppEvent(client, {
        event: 'payment.received',
        entityId: payId,
        dedupeKey: `received:${payId}`,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'customer_invoice_payment',
      entityId: payId,
      description: `Recorded ₹${Number(data.amount).toFixed(2)} by ${data.method}`
        + (data.reference_no ? ` (ref ${data.reference_no})` : '')
        + ` against invoice #${id}${data.paid_at ? `, dated ${String(data.paid_at).slice(0, 10)}` : ''}`
        + ` — balance was ₹${balanceBefore.toFixed(2)}, invoice is now ${recalcResult?.status}`,
    });

    // Side effects AFTER the commit, and swallowed.
    //
    // The payment is committed and the money is real. A failure to close the
    // appointment or resolve a warranty claim is a follow-up task, not a reason
    // to hand back a 500 that reads as "the payment did not save" and have
    // somebody record it a second time. payments.service.js has always wrapped
    // the identical two calls; the manual path did not.
    if (recalcResult?.status === 'paid') {
      try {
        await advanceAppointmentStatus(recalcResult.appointment_id, 'closed');
        await resolveClaimForEstimate(recalcResult.estimate_id);
      } catch (err) {
        console.error('[customer_invoices] post-payment side effect failed for invoice', id, err.message);
      }
    }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.status(201).json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/customer-invoices/:id/payments/:payId — correct a payment's date.
// Amount/method are immutable (delete + re-add for those); only paid_at moves.
// Re-runs _recalcStatus so the hub payout due date re-anchors to the (possibly
// new) latest payment date. Existing warranty claims keep their stored
// service-date snapshot; only claims registered AFTER this edit see the shift.
// ─────────────────────────────────────────────────────────────────────────────
function updatePayment(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const payId = idParam.parse(req.params.payId);
    const data  = z.object({
      paid_at: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, 'paid_at must be a date (YYYY-MM-DD)'),
    }).parse(req.body);

    await _assertCiHub(req, id);

    const payRow = await pool.query(
      `SELECT p.id, p.paid_at::text AS paid_at, p.amount, p.method, p.source
         FROM customer_invoice_payments p
        WHERE p.id = $1 AND p.customer_invoice_id = $2`,
      [payId, id]
    );
    if (!payRow.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    const pay = payRow.rows[0];

    // A gateway payment's date is the gateway's, not ours.
    //
    // paid_at on a captured row is when the bank took the money. Editing it
    // here would make the ledger disagree with payment_transactions and with
    // the settlement report, and it would move the hub payout anchor to a date
    // no money actually arrived on.
    if (pay.source === 'gateway') {
      return res.status(409).json({
        error: 'This payment was taken online, so its date is set by the payment gateway and cannot be edited here.',
        code: 'GATEWAY_PAYMENT_IMMUTABLE',
      });
    }

    // Once the hub has actually been paid, this date is frozen.
    //
    // The payment date is the anchor for the payout schedule, so shifting it
    // after the money has gone out makes the schedule disagree with what was
    // actually paid, and when. deletePayment applies the same guard through the
    // same helper — they used to ask two different questions.
    const hubPaid = await _hubPaidFor(pool, id);
    if (hubPaid > 0) {
      return res.status(409).json({
        error: `Hub payout of ₹${hubPaid.toFixed(2)} has already been made for this job, so the payment date can no longer be changed.`,
        code: 'HUB_ALREADY_PAID',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // AND source = 'manual' belt-and-braces against the check above: this
      // statement is the one that touches money, so the rule is stated where it
      // cannot be skipped by an early return being moved.
      await client.query(
        `UPDATE customer_invoice_payments SET paid_at = $1 WHERE id = $2 AND source = 'manual'`,
        [data.paid_at, payId]
      );
      // Amounts unchanged, but the payout due date is anchored to the LATEST
      // paid_at — recalc re-syncs it (and split installment dates) correctly.
      await _recalcStatus(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'customer_invoice_payment',
      entityId: payId,
      description: `Moved the date of a ₹${Number(pay.amount).toFixed(2)} ${pay.method} payment on invoice #${id}`
        + ` from ${String(pay.paid_at).slice(0, 10)} to ${data.paid_at}`,
    });

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

function deletePayment(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const payId = idParam.parse(req.params.payId);

    // Capture the pre-delete status — deleting a payment off a PAID invoice
    // must also walk back the side effects that firing 'paid' caused.
    await _assertCiHub(req, id);

    let recalcResult = null, prevStatus = null, removed = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The DELETE and the recalc are ONE transaction.
      //
      // They were two. The DELETE ran on the pool and the BEGIN opened after
      // it, so a recalc that threw left the row gone and amount_paid, status
      // and payout_due_date all still counting it — an invoice reading PAID
      // with no payment behind it, and a ROLLBACK with nothing to roll back
      // because the delete had already committed itself.
      const prevRow = await client.query(
        `SELECT status FROM customer_invoices WHERE id = $1 FOR UPDATE`, [id]);
      if (!prevRow.rows[0]) throw payErr(404, 'Customer invoice not found');
      prevStatus = prevRow.rows[0].status;

      // Read the row BEFORE deleting it. This is the only moment its amount,
      // method and reference still exist anywhere — the audit entry below is
      // written from this, and after the COMMIT there is nothing left to read.
      const payRow = await client.query(
        `SELECT id, amount, method, reference_no, paid_at::text AS paid_at, source, created_by
           FROM customer_invoice_payments
          WHERE id = $1 AND customer_invoice_id = $2`,
        [payId, id]
      );
      if (!payRow.rows[0]) throw payErr(404, 'Payment not found');
      removed = payRow.rows[0];

      // HARD BLOCK 1: gateway money is not deleted, it is refunded.
      //
      // Deleting a captured payment strands its payment_transactions row at
      // 'captured' with no ledger row behind it, and destroys the link an
      // accountant reconciles against the Razorpay settlement. Migration 124
      // states the rule; nothing enforced it until now.
      if (removed.source === 'gateway') {
        throw payErr(409,
          'This payment was taken online and cannot be deleted. Refund it from the Payments screen instead — '
          + 'that returns the money to the customer and leaves the record intact.',
          { code: 'GATEWAY_PAYMENT_IMMUTABLE' });
      }

      // HARD BLOCK 2: once the hub has actually been paid for this job, the
      // customer payment can no longer be deleted — deleting it wouldn't
      // reverse money already sent to the hub, leaving the company out of
      // pocket with no record of why. Reverse the hub payment first.
      //
      // Same helper as updatePayment. This guard used to match a purchase
      // invoice on estimate_id alone while the edit guard also matched
      // purchase_invoice_id, so an invoice linked only that way was frozen
      // against a date change and NOT against deletion.
      const hubPaid = await _hubPaidFor(client, id);
      if (hubPaid > 0) {
        throw payErr(409,
          `Hub payout of ₹${hubPaid.toFixed(2)} has already been made for this job — this payment can no longer be deleted. `
          + 'Reverse the hub payment on the Purchase Invoice first.',
          { code: 'HUB_ALREADY_PAID' });
      }

      await client.query(
        `DELETE FROM customer_invoice_payments
          WHERE id = $1 AND customer_invoice_id = $2 AND source = 'manual'`,
        [payId, id]
      );

      recalcResult = await _recalcStatus(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }

    // The row is gone; this is now the only record that it existed.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'customer_invoice_payment',
      entityId: payId,
      description: `Deleted a ₹${Number(removed.amount).toFixed(2)} ${removed.method} payment`
        + (removed.reference_no ? ` (ref ${removed.reference_no})` : '')
        + ` dated ${String(removed.paid_at).slice(0, 10)} from invoice #${id}`
        + ` — invoice was ${prevStatus}, now ${recalcResult?.status}`,
    });

    // Invoice dropped BELOW paid → reverse the paid side effects:
    //  1. reopen the appointment (closed → invoice-approved)
    //  2. un-resolve a redo warranty claim, if this CI belongs to one
    // (payout due dates are already cleared inside _recalcStatus via
    //  syncPayoutDueDate — it always reflects the CI's current paid state)
    //
    // Swallowed, as on the add path: the deletion is committed either way, and
    // a 500 here would invite someone to delete it again.
    if (prevStatus === 'paid' && recalcResult?.status !== 'paid') {
      try {
        await advanceAppointmentStatus(recalcResult.appointment_id, 'invoice-approved');
        await unresolveClaimForEstimate(recalcResult.estimate_id);
      } catch (err) {
        console.error('[customer_invoices] post-delete side effect failed for invoice', id, err.message);
      }
    }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice-date support (SPEC_backdated_customer_invoice.md, phases 2-3)
// ─────────────────────────────────────────────────────────────────────────────

// The company's books-lock date and backdating window. One row table; missing
// row means nothing is locked and the default window applies.
async function loadInvoiceDateSettings() {
  const r = await pool.query(
    `SELECT books_locked_through::text AS books_locked_through,
            backdate_max_days
       FROM company_settings ORDER BY id LIMIT 1`
  );
  return r.rows[0] || { books_locked_through: null, backdate_max_days: 30 };
}

// requirePermission already gates the ROUTE; this is for the finer-grained
// decisions inside a handler (may this user override a soft rule?). Mirrors
// the middleware exactly, is_super_admin bypass included.
function hasPerm(req, code) {
  if (!req.user) return false;
  if (req.user.is_super_admin) return true;
  return !!req.user.permissions?.has(code);
}

// Everything the validator needs about one existing invoice, in one round trip.
async function loadDateContext(client, ciId) {
  const r = await client.query(
    `SELECT ci.id, ci.status, ci.estimate_id, ci.purchase_invoice_id,
            ci.invoice_date::text          AS invoice_date,
            ci.original_invoice_date::text AS original_invoice_date,
            ci.amount_paid,
            -- The estimate's OWN date (migration 101), not when its row was
            -- keyed in. This is the fix that makes retroactive entry work:
            -- backdating the estimate moves the floor for its invoice.
            e.estimate_date::text          AS estimate_date,
            e.original_estimate_date::text AS estimate_original_date,
            e.created_at                   AS estimate_created_at,
            (SELECT MIN(p.paid_at)::text FROM invoice_payment_lines p
              WHERE p.customer_invoice_id = ci.id)             AS earliest_payment,
            (SELECT COUNT(*)::int FROM invoice_payment_lines p
              WHERE p.customer_invoice_id = ci.id)             AS payment_count,
            (SELECT MAX(invoice_date)::text FROM customer_invoices)  AS max_existing_date,
            pi.id                          AS pi_id,
            pi.invoice_date::text          AS pi_invoice_date,
            pi.amount_paid                 AS pi_amount_paid
       FROM customer_invoices ci
       LEFT JOIN estimates e ON e.id = ci.estimate_id
       -- An OR join can match two different PIs when a legacy row's
       -- purchase_invoice_id points somewhere other than its estimate's PI.
       -- Prefer the explicitly linked one, then lowest id, so the freeze check
       -- and the row we later UPDATE are always the same PI.
       LEFT JOIN LATERAL (
         SELECT p.* FROM purchase_invoices p
          WHERE p.id = ci.purchase_invoice_id OR p.estimate_id = ci.estimate_id
          ORDER BY (p.id = ci.purchase_invoice_id) DESC, p.id
          LIMIT 1
       ) pi ON TRUE
      WHERE ci.id = $1
      LIMIT 1`,
    [ciId]
  );
  return r.rows[0] || null;
}

// Can the linked purchase invoice legally be dragged along by a CI date change?
// Only the money test lives here — whether the DATE it would land on is allowed
// is a separate question, answered by validateInvoiceDate on the PI itself.
function piCanFollow(ctx) {
  return !!ctx.pi_id && Number(ctx.pi_amount_paid || 0) === 0;
}

/**
 * What sits upstream of this customer invoice for the chain rule.
 *
 * Normally that is the purchase invoice: the customer's bill cannot predate the
 * hub's bill for the same job. But when the PI is moving in the SAME request,
 * its current date is about to stop being true — the PI is about to become
 * whatever the CI becomes. Holding the CI to the PI's old date then makes the
 * pair unable to travel backwards together, and since there is no endpoint that
 * moves a purchase invoice on its own, the job has no way out at all.
 *
 * The real constraint in that case is the estimate, which validateInvoiceDate
 * already applies as the fallback for a customer invoice. Returning null hands
 * it that job — and keeps the error message pointing at the estimate, which is
 * the document the user would actually have to fix.
 *
 * The chain still holds after the move: estimate <= PI(new) = CI(new) <= today.
 */
function chainFloorFor(ctx, piWillFollow) {
  return piWillFollow ? null : ctx.pi_invoice_date;
}

// Runs the warranty preflight for a proposed date.
async function computeWarrantyImpact(client, ciId, currentDate, newDate, today) {
  const items = await client.query(WARRANTY_ITEMS_SQL, [ciId]);
  return warrantyImpact({ items: items.rows, currentDate, newDate, today });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/:id/date-preflight?invoice_date=YYYY-MM-DD
//   Dry run. Returns exactly what a PATCH would do — which rules fail, which
//   need an override, and which warranties move — without writing anything.
//   The UI calls this as the user picks a date, so the consequences are on
//   screen before the decision, not after it.
// ─────────────────────────────────────────────────────────────────────────────
function invoiceDatePreflight(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const newDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD')
      .parse(req.query.invoice_date);
    // The dialog's "also move the purchase invoice" checkbox, echoed back here
    // so the preview answers the question the user is actually asking. Without
    // it the preflight would show a hard failure for a date the PATCH would
    // accept, and the Save button would sit disabled over a legal change.
    await _assertCiHub(req, id);

    const wantMovePi = req.query.move_purchase_invoice === 'true' ||
                       req.query.move_purchase_invoice === '1';

    const ctx = await loadDateContext(pool, id);
    if (!ctx) return res.status(404).json({ error: 'Customer invoice not found' });

    const today = istToday();
    const settings = await loadInvoiceDateSettings();
    const warranty = await computeWarrantyImpact(pool, id, ctx.invoice_date, newDate, today);
    const piFollows = wantMovePi && piCanFollow(ctx);

    const check = validateInvoiceDate({
      invoiceDate: newDate,
      currentDate: ctx.invoice_date,
      estimateDate: ctx.estimate_date || toIstDate(ctx.estimate_created_at),
      piDate: ctx.pi_invoice_date,
      // Hard chain rule, not just the soft PI_AFTER_CI warning: a customer
      // invoice cannot predate the hub's bill for the same job — unless that
      // bill is moving with it. See chainFloorFor.
      chainBefore: chainFloorFor(ctx, piFollows),
      earliestPayment: ctx.earliest_payment,
      maxExistingDate: ctx.max_existing_date,
      settings,
      warranty,
      canBackdate: hasPerm(req, 'BACKDATE_INVOICE'),
      canOverride: false, // report what WOULD need an override, don't apply one
      today,
    });

    const hubPaid = Number(ctx.pi_amount_paid || 0) > 0;

    // If the PI is coming along, its own move has to be legal too — and it is
    // checked against ITS current date, so a rule the CI passes can still fail
    // here. A PI on 31 March following a CI from 2 April to 1 April would cross
    // a financial year even though the CI never left one. The PATCH refuses
    // that outright, so the preflight has to show it rather than let the user
    // click Save into a 409.
    const piMoveCheck = piFollows
      ? validateInvoiceDate({
          invoiceDate: newDate,
          currentDate: ctx.pi_invoice_date,
          documentType: 'purchase_invoice',
          chainBefore: ctx.estimate_date || toIstDate(ctx.estimate_created_at),
          settings,
          canBackdate: hasPerm(req, 'BACKDATE_INVOICE'),
          canOverride: false,
          today,
        })
      : null;

    res.json({
      current_date: ctx.invoice_date,
      proposed_date: newDate,
      today,
      ok: check.ok && (!piMoveCheck || piMoveCheck.ok),
      unchanged: !!check.unchanged,
      // The PI's failures are folded into the same list rather than a separate
      // field, so the dialog renders them without knowing they exist — but
      // re-worded, because "Purchase invoice date is before its estimate" makes
      // no sense to someone who is looking at a customer invoice.
      errors: [
        ...check.errors,
        ...(piMoveCheck?.errors || []).map(e => ({
          ...e,
          message: `Moving the purchase invoice with it is not allowed: ${e.message}`,
        })),
      ],
      warnings: check.warnings,
      requires_override: check.errors.some(e => e.overridable),
      requires_reason: newDate !== ctx.invoice_date,
      // The date freezes once money has moved — see updateInvoiceDate.
      locked: Number(ctx.payment_count) > 0 || !['generated', 'approved'].includes(ctx.status),
      lock_reason: Number(ctx.payment_count) > 0
        ? 'This invoice has payments recorded against it.'
        : (!['generated', 'approved'].includes(ctx.status) ? `Invoice status is ${ctx.status}.` : null),
      warranty,
      purchase_invoice: ctx.pi_id ? {
        id: ctx.pi_id,
        invoice_date: ctx.pi_invoice_date,
        can_follow: !hubPaid,
        // What it would become — so the checkbox can say so instead of leaving
        // the user to infer that "also move it" means "to this same date".
        would_become: piFollows ? newDate : null,
        blocked_reason: hubPaid
          ? 'The hub has already been paid for this job, so its purchase invoice date is frozen.'
          : null,
      } : null,
      books_locked_through: settings.books_locked_through,
      backdate_max_days: settings.backdate_max_days,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/date-compliance
//   Every backdated invoice, plus every place where invoice-number order and
//   invoice-date order disagree.
//
//   Decision 1 (option A) permits that disagreement rather than forbidding it,
//   on the condition it stays visible. This is that condition — the report you
//   hand your CA, rather than a surprise they find.
//
//   Invoice numbers come from the row id, so "number order" is id order.
// ─────────────────────────────────────────────────────────────────────────────
function invoiceDateCompliance(req, res, next) {
  handle(req, res, next, async () => {
    const q = z.object({
      from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);

    const params = [];
    const where = [`ci.status <> 'cancelled'`];
    if (q.from) { params.push(q.from); where.push(`ci.invoice_date >= $${params.length}::date`); }
    if (q.to)   { params.push(q.to);   where.push(`ci.invoice_date <= $${params.length}::date`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    // A "break" is an invoice whose date is earlier than that of any
    // lower-numbered invoice. LAG over id order gives the previous number's
    // date; comparing against a running maximum catches cases the immediate
    // predecessor would miss.
    const r = await pool.query(
      `WITH ordered AS (
         SELECT ci.id, ci.invoice_date, ci.original_invoice_date, ci.backdate_reason,
                ci.backdated_at, ci.customer_name, ci.grand_total, ci.status,
                u.name AS backdated_by_name,
                MAX(ci.invoice_date) OVER (
                  ORDER BY ci.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS max_prior_date
           FROM customer_invoices ci
           LEFT JOIN users u ON u.id = ci.backdated_by
           ${whereSql}
       )
       SELECT id, invoice_date::text AS invoice_date,
              original_invoice_date::text AS original_invoice_date,
              backdate_reason, backdated_at, backdated_by_name,
              customer_name, grand_total, status,
              max_prior_date::text AS max_prior_date,
              (max_prior_date IS NOT NULL AND invoice_date < max_prior_date) AS sequence_break,
              (original_invoice_date IS NOT NULL) AS is_backdated
         FROM ordered
        WHERE original_invoice_date IS NOT NULL
           OR (max_prior_date IS NOT NULL AND invoice_date < max_prior_date)
        ORDER BY id DESC`,
      params
    );

    const rows = r.rows.map(row => ({
      ...row,
      invoice_number: `CI-${String(row.id).padStart(6, '0')}`,
    }));

    res.json({
      items: rows,
      summary: {
        total: rows.length,
        backdated: rows.filter(x => x.is_backdated).length,
        sequence_breaks: rows.filter(x => x.sequence_break).length,
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/customer-invoices/:id/invoice-date
//   Correct the legal date of an existing invoice.
//   Body: { invoice_date, reason, override?, move_purchase_invoice? }
// ─────────────────────────────────────────────────────────────────────────────
function updateInvoiceDate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const body = z.object({
      invoice_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD'),
      reason: z.string().trim().min(10, 'Please give a reason of at least 10 characters.'),
      override: z.coerce.boolean().optional().default(false),
      // Decision 5: the PI follows, but only when explicitly asked.
      move_purchase_invoice: z.coerce.boolean().optional().default(false),
    }).parse(req.body);

    await _assertCiHub(req, id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Same lock as updateEstimateDate, keyed on the same estimate id so a
      // concurrent estimate move and invoice move can't interleave. Resolved
      // from the invoice first because that is what we have.
      const est = await client.query(
        `SELECT estimate_id FROM customer_invoices WHERE id = $1`, [id]);
      if (!est.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer invoice not found' }); }
      await client.query(`SELECT pg_advisory_xact_lock(3, $1)`, [est.rows[0].estimate_id]);

      const ctx = await loadDateContext(client, id);
      if (!ctx) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer invoice not found' }); }

      // ── Freeze once money has moved ────────────────────────────────────
      // Same philosophy as the existing block on deleting a payment after a
      // hub payout: once the date has been acted on financially, changing it
      // makes the records disagree with what actually happened.
      if (Number(ctx.payment_count) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This invoice has payments recorded against it, so its date can no longer be changed. Delete the payments first if the date is genuinely wrong.',
          code: 'HAS_PAYMENTS',
        });
      }
      if (!['generated', 'approved'].includes(ctx.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `An invoice with status "${ctx.status}" cannot have its date changed.`,
          code: 'BAD_STATUS',
        });
      }

      const today = istToday();
      if (ctx.invoice_date === body.invoice_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That is already the invoice date.', code: 'UNCHANGED' });
      }

      const settings = await loadInvoiceDateSettings();
      const warranty = await computeWarrantyImpact(client, id, ctx.invoice_date, body.invoice_date, today);

      // Decided BEFORE validation, because it changes what the floor is. This
      // is the whole fix: the cascade lives ~40 lines further down, so checking
      // the CI against the PI's soon-to-be-stale date made the two unable to
      // move back together.
      const piFollows = body.move_purchase_invoice && piCanFollow(ctx);

      const check = validateInvoiceDate({
        invoiceDate: body.invoice_date,
        currentDate: ctx.invoice_date,
        estimateDate: ctx.estimate_date || toIstDate(ctx.estimate_created_at),
        piDate: ctx.pi_invoice_date,
        // Hard chain rule, not just the soft PI_AFTER_CI warning: a customer
        // invoice cannot predate the hub's bill for the same job — unless that
        // bill is moving with it. See chainFloorFor.
        chainBefore: chainFloorFor(ctx, piFollows),
        earliestPayment: ctx.earliest_payment,
        maxExistingDate: ctx.max_existing_date,
        settings,
        warranty,
        canBackdate: hasPerm(req, 'BACKDATE_INVOICE'),
        canOverride: body.override && hasPerm(req, 'OVERRIDE_INVOICE_DATE_LIMITS'),
        today,
      });
      if (!check.ok) { await client.query('ROLLBACK'); return res.status(409).json(validationError(check)); }

      // original_invoice_date records where this invoice STARTED, so it is
      // written once and never overwritten — a second correction must not
      // erase the evidence of the first.
      const firstMove = ctx.original_invoice_date == null;

      await client.query(
        `UPDATE customer_invoices
            SET invoice_date          = $1::date,
                original_invoice_date = COALESCE(original_invoice_date, $2::date),
                backdate_reason       = $3,
                backdated_by          = $4,
                backdated_at          = NOW(),
                updated_by            = $4,
                updated_at            = NOW()
          WHERE id = $5`,
        [body.invoice_date, ctx.invoice_date, body.reason, req.user?.id || null, id]
      );

      // ── The purchase invoice, if asked ─────────────────────────────────
      let piResult = null;
      if (body.move_purchase_invoice && ctx.pi_id) {
        if (!piCanFollow(ctx)) {
          // Refusing only the PI half, not the whole request: the customer
          // invoice date may still be perfectly correct to fix. Note this
          // branch cannot have relaxed the floor above — piCanFollow gates
          // both — so the CI was still validated against the PI's real date.
          piResult = { moved: false, reason: 'Hub has already been paid; the purchase invoice date is frozen.' };
        } else {
          // The PI's own move must be legal too, and it is judged against ITS
          // current date — so a rule the CI passed can still fail here. A PI on
          // 31 March following a CI from 2 April to 1 April crosses a financial
          // year the CI never left.
          //
          // This one ROLLS BACK rather than skipping the PI like the frozen-hub
          // branch above, and it has to: the CI's floor was relaxed on the
          // promise that the PI would follow. Writing the CI anyway would leave
          // the customer invoice dated before the hub's bill — the exact state
          // the chain rule exists to prevent, and one no endpoint can repair.
          const piCheck = validateInvoiceDate({
            invoiceDate: body.invoice_date,
            currentDate: ctx.pi_invoice_date,
            documentType: 'purchase_invoice',
            chainBefore: ctx.estimate_date || toIstDate(ctx.estimate_created_at),
            settings,
            canBackdate: hasPerm(req, 'BACKDATE_INVOICE'),
            canOverride: body.override && hasPerm(req, 'OVERRIDE_INVOICE_DATE_LIMITS'),
            today,
          });
          if (!piCheck.ok) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              ...validationError(piCheck),
              error: `The purchase invoice cannot move to ${body.invoice_date}: ` +
                     `${piCheck.errors[0]?.message} ` +
                     'Untick "also move the purchase invoice" to leave it where it is — ' +
                     'though the invoice date will then be limited by it.',
            });
          }

          await client.query(
            `UPDATE purchase_invoices
                SET invoice_date          = $1::date,
                    original_invoice_date = COALESCE(original_invoice_date, invoice_date),
                    backdate_reason       = $2,
                    backdated_by          = $3,
                    backdated_at          = NOW(),
                    updated_by            = $3,
                    updated_at            = NOW()
              WHERE id = $4`,
            [body.invoice_date, `Followed CI-${String(id).padStart(6, '0')}: ${body.reason}`,
             req.user?.id || null, ctx.pi_id]
          );
          piResult = { moved: true, id: ctx.pi_id, invoice_date: body.invoice_date };
        }
      }

      await client.query('COMMIT');

      // This controller has never written to activity_logs. It does now — the
      // date of a tax invoice is exactly the kind of change someone will later
      // be asked to account for.
      logActivity({
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'UPDATE',
        entity: 'customer_invoice',
        entityId: id,
        description:
          `Invoice date changed on CI-${String(id).padStart(6, '0')}: ` +
          `${ctx.invoice_date} → ${body.invoice_date}` +
          (check.overridden?.length ? ` [overrode: ${check.overridden.map(o => o.code).join(', ')}]` : '') +
          (piResult?.moved ? ` [PI-${String(ctx.pi_id).padStart(6, '0')} moved too]` : '') +
          ` — ${body.reason}`,
      });

      res.json({
        ok: true,
        id,
        invoice_date: body.invoice_date,
        previous_invoice_date: ctx.invoice_date,
        first_change: firstMove,
        warnings: check.warnings,
        overridden: check.overridden || [],
        warranty,
        purchase_invoice: piResult,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/customer-invoices/from-estimate — Generate CI from a work_completed
//   estimate. REQUIRES an approved Purchase Invoice to exist first.
//   Flow: Estimate → PI (hub payout) → Approve PI → CI → Approve CI → Pay CI → CLOSED
// ─────────────────────────────────────────────────────────────────────────────
function generateCustomerInvoiceFromEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const body = z.object({
      estimate_id: z.coerce.number().int().positive(),
      // Optional. Omitted = today, which is the overwhelmingly common path and
      // exactly what happened before backdating existed.
      invoice_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD').optional(),
      backdate_reason: z.string().trim().min(10, 'Please give a reason of at least 10 characters.').optional(),
      // Explicit opt-in to overriding a soft rule. Requiring the caller to ask
      // means an override can never happen because someone simply had the
      // permission — they have to have seen the warning and chosen to proceed.
      override: z.coerce.boolean().optional().default(false),
    }).parse(req.body);
    const { estimate_id } = body;

    // Validate estimate exists and is work_completed
    const estRow = await pool.query(
      `SELECT e.id, e.status, e.appointment_id, e.hub_id,
              e.discount_mode, e.transaction_discount_type,
              e.transaction_discount_value, e.transaction_discount_amount,
              e.is_b2b, e.b2b_company_name, e.b2b_gst_number, e.b2b_address,
              e.customer_name, e.mobile, e.vehicle_number, e.notes,
              e.odometer_km, e.warranty_claim_id
       FROM estimates e WHERE e.id = $1`,
      [estimate_id]
    );
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const est = estRow.rows[0];
    // A hub login may only invoice its own hub's work. Guarded on the ESTIMATE's
    // hub, since that is what the new invoice will inherit.
    assertHubOwns(req, est, 'hub_id', 'Estimate');
    if (est.status !== 'work_completed') {
      return res.status(400).json({
        error: `Estimate must be work_completed to generate a customer invoice (current: ${est.status})`,
      });
    }

    // Block CI unless an approved Purchase Invoice exists for this estimate
    const piRow = await pool.query(
      `SELECT id, status FROM purchase_invoices WHERE estimate_id = $1 ORDER BY id DESC LIMIT 1`,
      [estimate_id]
    );
    if (!piRow.rows[0]) {
      return res.status(400).json({
        error: 'A purchase invoice must be created and approved before generating a customer invoice.',
      });
    }
    // Note: PI payment progress lives in payment_status, not status — status
    // stays 'approved' after approval, so checking 'approved' alone is correct
    // (incl. ₹0 warranty-redo PIs, whose payment_status is auto-set 'paid').
    if (piRow.rows[0].status !== 'approved') {
      return res.status(400).json({
        error: `The purchase invoice must be approved before generating a customer invoice (current PI status: ${piRow.rows[0].status}).`,
      });
    }

    // Block duplicate — one CI per estimate
    const existingCI = await pool.query(
      `SELECT id FROM customer_invoices WHERE estimate_id = $1 LIMIT 1`,
      [estimate_id]
    );
    if (existingCI.rows[0]) {
      return res.status(409).json({
        error: 'Customer invoice already exists for this estimate.',
        customer_invoice_id: existingCI.rows[0].id,
      });
    }

    // ── Invoice date ────────────────────────────────────────────────────────
    // Resolved and validated BEFORE the transaction opens: a rejected date
    // should cost nothing, and every rule here is a read.
    const today = istToday();

    // Inherit a retroactively-entered job's date.
    //
    // If the estimate was EXPLICITLY backdated, the whole job is historical and
    // the invoice belongs on the same day — that's the entire point of entering
    // it that way, and making the user retype the date would be a trap.
    //
    // If the estimate is merely OLD (created weeks ago, never backdated), the
    // work has only just finished and the invoice belongs today. Those two look
    // identical from the date alone, which is why original_estimate_date — set
    // only by a deliberate backdate — is what distinguishes them.
    const estMeta = await pool.query(
      `SELECT estimate_date::text AS estimate_date, original_estimate_date
         FROM estimates WHERE id = $1`,
      [estimate_id]
    );
    const inherited = estMeta.rows[0]?.original_estimate_date
      ? estMeta.rows[0].estimate_date
      : null;

    const invoiceDate = body.invoice_date || inherited || today;
    let dateWarnings = [];

    if (invoiceDate !== today) {
      const [settings, estDate, maxDate, piDateRow] = await Promise.all([
        loadInvoiceDateSettings(),
        pool.query(`SELECT estimate_date::text AS estimate_date, created_at FROM estimates WHERE id = $1`, [estimate_id]),
        pool.query(`SELECT MAX(invoice_date)::text AS d FROM customer_invoices`),
        pool.query(`SELECT invoice_date::text AS d FROM purchase_invoices WHERE estimate_id = $1`, [estimate_id]),
      ]);
      const piDateForChain = piDateRow.rows[0]?.d || null;
      // Inherited vs chosen — the same distinction the estimate create path
      // needed. A date the user typed is a decision they must be permitted to
      // make; a date inherited from an already-backdated estimate was
      // authorised when the ESTIMATE was backdated, by someone who held the
      // permission and gave a reason. Demanding it again here blocked ordinary
      // staff from invoicing a job they were never asked to date.
      const userChoseDate = !!body.invoice_date;
      const check = validateInvoiceDate({
        invoiceDate,
        estimateDate: estDate.rows[0]?.estimate_date || toIstDate(estDate.rows[0]?.created_at),
        // The PI is generated before the CI, so it is the immediate upstream
        // link. Passing it is what makes estimate <= PI <= CI a real rule
        // rather than a claim in a comment.
        chainBefore: piDateForChain,
        maxExistingDate: maxDate.rows[0]?.d || null,
        settings,
        canBackdate: userChoseDate ? hasPerm(req, 'BACKDATE_INVOICE') : true,
        canOverride: userChoseDate
          ? (body.override && hasPerm(req, 'OVERRIDE_INVOICE_DATE_LIMITS'))
          : true,
        today,
      });
      if (!check.ok) return res.status(409).json(validationError(check));
      // An inherited date needs no fresh justification: the estimate it came
      // from already carries one, and demanding it again would make the
      // retroactive flow ask the same question twice.
      if (userChoseDate && !body.backdate_reason) {
        return res.status(400).json({
          error: 'A reason is required when dating an invoice earlier than today.',
          code: 'REASON_REQUIRED',
        });
      }
      dateWarnings = check.warnings;
    }

    // Pull appointment details for the CI header — falls back to the
    // estimate's own standalone customer/vehicle columns when there is no
    // linked appointment.
    let appt = { customer_name: est.customer_name, mobile: est.mobile, vehicle_number: est.vehicle_number, odometer_km: est.odometer_km ?? null };
    if (est.appointment_id) {
      const apptRow = await pool.query(
        `SELECT customer_name, mobile, vehicle_number, odometer_km FROM appointments WHERE id = $1`,
        [est.appointment_id]
      );
      appt = apptRow.rows[0] || appt;
    }

    // Fetch completed + customer-approved items from the estimate
    const itemsRow = await pool.query(
      `SELECT * FROM estimate_items
       WHERE estimate_id = $1 AND customer_approved = TRUE AND work_status = 'completed'`,
      [estimate_id]
    );
    if (itemsRow.rowCount === 0) {
      return res.status(400).json({
        error: 'No completed & customer-approved items found in this estimate.',
      });
    }

    // Use the estimate items' STORED amounts — these already have line-item
    // discounts and GST baked in, so CI totals always match the estimate.
    // (Recomputing from rate × qty here would silently drop line discounts.)
    const roundFn = getRoundingFunction(new Date());

    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const ciItems = itemsRow.rows.map(item => {
      const totalIncGst = parseFloat(item.total_inc_gst) || 0;
      const gstAmt      = parseFloat(item.gst_amount)    || 0;
      const amtExGst    = roundFn(totalIncGst - gstAmt);
      subtotalExGst += amtExGst;
      totalGst      += gstAmt;
      grandTotal    += totalIncGst;
      return { ...item, gst_amount: gstAmt, total_inc_gst: totalIncGst };
    });

    // Apply transaction-level discount on CI grand total if applicable
    const discountMode     = est.discount_mode              || 'line_item';
    const txDiscountType   = est.transaction_discount_type  || null;
    const txDiscountValue  = parseFloat(est.transaction_discount_value)  || 0;
    let   txDiscountAmount = 0;

    if (discountMode === 'transaction' && txDiscountValue > 0) {
      if (txDiscountType === 'percent') {
        txDiscountAmount = roundFn(grandTotal * txDiscountValue / 100);
      } else if (txDiscountType === 'flat') {
        txDiscountAmount = Math.min(txDiscountValue, grandTotal);
      }
      grandTotal = roundFn(grandTotal - txDiscountAmount);
    }

    // What the advance auto-apply put onto this invoice, so the response can
    // tell the user their customer's ₹2,000 has already been accounted for
    // rather than leaving them to notice it in the totals.
    let appliedAdvances = [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serialize concurrent CI generation for the same estimate and re-check
      // the one-CI-per-estimate guard inside the transaction.
      await client.query(`SELECT pg_advisory_xact_lock(2, $1)`, [estimate_id]);
      const dupInTx = await client.query(
        `SELECT id FROM customer_invoices WHERE estimate_id = $1 LIMIT 1`,
        [estimate_id]
      );
      if (dupInTx.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Customer invoice already exists for this estimate.',
          customer_invoice_id: dupInTx.rows[0].id,
        });
      }

      const ciRow = await client.query(
        `INSERT INTO customer_invoices
           (estimate_id, appointment_id, hub_id,
            customer_name, mobile, vehicle_number,
            subtotal_ex_gst, total_gst, grand_total,
            discount_mode, transaction_discount_type,
            transaction_discount_value, transaction_discount_amount,
            is_b2b, b2b_company_name, b2b_gst_number, b2b_address,
            notes, public_token, odometer_km,
            invoice_date, original_invoice_date, backdate_reason, backdated_by, backdated_at,
            updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21::date, $22::date, $23, $24, $25, $26) RETURNING id`,
        [
          estimate_id, est.appointment_id, est.hub_id,
          appt.customer_name || null, appt.mobile || null, appt.vehicle_number || null,
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          discountMode, txDiscountType,
          txDiscountValue, txDiscountAmount.toFixed(2),
          est.is_b2b || false,
          est.is_b2b ? (est.b2b_company_name || null) : null,
          est.is_b2b ? (est.b2b_gst_number   || null) : null,
          est.is_b2b ? (est.b2b_address      || null) : null,
          // Carried over from the estimate at generation time — a one-time
          // copy, not kept in sync afterward (same pattern as customer_name/
          // mobile/vehicle_number above).
          est.notes || null,
          generatePublicToken(),
          // Odometer baseline for warranty-claim KM validation
          appt.odometer_km ?? null,
          // The legal date. Provenance columns stay NULL on the normal path,
          // which is what makes `original_invoice_date IS NOT NULL` a reliable
          // "was this backdated?" test.
          invoiceDate,
          invoiceDate === today ? null : today,
          invoiceDate === today ? null
            : (body.backdate_reason || `Inherited from backdated estimate #${estimate_id}`),
          invoiceDate === today ? null : (req.user?.id || null),
          invoiceDate === today ? null : new Date(),
          req.user?.id || null,
        ]
      );
      const ciId = ciRow.rows[0].id;

      for (const item of ciItems) {
        await client.query(
          `INSERT INTO customer_invoice_items
             (customer_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac,
              discount_type, discount_value, discount_amount,
              warranty_months, warranty_days, warranty_km, warranty_text,
              guarantee_months, guarantee_days, guarantee_km, guarantee_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [ciId, item.id, item.item_type, item.description,
           item.quantity, item.customer_rate, item.gst_percent,
           item.gst_amount.toFixed(2), item.total_inc_gst.toFixed(2),
           item.hsn_sac || null,
           item.discount_type || null, item.discount_value || 0, item.discount_amount || 0,
           // Warranty/guarantee snapshots carried from the estimate item
           // (frozen at estimate time — never re-looked-up from the master).
           item.warranty_months ?? null, item.warranty_days ?? null,
           item.warranty_km ?? null, item.warranty_text || null,
           item.guarantee_months ?? null, item.guarantee_days ?? null,
           item.guarantee_km ?? null, item.guarantee_text || null]
        );
      }
      // A ₹0 invoice (free warranty redo) is settled by definition — no
      // payment will ever arrive, so mark it paid right away. Normal invoices
      // always have grand_total > 0 and are untouched by this.
      const isZeroTotal = grandTotal <= 0.011;
      if (isZeroTotal) {
        await client.query(
          `UPDATE customer_invoices SET status = 'paid', amount_paid = 0, updated_at = NOW() WHERE id = $1`,
          [ciId]
        );
      } else {
        // Any advance already received against this estimate lands on the
        // invoice now, in the SAME transaction that created it.
        //
        // Inside the transaction on purpose. Outside it, a failure between the
        // two would leave an invoice showing the full amount due while the
        // customer's money sat as unapplied credit — and the customer is
        // standing at the counter having already paid it.
        //
        // Unambiguous by construction: migration 075 enforces one customer
        // invoice per estimate, so an advance recorded against this estimate
        // has exactly one possible destination and it is this row. There is no
        // "which invoice did they mean?" for this to get wrong.
        appliedAdvances = await autoApplyForInvoice(client, {
          estimateId: estimate_id, customerInvoiceId: ciId, userId: req.user?.id || null,
        });
      }

      await client.query('COMMIT');

      // Advance appointment → Invoice Generated
      await advanceAppointmentStatus(est.appointment_id, 'invoice-generated');
      if (isZeroTotal) {
        // Free redo: nothing to collect — close out and resolve the claim
        await advanceAppointmentStatus(est.appointment_id, 'closed');
        await resolveClaimForEstimate(estimate_id);
      }

      const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [ciId]);
      full.rows[0].items = await _getItems(ciId);
      // Not [] any more. An invoice generated from an estimate that already
      // had an advance against it is born with a payment on it, and returning
      // an empty list would show a full balance due for a moment before the
      // screen refreshed.
      full.rows[0].payments = await _getPayments(ciId);
      res.status(201).json({
        item: full.rows[0],
        applied_advances: appliedAdvances,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/customer-invoices/:id/approve — Company approves invoice for payment
// ─────────────────────────────────────────────────────────────────────────────
function approveCustomerInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `SELECT status, appointment_id, hub_id FROM customer_invoices WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    assertHubOwns(req, r.rows[0], 'hub_id', 'Customer invoice');
    if (r.rows[0].status !== 'generated') {
      return res.status(400).json({
        error: `Only 'generated' invoices can be approved. Current status: ${r.rows[0].status}`,
      });
    }

    await pool.query(
      `UPDATE customer_invoices SET status = 'approved', updated_at = NOW() WHERE id = $1`, [id]
    );

    // Auto-advance appointment status
    await advanceAppointmentStatus(r.rows[0].appointment_id, 'invoice-approved');

    // Queue the "Invoice / Bill" WhatsApp message.
    //
    // On APPROVAL, not on generation. A generated invoice is still internal and
    // can be corrected; approving it is the moment someone decides the customer
    // should see it — and the message carries a link to that invoice, so
    // sending it earlier would show the customer a document still being edited.
    //
    // Which template(s) fire is the 'invoice.approved' automation rows
    // (Settings → WhatsApp → Automations, migration 151).
    // fireWhatsAppEventDetached owns the connection, transaction and logging;
    // failures are swallowed there — a messaging problem must not make an
    // approved invoice look unapproved.
    await fireWhatsAppEventDetached(pool, {
      event: 'invoice.approved',
      entityId: id,
      dedupeKey: `approved:${id}`,
    });

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/customer-invoices/:id — edit the CI's own notes directly.
// Independent of the estimate's notes (which are only copied over once, at
// generation time) — editable at any status, since notes are informational
// only and don't affect totals/payments.
// ─────────────────────────────────────────────────────────────────────────────
const updateNotesSchema = z.object({
  notes: z.string().trim().max(3000).optional().nullable(),
});

function updateCustomerInvoiceNotes(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateNotesSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, hub_id FROM customer_invoices WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    assertHubOwns(req, cur.rows[0], 'hub_id', 'Customer invoice');

    await pool.query(
      `UPDATE customer_invoices SET notes = $1, updated_at = NOW() WHERE id = $2`,
      [data.notes || null, id]
    );

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/customer-invoices/:id/extras
//
// Presentation-only fields that have no source in the estimate and so can't
// arrive via generate/sync: the optional invoice header fields (PO number,
// e-way bill, user-defined custom fields) and the optional per-line-item
// fields (detail description, batch/exp/mfg, free-item flag, user-defined
// custom column values). Which of these are actually shown on the printed
// invoice is controlled by company_settings.invoice_config.
//
// Deliberately a separate endpoint from PATCH /:id (notes) rather than an
// extension of it: these fields never affect totals, GST or status, so they
// carry none of the recalculation machinery, and keeping them apart means a
// notes edit can't accidentally clear them.
//
// Items are addressed by customer_invoice_items.id and every id is verified to
// belong to this invoice before anything is written — an id from another
// invoice is rejected rather than silently ignored.
// ─────────────────────────────────────────────────────────────────────────────
const extrasSchema = z.object({
  po_number:        z.string().trim().max(60).nullable().optional(),
  eway_bill_number: z.string().trim().max(60).nullable().optional(),
  // Two-digit GST state code. Setting it overrides the derived value and so
  // flips the invoice between CGST/SGST and IGST — see utils/gstStates.js.
  place_of_supply_code: z.string().trim().regex(/^[0-9]{2}$/).nullable().optional(),
  // Keys are custom-field ids from invoice_config.custom_fields; values are
  // free text. Unknown/stale keys are harmless — templates only render ids
  // that still exist in the config.
  custom_fields:    z.record(z.string().max(200)).optional(),
  items: z.array(z.object({
    id:               z.coerce.number().int().positive(),
    item_description: z.string().trim().max(500).nullable().optional(),
    batch_no:         z.string().trim().max(60).nullable().optional(),
    // Dates arrive as YYYY-MM-DD strings; '' is normalised to null so
    // clearing a date field doesn't hit Postgres as an invalid date.
    exp_date:         z.string().trim().max(10).nullable().optional(),
    mfg_date:         z.string().trim().max(10).nullable().optional(),
    is_free:          z.boolean().optional(),
    custom_values:    z.record(z.string().max(200)).optional(),
  })).max(200).optional(),
});

const emptyToNull = (v) => (v === undefined ? undefined : (v === '' || v === null ? null : v));

function updateCustomerInvoiceExtras(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = extrasSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, hub_id FROM customer_invoices WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    assertHubOwns(req, cur.rows[0], 'hub_id', 'Customer invoice');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Only touch header columns the caller actually sent, so a partial
      // payload can't blank out a field it never knew about.
      const sets = [], params = [];
      const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (data.po_number        !== undefined) push('po_number',        emptyToNull(data.po_number));
      if (data.eway_bill_number !== undefined) push('eway_bill_number', emptyToNull(data.eway_bill_number));
    if (data.place_of_supply_code !== undefined) {
      const code = emptyToNull(data.place_of_supply_code);
      push('place_of_supply_code', code);
      // Store the resolved name alongside the code so a historical document
      // keeps the name it was issued with even if the code table changes.
      push('place_of_supply_name', code ? stateName(code) : null);
    }
      if (data.custom_fields    !== undefined) {
        params.push(JSON.stringify(data.custom_fields));
        sets.push(`custom_fields = $${params.length}::jsonb`);
      }
      if (sets.length) {
        params.push(id);
        await client.query(
          `UPDATE customer_invoices SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
          params
        );
      }

      if (data.items?.length) {
        // Verify ownership of every id up front — one query, and a mismatch
        // aborts the whole transaction rather than partially applying.
        const ids = data.items.map(i => i.id);
        const owned = await client.query(
          `SELECT id FROM customer_invoice_items WHERE customer_invoice_id = $1 AND id = ANY($2::int[])`,
          [id, ids]
        );
        if (owned.rowCount !== ids.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'One or more line items do not belong to this invoice.' });
        }

        for (const it of data.items) {
          const iSets = [], iParams = [];
          const iPush = (col, val) => { iParams.push(val); iSets.push(`${col} = $${iParams.length}`); };
          if (it.item_description !== undefined) iPush('item_description', emptyToNull(it.item_description));
          if (it.batch_no         !== undefined) iPush('batch_no',         emptyToNull(it.batch_no));
          if (it.exp_date         !== undefined) iPush('exp_date',         emptyToNull(it.exp_date));
          if (it.mfg_date         !== undefined) iPush('mfg_date',         emptyToNull(it.mfg_date));
          if (it.is_free          !== undefined) iPush('is_free',          it.is_free);
          if (it.custom_values    !== undefined) {
            iParams.push(JSON.stringify(it.custom_values));
            iSets.push(`custom_values = $${iParams.length}::jsonb`);
          }
          if (!iSets.length) continue;
          iParams.push(it.id);
          await client.query(
            `UPDATE customer_invoice_items SET ${iSets.join(', ')} WHERE id = $${iParams.length}`,
            iParams
          );
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/export — download the (filtered) invoice list as
// an Excel-openable CSV. Mirrors listCustomerInvoices' scoping + filters
// exactly (search / hub_ids / hub_id / status / vehicle_type) but returns
// every matching row, unpaginated, as a file instead of JSON.
// ─────────────────────────────────────────────────────────────────────────────
function exportCustomerInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [], params = [];

    // Same user-scoping rule as listCustomerInvoices — including the hub pin.
    // The CSV builds its own WHERE, so a scoping change made only in the list
    // handler would leave this route as an open door.
    const hubScope = hubScopeSql(req, params, 'ci.hub_id');
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_INVOICE');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (!isAll) {
      params.push(req.user.id);
      conditions.push(
        `EXISTS (SELECT 1 FROM estimates e WHERE e.id = ci.estimate_id AND e.created_by = $${params.length})`
      );
    }

    const searchSql = buildSearchSql({ search: req.query.search, params, ...CI_SEARCH });
    if (searchSql) conditions.push(searchSql);
    if (!hubScope && req.query.hub_ids) {
      const ids = req.query.hub_ids.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`ci.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`ci.hub_id = $${params.length}`);
    }
    if (req.query.status) { params.push(req.query.status); conditions.push(`ci.status = $${params.length}`); }
    if (req.query.vehicle_type) {
      if (req.query.vehicle_type === '2W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = ci.appointment_id AND vt.name ILIKE '%2%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = ci.estimate_id AND vt.name ILIKE '%2%')
        )`);
      } else if (req.query.vehicle_type === '4W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = ci.appointment_id AND vt.name ILIKE '%4%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = ci.estimate_id AND vt.name ILIKE '%4%')
        )`);
      }
    }
    // Invoice-date range filter — same inclusive-both-ends logic as listCustomerInvoices
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`ci.invoice_date >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`ci.invoice_date <= $${params.length}::date`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // CI_SELECT already contains its own FROM/JOIN clause, so extra columns
    // can't be comma-appended after it (that would land the comma right
    // after FROM, breaking the SQL). Fetch last-payment-date + discount
    // totals as separate keyed lookups instead and merge them in JS below.
    const r = await pool.query(`${CI_SELECT} ${where} ORDER BY ci.invoice_date DESC, ci.id DESC`, params);

    const ids = r.rows.map(row => row.id);
    let lastPaymentById = new Map();
    let discountById = new Map();
    if (ids.length > 0) {
      const [payRes, discRes] = await Promise.all([
        pool.query(
          `SELECT customer_invoice_id, MAX(paid_at) AS last_payment_date
           FROM invoice_payment_lines WHERE customer_invoice_id = ANY($1::int[])
           GROUP BY customer_invoice_id`,
          [ids]
        ),
        pool.query(
          `SELECT customer_invoice_id, COALESCE(SUM(discount_amount), 0) AS discount_sum
           FROM customer_invoice_items WHERE customer_invoice_id = ANY($1::int[])
           GROUP BY customer_invoice_id`,
          [ids]
        ),
      ]);
      lastPaymentById = new Map(payRes.rows.map(row => [row.customer_invoice_id, row.last_payment_date]));
      discountById = new Map(discRes.rows.map(row => [row.customer_invoice_id, row.discount_sum]));
    }
    for (const inv of r.rows) {
      inv.last_payment_date = lastPaymentById.get(inv.id) || null;
      inv.discount_total = inv.discount_mode === 'transaction'
        ? inv.transaction_discount_amount
        : (discountById.get(inv.id) || 0);
    }

    const csvEscape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const headers = [
      'Invoice #', 'Date', 'Customer Name', 'Mobile', 'Vehicle Number', 'Vehicle Type', 'Make/Model',
      'Hub', 'Subtotal (ex-GST)', 'Discount', 'GST', 'Grand Total', 'Paid',
      'Payment Date', 'Balance', 'Status', 'B2B Company / GST Number',
    ];

    // The same 2W/4W shorthand the list badge shows, so a CSV filtered to 2W
    // and the screen it came from say the same word.
    //
    // The badge on screen is a binary — anything not containing '2' renders as
    // 4W. That is fine for a coloured chip and wrong for a column people will
    // COUNTIF on: a "3 Wheeler" would be silently tallied as a car. So the
    // fall-through here keeps the raw type name instead of guessing, and a
    // vehicle with no type at all stays blank rather than becoming a 4W.
    const shortVehicleType = (name) => {
      if (!name) return '';
      if (name.includes('2')) return '2W';
      if (name.includes('4')) return '4W';
      return name;
    };

    const rows = r.rows.map(inv => {
      const grandTotal = parseFloat(inv.grand_total ?? 0);
      const paid       = parseFloat(inv.amount_paid ?? 0);
      const balance    = Math.max(0, grandTotal - paid);
      const makeModel  = [inv.make_name, inv.model_name].filter(Boolean).join(' ');
      const b2b        = inv.is_b2b
        ? [inv.b2b_company_name, inv.b2b_gst_number ? `GST: ${inv.b2b_gst_number}` : null].filter(Boolean).join(' / ')
        : '';
      return [
        `CI-${String(inv.id).padStart(6, '0')}`,
        // Already a 'YYYY-MM-DD' string (CI_SELECT casts it) — no Date round
        // trip, which is what used to shift this a day on an IST server.
        inv.invoice_date || '',
        inv.customer_name || '',
        // Masked for a hub, exactly as it is on screen. A CSV is the one place
        // a full contact list would actually be useful to walk away with, so
        // leaving this unmasked would undo the whole exercise. res.json
        // wrapping cannot reach here — this builds a string, not JSON.
        maskFor(req, inv.mobile),
        inv.vehicle_number || '',
        shortVehicleType(inv.vehicle_type_name),
        makeModel,
        inv.hub_full_name || inv.hub_name || '',
        parseFloat(inv.subtotal_ex_gst ?? 0).toFixed(2),
        parseFloat(inv.discount_total ?? 0).toFixed(2),
        parseFloat(inv.total_gst ?? 0).toFixed(2),
        grandTotal.toFixed(2),
        paid.toFixed(2),
        inv.last_payment_date ? new Date(inv.last_payment_date).toISOString().slice(0, 10) : '',
        balance.toFixed(2),
        (inv.status || '').replace('_', ' '),
        b2b,
      ].map(csvEscape).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\r\n');
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customer_invoices_${date}.csv"`);
    res.send('﻿' + csv); // BOM for Excel UTF-8 compatibility
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customer-invoices/vehicle-history/:vnum
// Returns all customer invoices for a given vehicle number (case/space insensitive)
// ─────────────────────────────────────────────────────────────────────────────
function getVehicleHistory(req, res, next) {
  handle(req, res, next, async () => {
    const vnum = (req.params.vnum || '').trim().toUpperCase();
    if (!vnum) return res.json({ items: [], vehicle_number: vnum });

    // A registration number is a trivially guessable key, and the unfiltered
    // history spans every hub that has ever touched the vehicle. A hub sees
    // only the visits it performed.
    const params = [vnum];
    const hubScope = hubScopeSql(req, params, 'ci.hub_id');

    const r = await pool.query(`
      SELECT
        ci.id,
        COALESCE(ci.customer_name, a.customer_name) AS customer_name,
        COALESCE(ci.mobile,        a.mobile)        AS mobile,
        COALESCE(ci.vehicle_number, a.vehicle_number) AS vehicle_number,
        ci.grand_total AS total, ci.amount_paid,
        (ci.grand_total - ci.amount_paid) AS outstanding,
        ci.status AS status_name,
        ci.created_at,
        ci.invoice_date::text AS invoice_date,
        ('Spinoto ' || ar.name) AS hub_name, h.hub_name AS hub_full_name,
        COALESCE(json_agg(
          json_build_object(
            'description',   cii.description,
            'item_type',     cii.item_type,
            'quantity',      cii.quantity,
            'total_inc_gst', cii.total_inc_gst
          ) ORDER BY cii.id
        ) FILTER (WHERE cii.id IS NOT NULL), '[]') AS services
      FROM customer_invoices ci
      LEFT JOIN appointments a ON a.id = ci.appointment_id
      LEFT JOIN hubs h ON h.id = ci.hub_id
      LEFT JOIN areas ar ON ar.id = h.area_id
      LEFT JOIN customer_invoice_items cii ON cii.customer_invoice_id = ci.id
      WHERE UPPER(REPLACE(COALESCE(ci.vehicle_number, a.vehicle_number, ''), ' ', ''))
            = UPPER(REPLACE($1, ' ', ''))${hubScope ? ` AND ${hubScope}` : ''}
      GROUP BY ci.id, a.customer_name, a.mobile, a.vehicle_number, ar.name, h.hub_name
      -- Service history is a customer-facing chronology, so it follows the
      -- invoice date rather than when the row was keyed in.
      ORDER BY ci.invoice_date DESC, ci.id DESC
      LIMIT 50
    `, params);

    res.json({ items: r.rows, vehicle_number: vnum });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/customer-invoices/:id/sync-from-estimate
// Re-derives all line items + totals from the linked estimate.
// Blocked if CI status = 'paid'.
// ─────────────────────────────────────────────────────────────────────────────
function syncCustomerInvoiceFromEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const ciRow = await pool.query(
      `SELECT id, estimate_id, status, created_at, hub_id FROM customer_invoices WHERE id = $1`, [id]
    );
    if (!ciRow.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    assertHubOwns(req, ciRow.rows[0], 'hub_id', 'Customer invoice');
    const ci = ciRow.rows[0];

    if (ci.status === 'paid') {
      return res.status(400).json({ error: 'Cannot sync — Customer Invoice is already paid.' });
    }

    // Re-fetch estimate discount fields
    const estRow = await pool.query(
      `SELECT e.discount_mode, e.transaction_discount_type, e.transaction_discount_value
       FROM estimates e WHERE e.id = $1`,
      [ci.estimate_id]
    );
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Linked estimate not found' });
    const est = estRow.rows[0];

    // Eligible items
    const itemsRow = await pool.query(
      `SELECT * FROM estimate_items
       WHERE estimate_id = $1 AND customer_approved = TRUE AND work_status = 'completed'`,
      [ci.estimate_id]
    );
    if (itemsRow.rowCount === 0) {
      return res.status(400).json({ error: 'No completed & customer-approved items found in estimate.' });
    }

    // Deliberately created_at, NOT invoice_date. This picks legacy vs current
    // rounding off a hardcoded 2026-07-07 cutover (utils/math.js). Keyed to
    // invoice_date instead, backdating a CI to before that cutover would flip
    // it to legacy rounding on the next re-sync and silently change the totals
    // of a document already issued to the customer. Leave it on the real
    // creation timestamp.
    const roundFn = getRoundingFunction(ci.created_at);

    // Use the estimate items' STORED amounts — discounts + GST already baked
    // in, so CI totals always match the estimate (see generate handler).
    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const ciItems = itemsRow.rows.map(item => {
      const totalIncGst = parseFloat(item.total_inc_gst) || 0;
      const gstAmt      = parseFloat(item.gst_amount)    || 0;
      const amtExGst    = roundFn(totalIncGst - gstAmt);
      subtotalExGst += amtExGst;
      totalGst      += gstAmt;
      grandTotal    += totalIncGst;
      return { ...item, gst_amount: gstAmt, total_inc_gst: totalIncGst };
    });

    // Apply transaction discount
    const discountMode    = est.discount_mode || 'none';
    const txDiscountType  = est.transaction_discount_type || null;
    const txDiscountValue = parseFloat(est.transaction_discount_value) || 0;
    let txDiscountAmount  = 0;
    if (discountMode === 'transaction' && txDiscountValue > 0) {
      if (txDiscountType === 'percent') {
        txDiscountAmount = roundFn(grandTotal * txDiscountValue / 100);
      } else if (txDiscountType === 'flat') {
        txDiscountAmount = Math.min(txDiscountValue, grandTotal);
      }
      grandTotal = roundFn(grandTotal - txDiscountAmount);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Diff the invoice lines against the estimate ──────────────────────
      //
      // This used to DELETE every row and re-INSERT. Three problems with that:
      //
      //  1. warranty_claims references customer_invoice_items(id) with no ON
      //     DELETE rule, so the DELETE raised a foreign-key violation and the
      //     whole sync 500'd whenever any line had a claim against it.
      //  2. Invoice-only fields (item_description, batch/exp/mfg, is_free,
      //     custom_values) have no source in the estimate, so they had to be
      //     snapshotted and copied onto the new rows — and that snapshot keyed
      //     on estimate_item_id, which the estimate save nulls, so in practice
      //     it matched nothing and those fields were silently wiped.
      //  3. Line ids churned on every sync, invalidating anything pointing at
      //     them.
      //
      // Updating in place fixes all three: ids survive, claims stay valid, and
      // invoice-only columns are simply never touched.
      const existingRows = await client.query(
        `SELECT id, estimate_item_id FROM customer_invoice_items
         WHERE customer_invoice_id = $1`,
        [id]
      );
      const existingByEstItem = new Map(
        existingRows.rows
          .filter(r => r.estimate_item_id !== null)
          .map(r => [Number(r.estimate_item_id), Number(r.id)])
      );

      // Lines with a claim still open. Their warranty snapshot is what the
      // claim was validated against, so it must not move underneath them, and
      // they cannot be removed at all.
      const claimRows = await client.query(
        `SELECT wc.customer_invoice_item_id AS item_id, wc.claim_code, cii.description
           FROM warranty_claims wc
           JOIN customer_invoice_items cii ON cii.id = wc.customer_invoice_item_id
          WHERE cii.customer_invoice_id = $1
            AND wc.status IN ('registered','under_review','approved')`,
        [id]
      );
      const claimByItem = new Map(claimRows.rows.map(r => [Number(r.item_id), r]));

      const keptCiIds = new Set();

      for (const item of ciItems) {
        const existingId = existingByEstItem.get(Number(item.id));

        if (existingId) {
          const claim = claimByItem.get(existingId);
          // Price and discount always follow the estimate. Warranty terms do
          // NOT when a claim is open against this line.
          await client.query(
            `UPDATE customer_invoice_items SET
               item_type = $2, description = $3, quantity = $4, customer_rate = $5,
               gst_percent = $6, gst_amount = $7, total_inc_gst = $8, hsn_sac = $9,
               discount_type = $10, discount_value = $11, discount_amount = $12,
               warranty_months = CASE WHEN $17 THEN warranty_months ELSE $13 END,
               warranty_days   = CASE WHEN $17 THEN warranty_days   ELSE $14 END,
               warranty_km     = CASE WHEN $17 THEN warranty_km     ELSE $15 END,
               warranty_text   = CASE WHEN $17 THEN warranty_text   ELSE $16 END,
               guarantee_months = $18, guarantee_days = $19,
               guarantee_km = $20, guarantee_text = $21
             WHERE id = $1`,
            [
              existingId, item.item_type, item.description,
              item.quantity, item.customer_rate, item.gst_percent,
              item.gst_amount, item.total_inc_gst, item.hsn_sac || null,
              item.discount_type || null, item.discount_value || 0, item.discount_amount || 0,
              item.warranty_months ?? null, item.warranty_days ?? null,
              item.warranty_km ?? null, item.warranty_text || null,
              !!claim,
              item.guarantee_months ?? null, item.guarantee_days ?? null,
              item.guarantee_km ?? null, item.guarantee_text || null,
            ]
          );
          keptCiIds.add(existingId);
          continue;
        }

        // New estimate line — no invoice row yet. Invoice-only columns start
        // empty, which is correct: there's nothing to preserve.
        const ins = await client.query(
          `INSERT INTO customer_invoice_items
             (customer_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac,
              discount_type, discount_value, discount_amount,
              warranty_months, warranty_days, warranty_km, warranty_text,
              guarantee_months, guarantee_days, guarantee_km, guarantee_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING id`,
          [
            id, item.id, item.item_type, item.description,
            item.quantity, item.customer_rate, item.gst_percent,
            item.gst_amount, item.total_inc_gst, item.hsn_sac || null,
            item.discount_type || null, item.discount_value || 0, item.discount_amount || 0,
            item.warranty_months ?? null, item.warranty_days ?? null,
            item.warranty_km ?? null, item.warranty_text || null,
            item.guarantee_months ?? null, item.guarantee_days ?? null,
            item.guarantee_km ?? null, item.guarantee_text || null,
          ]
        );
        keptCiIds.add(Number(ins.rows[0].id));
      }

      // ── Lines the estimate no longer has ────────────────────────────────
      // Refuse per-line rather than letting Postgres raise a bare FK violation
      // that fails the entire save with an opaque 500.
      const removedIds = existingRows.rows
        .map(r => Number(r.id))
        .filter(rid => !keptCiIds.has(rid));

      for (const rid of removedIds) {
        const claim = claimByItem.get(rid);
        if (claim) {
          const err = new Error(
            `Cannot sync — "${claim.description}" has an open warranty claim (${claim.claim_code}). ` +
            `Resolve or cancel the claim before removing this line from the estimate.`
          );
          err.status = 409;
          throw err;                       // rolls the transaction back
        }
      }
      if (removedIds.length) {
        await client.query(
          `DELETE FROM customer_invoice_items WHERE id = ANY($1::int[])`,
          [removedIds]
        );
      }

      // Update CI totals + discount fields
      await client.query(
        `UPDATE customer_invoices
         SET subtotal_ex_gst=$1, total_gst=$2, grand_total=$3,
             discount_mode=$4, transaction_discount_type=$5,
             transaction_discount_value=$6, transaction_discount_amount=$7,
             updated_at=NOW()
         WHERE id=$8`,
        [
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          discountMode, txDiscountType,
          txDiscountValue, txDiscountAmount.toFixed(2),
          id,
        ]
      );

      // Recompute paid status in case grand_total changed
      await _recalcStatus(client, id);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

module.exports = { listCustomerInvoices, exportCustomerInvoices, getCustomerInvoice, getCustomerInvoiceByToken, getCustomerInvoicePdf, addPayment, updatePayment, deletePayment, approveCustomerInvoice, updateCustomerInvoiceNotes, updateCustomerInvoiceExtras, generateCustomerInvoiceFromEstimate, syncCustomerInvoiceFromEstimate, getVehicleHistory, invoiceDatePreflight, updateInvoiceDate, invoiceDateCompliance };
