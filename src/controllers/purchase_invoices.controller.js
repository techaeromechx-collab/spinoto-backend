'use strict';
const crypto   = require('crypto');
const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { getRoundingFunction } = require('../utils/math');
const { applyTransactionDiscount } = require('../utils/transactionDiscount');
const { syncPayoutDueDate } = require('../utils/payoutSchedule');
const { generatePublicToken, resolveTokenToId } = require('../utils/publicToken');
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
const { istToday, validateInvoiceDate, validationError, financialYear } = require('../utils/invoiceDate');
const { buildSearchSql } = require('../utils/listSearch');
const { logActivity } = require('../services/activityLog.service');
const { hubScopeSql, assertHubOwns, isHubUser } = require('../utils/hubScope');
const { recalcHubInvoiceState } = require('../services/hubBalance.service');

// What the purchase-invoice search box looks at.
//
// The columns are listed as separate OR branches rather than wrapped in
// COALESCE(a.customer_name, est_ctx.customer_name). COALESCE hides the column
// from the planner, so no index on either table could ever be used; two plain
// branches let Postgres bitmap-OR the trigram indexes from migration 104.
// The behaviour is also slightly better — a job whose appointment and estimate
// carry different spellings of the name now matches either.
const PI_SEARCH = {
  textColumns: [
    'a.customer_name', 'est_ctx.customer_name',
    'a.mobile',        'est_ctx.mobile',
    'a.vehicle_number','est_ctx.vehicle_number',
  ],
  idColumn: 'pi.id',
  idPrefixes: ['pi', 'p'],
};

// Books lock + backdating window. Same one-row read as the other controllers.
async function loadDateSettings() {
  const r = await pool.query(
    `SELECT books_locked_through::text AS books_locked_through, backdate_max_days
       FROM company_settings ORDER BY id LIMIT 1`
  );
  return r.rows[0] || { books_locked_through: null, backdate_max_days: 30 };
}

// Route-level permission is handled by requirePermission; this is the
// finer-grained check inside a handler. Mirrors the middleware exactly,
// is_super_admin bypass included — same helper the invoice controllers use.
function hasPerm(req, code) {
  if (!req.user) return false;
  if (req.user.is_super_admin) return true;
  return !!req.user.permissions?.has(code);
}

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.code === '23505') {
      // Distinguish the real "one PI per estimate" conflict from the
      // astronomically-unlikely public_token collision, so the latter (if it
      // ever happens) doesn't surface a misleading error message.
      if (err.constraint === 'idx_purchase_invoices_public_token') {
        return res.status(409).json({ error: 'Could not generate a unique link for this invoice — please try again.' });
      }
      return res.status(409).json({ error: 'Purchase invoice already exists for this estimate' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

const PI_SELECT = `
  SELECT
    pi.id, pi.public_token, pi.estimate_id, est_ctx.public_token AS estimate_token, pi.appointment_id, pi.hub_id,
    est_ctx.warranty_claim_id,
    pi.commission_percent, pi.rate_mode, pi.status,
    pi.subtotal_ex_gst, pi.total_gst, pi.grand_total,
    pi.notes, pi.approved_by, pi.approved_at,
    pi.created_by, pi.created_at, pi.updated_at,
    -- Legal date of the PI (migration 099). ::text so pg-types 2.x can't
    -- parse the DATE into a local-midnight JS Date and shift it a day on an
    -- IST server. created_at stays as the system record — and stays what
    -- getRoundingFunction() keys off; see the comment at its call sites.
    pi.invoice_date::text AS invoice_date,
    pi.amount_paid,
    pi.payment_status,
    h.hub_name, h.gst_number AS hub_gst,
    -- Supplier identity for the document. The snapshot columns (migration 120)
    -- are authoritative; the live hubs join stays only so invoices raised
    -- before the snapshot existed still render. hub_state_name feeds the
    -- state-code fallback for a hub with no GSTIN.
    pi.hub_legal_name, pi.hub_address, pi.hub_gstin, pi.hub_has_gst,
    pi.supplier_state_code, pi.place_of_supply_code, pi.place_of_supply_name,
    pi.invoice_number,
    hub_state.name AS hub_state_name,
    -- Customer / vehicle context — from the linked appointment when present,
    -- otherwise from the linked estimate's own standalone columns.
    COALESCE(a.customer_name, est_ctx.customer_name)   AS customer_name,
    COALESCE(a.mobile, est_ctx.mobile)                 AS mobile,
    (SELECT public_token FROM customer_identities WHERE mobile = COALESCE(a.mobile, est_ctx.mobile)) AS customer_token,
    COALESCE(a.vehicle_number, est_ctx.vehicle_number) AS vehicle_number,
    u.name  AS created_by_name,
    ab.name AS approved_by_name,
    (SELECT id FROM customer_invoices ci WHERE ci.purchase_invoice_id = pi.id OR ci.estimate_id = pi.estimate_id LIMIT 1) AS customer_invoice_id,
    (SELECT ci.public_token FROM customer_invoices ci WHERE ci.purchase_invoice_id = pi.id OR ci.estimate_id = pi.estimate_id LIMIT 1) AS customer_invoice_token,
    (SELECT COUNT(*)::int FROM purchase_invoice_items pii WHERE pii.purchase_invoice_id = pi.id) AS item_count,

    -- Vehicle details
    vt.name   AS vehicle_type_name,
    vm.name   AS make_name,
    vmod.name AS model_name,
    bt.name   AS body_type_name,
    cc.name   AS cc_category_name,
    vmod.engine_cc,
    (SELECT string_agg(sg.name, ', ') FROM segments sg WHERE sg.id = ANY(COALESCE(a.segment_ids, est_ctx.segment_ids))) AS segment_names

  FROM purchase_invoices pi
  JOIN hubs h ON h.id = pi.hub_id
  LEFT JOIN states hub_state ON hub_state.id = h.state_id
  LEFT JOIN appointments   a    ON a.id    = pi.appointment_id
  LEFT JOIN estimates      est_ctx ON est_ctx.id = pi.estimate_id
  LEFT JOIN vehicle_types  vt   ON vt.id   = COALESCE(a.vehicle_type_id, est_ctx.vehicle_type_id)
  LEFT JOIN vehicle_makes  vm   ON vm.id   = COALESCE(a.make_id, est_ctx.make_id)
  LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, est_ctx.model_id)
  LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, est_ctx.body_type_id)
  LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, est_ctx.cc_category_id)
  LEFT JOIN users u  ON u.id  = pi.created_by
  LEFT JOIN users ab ON ab.id = pi.approved_by
`;

/**
 * Line items for a purchase invoice.
 *
 * ── THE MARGIN IS REDACTED FOR HUB LOGINS ───────────────────────────────────
 * `customer_rate` is what Spinoto charged the customer and `commission_percent`
 * is the take; `hub_rate` is what the hub is paid. The difference is the
 * company's margin on that hub's work.
 *
 * getPurchaseInvoicePdf and renderDocument.viewerRoleFor already go out of their
 * way to suppress exactly these two columns for a hub viewer, with a comment
 * saying why. This JSON endpoint handed them over anyway — so a hub partner with
 * devtools open on their own portal read, per line, what the customer paid
 * alongside what they get, ready for the next rate negotiation. The PDF being
 * careful is worth nothing while the API that renders it is not.
 *
 * Redacted rather than 403'd: a hub is entitled to its own invoice, just not to
 * the other side of it. `hub_rate`, `gst_amount` and `total_payable` — what the
 * hub is actually owed — stay.
 */
async function _getItems(purchaseInvoiceId, { forHub = false } = {}) {
  const r = await pool.query(
    `SELECT id, estimate_item_id, item_type, description, quantity,
            customer_rate, commission_percent, hub_rate,
            gst_percent, gst_amount, total_payable
     FROM purchase_invoice_items WHERE purchase_invoice_id = $1 ORDER BY id`,
    [purchaseInvoiceId]
  );
  if (!forHub) return r.rows;
  return r.rows.map(({ customer_rate, commission_percent, ...rest }) => rest);
}

async function _getHubPayments(purchaseInvoiceId) {
  const r = await pool.query(
    `SELECT hp.id, hp.amount, hp.method, hp.reference_no, hp.paid_at, hp.notes,
            hp.payment_batch_id,
            -- Set ⇒ this row was produced by a gateway transfer and cannot be
            -- deleted by hand. Returned so the UI hides the action rather than
            -- offering a button that 409s — see deleteHubPayment.
            hp.hub_payout_id,
            hpo.payout_ref, hpo.status AS payout_status, hpo.utr AS payout_utr,
            u.name AS created_by_name
     FROM hub_payments hp
     LEFT JOIN hub_payouts hpo ON hpo.id = hp.hub_payout_id
     LEFT JOIN users u ON u.id = hp.created_by
     WHERE hp.purchase_invoice_id = $1 ORDER BY hp.paid_at ASC`,
    [purchaseInvoiceId]
  );
  return r.rows;
}

/**
 * Is money already on its way to this invoice through the gateway?
 *
 * Recording a payment by hand while a transfer is in flight is how a hub gets
 * paid twice: the manual row settles the invoice, the payout confirms an hour
 * later and writes its own row, and the invoice is now overpaid with no obvious
 * culprit. The reverse ordering is guarded in payouts.service.js, which refuses
 * to start a payout on an invoice that already has one open.
 */
async function _openPayoutFor(db, purchaseInvoiceId) {
  const r = await db.query(
    `SELECT p.payout_ref
       FROM hub_payout_lines l
       JOIN hub_payouts p ON p.id = l.hub_payout_id
      WHERE l.purchase_invoice_id = $1
        AND p.status IN ('created','queued','processing')
      LIMIT 1`,
    [purchaseInvoiceId]);
  return r.rows[0]?.payout_ref || null;
}

async function _getPaymentSchedule(purchaseInvoiceId) {
  const r = await pool.query(
    `SELECT id, installment_no, amount_due, due_date, paid_amount, status
     FROM pi_payment_schedule WHERE purchase_invoice_id = $1 ORDER BY installment_no`,
    [purchaseInvoiceId]
  );
  return r.rows;
}

/**
 * Derives amount_paid, payment_status AND the installment waterfall.
 *
 * The body moved to services/hubBalance.service.js. It was written out longhand
 * in four handlers in this file, and gateway payouts would have made a fifth —
 * at which point the odds of all five staying identical are nil. They already
 * were not: bulkPayment recalculated the invoice but skipped the waterfall, so a
 * bulk payment against a split schedule left pi_payment_schedule showing
 * installments as unpaid that had in fact been paid. Routing every caller
 * through one function fixes that as a side effect of removing the duplication.
 *
 * Kept as a named wrapper rather than replacing the call sites, so the four
 * existing handlers read exactly as they did.
 */
async function _recalcHubPaymentStatus(client, purchaseInvoiceId) {
  return recalcHubInvoiceState(client, purchaseInvoiceId);
}


/**
 * GST on the hub's side of a purchase invoice.
 *
 * A purchase invoice IS the hub's sales invoice — the hub supplies, Spinoto
 * buys. A hub that is not GST-registered cannot charge tax and will not remit
 * it, so its document is a Bill of Supply and its payout must be the bare hub
 * amount.
 *
 * Until this existed, hubs.has_gst was never consulted anywhere in this file:
 * every line added gst_percent regardless, and grand_total — the figure hub
 * payments settle against — carried it. Unregistered hubs were being PAID that
 * tax, and any input credit claimed against them had no GSTIN to match.
 *
 * `hasGst !== false` on purpose: rows predating the snapshot column have NULL
 * and must keep behaving exactly as they do today. Only an explicit false
 * suppresses tax.
 */
function hubGst(hubAmount, gstPct, hasGst, roundFn) {
  if (hasGst === false) return 0;
  return roundFn(hubAmount * gstPct / 100);
}

/**
 * Claim the next number in this hub's own invoice series.
 *
 * A supplier's invoice numbers have to be consecutive within a financial year.
 * The old number was "SI-" + purchase_invoices.id — one global counter shared
 * by every hub — so a single hub's invoices read SI-000101, SI-000105,
 * SI-000123. An auditor reads those gaps as suppressed invoices, and the hub
 * cannot explain them, because they are other hubs' documents.
 *
 * Same mechanism as generateAppointmentCode (migration 084): one counter row
 * per (hub, period), claimed with INSERT … ON CONFLICT DO UPDATE … RETURNING,
 * so two concurrent approvals can never take the same number. Financial year
 * rather than month, because that is the period GST numbering is scoped to.
 *
 * Keyed on invoice_date, not created_at — a backdated invoice belongs to the
 * financial year of the supply.
 *
 * MUST be called on the approval transaction's client, so a rollback releases
 * the number instead of leaving a hole in the series.
 */
async function claimHubInvoiceNumber(client, { hubId, hubCode, invoiceDate }) {
  const fyStart = financialYear(invoiceDate);
  const fy = `${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}`; // 25-26

  const r = await client.query(
    `INSERT INTO hub_invoice_sequences (hub_id, financial_year, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (hub_id, financial_year)
     DO UPDATE SET last_seq = hub_invoice_sequences.last_seq + 1, updated_at = NOW()
     RETURNING last_seq`,
    [hubId, fy]
  );
  const seq = r.rows[0].last_seq;
  // hub_code can legitimately be null on an old hub that predates migration
  // 084; 'HUB' keeps the series well-formed rather than producing "/25-26/1".
  return `${hubCode || 'HUB'}/${fy}/${String(seq).padStart(4, '0')}`;
}

/**
 * Hub tenancy guard for the purchase-invoice write paths.
 *
 * Costs one extra round trip, and only on hub-portal requests — for staff and
 * super admins it returns immediately. Throws 404 (not 403) so ids can't be
 * enumerated by status code.
 */
async function _assertPiHub(req, id, db = pool) {
  if (!req.user?.hub_id) return;
  const r = await db.query(`SELECT hub_id FROM purchase_invoices WHERE id = $1`, [id]);
  assertHubOwns(req, r.rows[0], 'hub_id', 'Purchase invoice');
}

function listPurchaseInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const conditions = [], params = [];

    // Hub-portal logins are pinned to their own hub. This list previously had
    // no scoping of ANY kind — not a hub check, not the permission tier the
    // other list endpoints carry — so whatever ?hub_ids= the client sent was
    // the entire filter, and omitting it returned every hub's payouts, rates
    // and commission. Deliberately still no permission tier for staff: adding
    // one here would change admin behaviour, which this change must not do.
    const hubScope = hubScopeSql(req, params, 'pi.hub_id');
    if (hubScope) conditions.push(hubScope);

    const searchSql = buildSearchSql({ search: req.query.search, params, ...PI_SEARCH });
    if (searchSql) conditions.push(searchSql);
    if (!hubScope && req.query.hub_ids) {
      const ids = req.query.hub_ids.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`pi.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`pi.hub_id = $${params.length}`);
    }
    if (req.query.status)  { params.push(req.query.status);          conditions.push(`pi.status = $${params.length}`); }
    if (req.query.vehicle_type) {
      // Match either via the linked appointment's vehicle type, or (for
      // standalone estimates with no appointment) the estimate's own
      // vehicle_type_id column.
      if (req.query.vehicle_type === '2W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = pi.appointment_id AND vt.name ILIKE '%2%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = pi.estimate_id AND vt.name ILIKE '%2%')
        )`);
      } else if (req.query.vehicle_type === '4W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = pi.appointment_id AND vt.name ILIKE '%4%')
          OR EXISTS (SELECT 1 FROM estimates e JOIN vehicle_types vt ON vt.id = e.vehicle_type_id WHERE e.id = pi.estimate_id AND vt.name ILIKE '%4%')
        )`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [dataRes, countRes] = await Promise.all([
      pool.query(`${PI_SELECT} ${where} ORDER BY pi.invoice_date DESC, pi.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      // Sums ride along on the count query — same WHERE, same scan, no third
      // statement. The joins stay because the search condition references
      // a.* and est_ctx.* columns; they are LEFT joins on unique keys, so they
      // cannot duplicate a pi row and inflate the totals.
      pool.query(
        `SELECT COUNT(*)                             AS count,
                COALESCE(SUM(pi.grand_total), 0)     AS sum_total,
                COALESCE(SUM(pi.amount_paid), 0)     AS sum_paid,
                COALESCE(SUM(GREATEST(pi.grand_total - pi.amount_paid, 0)), 0) AS sum_due
           FROM purchase_invoices pi
           LEFT JOIN appointments a ON a.id = pi.appointment_id
           LEFT JOIN estimates est_ctx ON est_ctx.id = pi.estimate_id ${where}`,
        params
      ),
    ]);
    const c = countRes.rows[0];
    res.json({
      items: dataRes.rows,
      total: parseInt(c.count, 10),
      // Money owed TO the hubs, not to us. Clamped per invoice by the
      // SUM(GREATEST(...)) above, for the same reason as on customer invoices:
      // one over-paid hub must not mask what the others are still owed.
      totals: {
        amount: parseFloat(c.sum_total),
        paid:   parseFloat(c.sum_paid),
        due:    parseFloat(c.sum_due),
      },
      page, limit,
    });
  });
}

function getPurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const item = r.rows[0];
    // Scoping the list is not enough — this is the highest-value record in the
    // system to read across tenants (hub rates, commission, amounts paid), and
    // ids are sequential. 404 rather than 403 so the status code isn't an
    // existence oracle. Covers /by-token/:token, which delegates here.
    assertHubOwns(req, item, 'hub_id', 'Purchase invoice');
    // isHubUser, not a permission check: a hub login can legitimately hold
    // VIEW_INVOICE, so the question is who is asking, not what they may do.
    item.items        = await _getItems(id, { forHub: isHubUser(req) });
    item.hub_payments = await _getHubPayments(id);
    item.schedule     = await _getPaymentSchedule(id);
    res.json({ item });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchase-invoices/:id/pdf?theme=xxx
//
// Renders the purchase invoice through the shared themed-document pipeline.
//
// ⚠ The viewer role is derived from the authenticated session inside
// resolveRender() — never from a query parameter. A hub user always gets the
// hub view, in which the customer-rate and commission columns are suppressed
// and the document reads as a sale ("SELL INVOICE", "Grand Total Receivable").
// Letting the client choose the role here would expose the margin the company
// takes on that hub's work.
// ─────────────────────────────────────────────────────────────────────────────
function getPurchaseInvoicePdf(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const invoice = r.rows[0];
    // The hub view suppresses the margin columns, but it must still be THIS
    // hub's invoice — otherwise a hub could read another hub's agreed rates.
    assertHubOwns(req, invoice, 'hub_id', 'Purchase invoice');
    invoice.items        = await _getItems(id, { forHub: isHubUser(req) });
    invoice.hub_payments = await _getHubPayments(id);

    const company = await loadCompany();
    const { cfg, theme, viewerRole } = resolveRender(company, 'purchase_invoice', req.user, {
      themeOverride: req.query.theme,
    });

    await sendPdf(res, {
      docType: 'purchase_invoice', row: invoice, company, cfg, theme,
      baseUrl: req.get('origin') || req.get('referer'),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchase-invoices/by-token/:token — resolves a public_token
// (used in shareable /purchase-invoices/:token URLs) to the numeric id,
// then delegates to the exact same logic as GET /api/purchase-invoices/:id.
// ─────────────────────────────────────────────────────────────────────────────
function getPurchaseInvoiceByToken(req, res, next) {
  handle(req, res, next, async () => {
    const id = await resolveTokenToId(pool, 'purchase_invoices', req.params.token);
    if (!id) return res.status(404).json({ error: 'Purchase invoice not found' });
    req.params.id = String(id);
    return getPurchaseInvoice(req, res, next);
  });
}

function generatePurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const { estimate_id, invoice_date } = z.object({
      estimate_id: z.coerce.number().int().positive(),
      // Optional, and absent by default. See the PI date block below for why
      // this exists rather than a cleverer default.
      invoice_date: z.string().trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD').optional(),
    }).parse(req.body);

    // Validate estimate
    const estRow = await pool.query(
      `SELECT e.id, e.status, e.appointment_id, e.hub_id,
              e.discount_mode, e.transaction_discount_type, e.transaction_discount_value,
              e.warranty_claim_id,
              -- Inherit the date when the estimate was deliberately backdated:
              -- the job is historical, so the hub's bill belongs on the same
              -- day. A merely OLD estimate (never backdated) means the work has
              -- just finished, and today is right — original_estimate_date is
              -- what tells the two apart. See PLAN_backdated_job_chain.md §2.1.
              e.estimate_date::text AS estimate_date,
              e.original_estimate_date
       FROM estimates e WHERE e.id = $1`, [estimate_id]
    );
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const est = estRow.rows[0];

    // ── PI date ─────────────────────────────────────────────────────────────
    // Inherited from a deliberately-backdated estimate, else today. See the
    // comment on the SELECT above.
    //
    // This is VALIDATED, not just assigned. Skipping validation here created a
    // dead end: the PI would happily take a date the CI's validator later
    // refuses, leaving a job with a purchase invoice that can never be turned
    // into a customer invoice, and no endpoint to correct the PI's date.
    // An explicit date always wins. It exists because the inference below
    // cannot tell two real situations apart, and guessing wrong on either is
    // worse than asking:
    //
    //   (a) estimate written 1 Aug, work done 1 Aug, paperwork entered 3 Aug
    //         → the hub's bill belongs on 1 Aug
    //   (b) estimate written 1 Aug, car sat, work finished 3 Aug
    //         → the hub's bill belongs on 3 Aug
    //
    // Both have an old estimate and neither was backdated, so the stored data
    // is identical. The default stays (b) — TODAY — deliberately: getting (a)
    // wrong leaves a PI dated late, which is visible and can be pulled back by
    // a customer-invoice date change, whereas getting (b) wrong silently
    // backdates a hub's bill, possibly into a closed period, with nobody having
    // asked for it. The recoverable error is the one to default to.
    const piToday = istToday();
    const piInherited = !!est.original_estimate_date && est.estimate_date !== piToday;
    const piChosen = !!invoice_date;
    const piInvoiceDate = invoice_date || (piInherited ? est.estimate_date : piToday);

    if (piInvoiceDate !== piToday) {
      const settings = await loadDateSettings();
      const check = validateInvoiceDate({
        invoiceDate: piInvoiceDate,
        documentType: 'purchase_invoice',
        chainBefore: est.estimate_date,
        settings,
        // Inherited, not chosen: whoever backdated the ESTIMATE already held
        // the permission and gave a reason, so making the person who generates
        // the PI hold it too would block the flow for a date they never set.
        // CHOSEN here is the opposite case — this caller is the one picking a
        // past date, so this caller needs the permission.
        canBackdate: piChosen ? hasPerm(req, 'BACKDATE_INVOICE') : true,
        canOverride: piChosen ? false : true,
        today: piToday,
      });
      if (!check.ok) {
        return res.status(409).json({
          ...validationError(check),
          // Point at the thing the caller can actually change. When the date was
          // inherited that is the estimate; when they typed it, it is the date
          // they typed, and telling them to go fix the estimate would send them
          // to edit a document that is not wrong.
          error: piChosen
            ? `${piInvoiceDate} cannot be used for this purchase invoice: ${check.errors[0]?.message}`
            : `The estimate's date (${est.estimate_date}) cannot be used for this purchase invoice: ` +
              `${check.errors[0]?.message} Correct the estimate's date first.`,
        });
      }
    }

    // Hub users can only generate invoices for their own hub
    if (req.user.hub_id && req.user.hub_id !== est.hub_id) {
      return res.status(403).json({ error: 'You can only generate invoices for your own hub' });
    }

    if (est.status !== 'work_completed') {
      return res.status(400).json({ error: `Estimate must be work_completed to generate invoice (current: ${est.status})` });
    }

    // Fetch hub rates — commission takes priority over tech rates.
    // Also the supplier identity: this document is the hub's tax invoice, so
    // its name, address, GSTIN and registration state are snapshotted onto the
    // invoice row (migration 120) rather than joined live at render. A hub
    // that moves premises or corrects its GSTIN must not rewrite invoices it
    // has already been given.
    const hubRow = await pool.query(
      `SELECT h.commission_percent, h.tech_rate_service, h.tech_rate_parts,
              h.has_gst, h.gst_number, h.hub_name, h.company_name,
              h.address_line1, h.address_line2, h.pincode,
              c.name AS city_name, st.name AS state_name
         FROM hubs h
         LEFT JOIN cities c  ON c.id  = h.city_id
         LEFT JOIN states st ON st.id = h.state_id
        WHERE h.id = $1`,
      [est.hub_id]
    );
    const hub = hubRow.rows[0] || {};
    const hubHasGst = hub.has_gst === true;
    const hubGstin  = (hub.gst_number || '').trim() || null;
    // One text blob, pre-joined, for the same reason the rest is snapshotted:
    // reassembling it later from four columns re-introduces the live-join
    // problem it exists to avoid.
    const hubAddress = [
      hub.address_line1, hub.address_line2,
      [hub.city_name, hub.state_name, hub.pincode].filter(Boolean).join(', '),
    ].filter(v => v && String(v).trim()).join('\n') || null;
    // The registered state comes from the GSTIN's leading two digits — that is
    // what the tax office sees, and it needs no address data to resolve.
    const hubStateCode = hubGstin && /^\d{2}/.test(hubGstin) ? hubGstin.slice(0, 2) : null;
    const commissionPct      = hub.commission_percent != null ? Number(hub.commission_percent) : null;
    const techRateService    = hub.tech_rate_service  != null ? Number(hub.tech_rate_service)  : null;
    const techRateParts      = hub.tech_rate_parts    != null ? Number(hub.tech_rate_parts)    : null;

    // Priority rule: if commission_percent is set (> 0), use commission mode
    // Otherwise use tech rate mode (service rate for services, parts rate for parts)
    const useCommission = commissionPct != null && commissionPct > 0;
    const rateMode      = useCommission ? 'commission' : 'tech_rate';

    // Fetch eligible items (customer approved + work completed)
    const itemsRow = await pool.query(
      `SELECT * FROM estimate_items WHERE estimate_id = $1 AND customer_approved = true AND work_status = 'completed'`,
      [estimate_id]
    );
    if (itemsRow.rowCount === 0) return res.status(400).json({ error: 'No completed approved items found in this estimate' });

    // Transaction-level discount: distribute proportionally across items by inc-GST amount
    // Formula: x = txDiscount / (totalIncGst / 100)
    //          item_discount = (item_total_inc_gst / 100) * x
    //                        = (item_total_inc_gst / totalIncGst) * txDiscount
    const txDiscountMode  = est.discount_mode || 'none';
    const txDiscountType  = est.transaction_discount_type || 'percent';
    const txDiscountValue = parseFloat(est.transaction_discount_value) || 0;

    const roundFn = getRoundingFunction(new Date());

    /* ── The customer's discounted EX-GST value, line by line ─────────────
       This used to apportion the discount across the items by their inclusive
       amounts and then divide the GST back out. That matched the old rule,
       where a transaction discount came off the inclusive total.

       It no longer does: the discount reduces the TAXABLE value and the tax
       follows it down (see utils/transactionDiscount.js). The hub's share is
       derived from the customer's rate, so the basis has to move with it — a
       purchase invoice computed on the old rule would pay the hub a share of a
       customer value that was never charged.

       The same helper the estimate and the customer invoice use, so all three
       documents for one job agree by construction rather than by three
       separate authors reaching the same answer. */
    const custTotals = applyTransactionDiscount({
      items:         itemsRow.rows,
      discountType:  txDiscountMode === 'transaction' ? txDiscountType : null,
      discountValue: txDiscountMode === 'transaction' ? txDiscountValue : 0,
      roundFn,
    });

    // Warranty redo: the claim's cost_bearer decides who pays for the redo.
    //   'hub'     → hub did faulty work, redo is on them: hub payable forced to ₹0
    //   'company' → goodwill: hub is paid on the ORIGINAL item's rate, since the
    //               redo estimate's customer rate is ₹0 (or a partial charge)
    let redoCostBearer = null, redoBasisRate = null;
    if (est.warranty_claim_id) {
      const claimRow = await pool.query(
        `SELECT wc.cost_bearer, cii.customer_rate AS orig_rate
           FROM warranty_claims wc
           LEFT JOIN customer_invoice_items cii ON cii.id = wc.customer_invoice_item_id
          WHERE wc.id = $1`, [est.warranty_claim_id]
      );
      if (claimRow.rows[0]) {
        redoCostBearer = claimRow.rows[0].cost_bearer;
        redoBasisRate  = claimRow.rows[0].orig_rate != null ? Number(claimRow.rows[0].orig_rate) : null;
      }
    }

    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const items = itemsRow.rows.map((item, idx) => {
      const qty    = Number(item.quantity);
      const gstPct = Number(item.gst_percent);

      /* custRate = the customer's post-discount EX-GST value, per unit.
         Taken straight from the shared calculation above — the line-item
         discount is already inside total_inc_gst, and the transaction
         discount's share of this line has been taken off the taxable value
         there. No dividing GST back out: the figure is already ex-GST. */
      const custRate = qty > 0 ? roundFn(custTotals.lines[idx].taxable / qty, 4) : 0;

      // Rate basis: normally the customer rate; for company-borne warranty
      // redos, the original item's rate (the redo's customer rate is ~₹0).
      const basisRate = (redoCostBearer === 'company' && redoBasisRate != null)
        ? roundFn(redoBasisRate, 4)
        : custRate;

      let appliedRatePct; // the % stored per-item for audit trail
      let hubRate;

      if (useCommission) {
        // Commission mode: hub earns (100 - commission)% of customer rate
        appliedRatePct = commissionPct;
        hubRate        = roundFn(basisRate * (1 - commissionPct / 100), 4);
      } else {
        // Tech rate mode: tech_rate% is deducted from customer rate (platform fee)
        // Hub earns: customer_rate - (customer_rate × tech_rate%)
        const isService    = item.item_type === 'service';
        const techRate     = isService ? (techRateService ?? 0) : (techRateParts ?? 0);
        appliedRatePct     = techRate;
        const techDeduct   = roundFn(basisRate * (techRate / 100), 4);
        hubRate            = roundFn(basisRate - techDeduct, 4);
      }

      // Hub-borne warranty redo: the hub eats the redo cost entirely
      if (redoCostBearer === 'hub') hubRate = 0;

      const hubAmount    = roundFn(hubRate * qty);
      const techDeductAmt = roundFn(basisRate * qty) - hubAmount; // deduction for display
      const gstAmount    = hubGst(hubAmount, gstPct, hubHasGst, roundFn);
      const totalPayable = roundFn(hubAmount + gstAmount);

      subtotalExGst += hubAmount;
      totalGst      += gstAmount;
      grandTotal    += totalPayable;

      return { ...item, custRate, hubRate, appliedRatePct, techDeductAmt, gstAmount, totalPayable };
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const piRow = await client.query(
        `INSERT INTO purchase_invoices
           (estimate_id, appointment_id, hub_id, commission_percent, rate_mode,
            subtotal_ex_gst, total_gst, grand_total, created_by, public_token,
            invoice_date, original_invoice_date, backdate_reason, backdated_by, backdated_at,
            updated_by,
            -- Supplier identity frozen at issue (migration 120). Never
            -- re-derived from hubs afterwards.
            hub_legal_name, hub_address, hub_gstin, hub_has_gst, supplier_state_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 $11::date, $12::date, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21) RETURNING id`,
        [
          estimate_id, est.appointment_id, est.hub_id,
          useCommission ? commissionPct : 0,      // 0 when using tech_rate mode — column is NOT NULL
          rateMode,
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          req.user?.id || null,
          generatePublicToken(),
          piInvoiceDate,
          piInherited ? piToday : null,
          piInherited ? `Inherited from backdated estimate #${estimate_id}` : null,
          piInherited ? (req.user?.id || null) : null,
          piInherited ? new Date() : null,
          req.user?.id || null,
          (hub.company_name || '').trim() || hub.hub_name || null,
          hubAddress,
          hubGstin,
          hubHasGst,
          hubStateCode,
        ]
      );
      const piId = piRow.rows[0].id;

      for (const item of items) {
        await client.query(
          `INSERT INTO purchase_invoice_items
             (purchase_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, commission_percent, hub_rate,
              gst_percent, gst_amount, total_payable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            piId, item.id, item.item_type, item.description,
            item.quantity, item.custRate,  // post-discount ex-GST (= customer_rate when no discount)
            item.appliedRatePct ?? 0,   // stores commission% or tech_rate% — NOT NULL so fallback to 0
            item.hubRate,
            item.gst_percent, item.gstAmount, item.totalPayable,
          ]
        );
      }
      await client.query('COMMIT');
      const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [piId]);
      full.rows[0].items = await _getItems(piId);
      res.status(201).json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function approvePurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertPiHub(req, id);

    // Allow optional payout_schedule + per-item rate overrides at approval time
    const { payout_schedule, item_rates } = z.object({
      payout_schedule: z.enum(['lump_sum', 'split']).default('lump_sum'),
      item_rates: z.array(z.object({
        item_id:   z.number().int(),
        take_rate: z.number().min(0).max(100),
      })).optional().default([]),
    }).parse(req.body || {});

    const r = await pool.query(
      `SELECT pi.status, pi.grand_total, pi.hub_id, pi.appointment_id, pi.rate_mode, pi.hub_has_gst,
              pi.created_at
       FROM purchase_invoices pi
       WHERE pi.id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = r.rows[0];
    // created_at, NOT invoice_date — this selects the rounding mode off a
    // hardcoded cutover date (utils/math.js). Keyed to a backdatable field
    // it would silently change the totals of an already-issued document.
    const roundFn = getRoundingFunction(pi.created_at);
    if (pi.status !== 'pending_approval') {
      return res.status(400).json({ error: `Invoice is already ${pi.status}` });
    }

    // payout_due_date is NOT set here anymore — it's driven by the linked CI's
    // payment (next Tuesday after the customer pays in full), not approval
    // date. Stays NULL until syncPayoutDueDate() fills it in below or later
    // from customer_invoices._recalcStatus(). See utils/payoutSchedule.js.

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Claim this invoice before doing anything with it ─────────────────
      //
      // The status was already checked above — on `pool`, outside this
      // transaction, with no lock. That check cannot be trusted here, and the
      // gap between it and this line is where the bug lived.
      //
      // Two approvals of the same purchase invoice racing — two staff on
      // separate sessions, or one impatient retry after a slow response —
      // BOTH passed that unlocked check. Both then reached
      // claimHubInvoiceNumber, which is itself atomic, so each was handed a
      // DIFFERENT number out of the hub's sequence. The final write used
      // COALESCE, so the invoice kept only the first and never showed a
      // duplicate — and the second number was attached to nothing at all.
      //
      // A burned number is a GAP in that hub's consecutive per-financial-year
      // series, which is precisely what migration 121 exists to prevent:
      //
      //   "Gaps are exactly what a GST audit questions, because a missing
      //    number looks like a suppressed invoice."
      //
      // FOR UPDATE makes the second request wait here rather than race. By the
      // time it acquires the row, the first has committed and the status is no
      // longer 'pending_approval', so it stops below — before claiming a
      // number rather than after.
      //
      // The frontend's disabled button is not a substitute: it only guards one
      // tab, and does nothing about a second session or a retried request.
      const locked = await client.query(
        `SELECT status FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [id]);

      if (!locked.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Purchase invoice not found' });
      }
      if (locked.rows[0].status !== 'pending_approval') {
        await client.query('ROLLBACK');
        // Deliberately the same message and status the pre-flight check gives,
        // so whoever lost the race sees the ordinary "already approved" answer
        // rather than something that reads like a fault.
        return res.status(400).json({ error: `Invoice is already ${locked.rows[0].status}` });
      }

      // ── Recalculate per-item rates if provided ───────────────────────────
      if (item_rates.length > 0) {
        // Build a map of item_id -> take_rate for quick lookup
        const rateMap = {};
        item_rates.forEach(r => { rateMap[r.item_id] = r.take_rate; });

        const itemsRow = await client.query(
          `SELECT id, quantity, customer_rate, gst_percent FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [id]
        );

        let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
        for (const item of itemsRow.rows) {
          // Only recalculate items that have a rate override
          if (rateMap[item.id] == null) continue;

          const qty      = Number(item.quantity);
          const custRate = Number(item.customer_rate);
          const gstPct   = Number(item.gst_percent);
          const takeRate = rateMap[item.id];

          // Same formula as existing recalculate: hub_rate = customer_rate - (customer_rate × take_rate%)
          const techDeduct = roundFn(custRate * (takeRate / 100), 4);
          const hubRate    = roundFn(custRate - techDeduct, 4);
          const hubAmount  = roundFn(hubRate * qty);
          const gstAmt     = hubGst(hubAmount, gstPct, pi.hub_has_gst, roundFn);
          const total      = roundFn(hubAmount + gstAmt);

          subtotalExGst += hubAmount;
          totalGst      += gstAmt;
          grandTotal    += total;

          await client.query(
            `UPDATE purchase_invoice_items
             SET hub_rate=$1, commission_percent=$2, gst_amount=$3, total_payable=$4
             WHERE id=$5`,
            [hubRate, takeRate, gstAmt, total, item.id]
          );
        }

        // For items not in rateMap, add their existing totals to PI totals
        for (const item of itemsRow.rows) {
          if (rateMap[item.id] != null) continue;
          const existing = await client.query(
            `SELECT hub_rate, quantity, gst_amount, total_payable FROM purchase_invoice_items WHERE id=$1`, [item.id]
          );
          const ex = existing.rows[0];
          if (ex) {
            subtotalExGst += parseFloat(ex.hub_rate) * Number(ex.quantity);
            totalGst      += parseFloat(ex.gst_amount);
            grandTotal    += parseFloat(ex.total_payable);
          }
        }

        await client.query(
          `UPDATE purchase_invoices SET subtotal_ex_gst=$1, total_gst=$2, grand_total=$3 WHERE id=$4`,
          [subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2), id]
        );
        pi.grand_total = grandTotal;
      }

      /* A ₹0 PI has nothing to pay out, and says so.
         It is NOT marked 'paid' — that was the old behaviour and it was a lie
         with consequences: every downstream guard reads 'paid' as "money left
         the bank" and refused to let the invoice be edited or synced, so a PI
         that came to zero (every line at 100% commission, not only the
         hub-borne warranty redo this was written for) was frozen the moment it
         was approved. Migration 174 has the full account.

         'not_required' keeps the original purpose — the payouts queue lists
         status='approved' AND payment_status NOT IN ('paid','not_required'), so
         a nil invoice still never lingers there.

         NOTE: this lives in payment_status, NOT status — the status column's
         CHECK only allows pending_approval/approved/cancelled. */
      const zeroPayable = parseFloat(pi.grand_total) <= 0.011;

      // The hub's invoice number is claimed HERE, at approval — not at
      // generation. A draft that is rejected must not burn a number, and a
      // supplier's series cannot have holes.
      //
      // COALESCE on the write: re-approving an invoice that already carries a
      // number must never reassign it. Once a number is on a document the hub
      // has been given, and possibly filed, it is fixed.
      const piMeta = (await client.query(
        `SELECT pi.invoice_number, pi.invoice_date::text AS invoice_date, h.hub_code
           FROM purchase_invoices pi JOIN hubs h ON h.id = pi.hub_id
          WHERE pi.id = $1`, [id]
      )).rows[0] || {};
      const invoiceNumber = piMeta.invoice_number
        || await claimHubInvoiceNumber(client, {
             hubId: pi.hub_id,
             hubCode: piMeta.hub_code,
             invoiceDate: piMeta.invoice_date || istToday(),
           });

      // `AND status = 'pending_approval'` as well as the lock above. The lock
      // is what actually prevents the race; this is the assertion that says so
      // in the SQL, and it is what would catch a future edit that moves the
      // lock, drops it, or adds a second path into this write.
      //
      // COALESCE stays: it is now unreachable as a duplicate-guard, but it
      // also protects an invoice that somehow already carries a number from
      // having it rewritten, which is a different and still-worth-having
      // property.
      const approved = await client.query(
        `UPDATE purchase_invoices
         SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW(),
             payout_due_date=NULL, payout_schedule=$2,
             payment_status=$4,
             invoice_number = COALESCE(invoice_number, $5)
         WHERE id=$3 AND status = 'pending_approval'`,
        [req.user?.id || null, payout_schedule, id, zeroPayable ? 'not_required' : 'pending', invoiceNumber]
      );

      if (!approved.rowCount) {
        // Unreachable while the lock above is in place. If it ever fires, the
        // right thing is to abandon the transaction — which also releases the
        // sequence number claimed a few lines up, since claiming it was part
        // of this transaction and rolls back with it.
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Invoice was approved by someone else. Reload and try again.' });
      }

      // If split: create 3 equal installments (1/3 each). due_date starts
      // NULL — filled in once the linked CI is fully paid (see below).
      if (payout_schedule === 'split') {
        const total      = parseFloat(pi.grand_total);
        const perInstall = roundFn(total / 3);
        // Adjust last installment for rounding difference
        const installments = [
          { no: 1, amount: perInstall },
          { no: 2, amount: perInstall },
          { no: 3, amount: roundFn(total - perInstall * 2) },
        ];
        for (const inst of installments) {
          await client.query(
            `INSERT INTO pi_payment_schedule
               (purchase_invoice_id, installment_no, amount_due, due_date)
             VALUES ($1, $2, $3, NULL)`,
            [id, inst.no, inst.amount]
          );
        }
      }

      // Covers the case where the customer already fully paid the CI before
      // this PI got approved — sets the due date immediately instead of
      // waiting for a CI payment event that already happened.
      await syncPayoutDueDate(client, { purchaseInvoiceId: id });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items         = await _getItems(id);
    full.rows[0].hub_payments  = await _getHubPayments(id);
    full.rows[0].schedule      = await _getPaymentSchedule(id);

    // NOTE: appointment is NOT closed here anymore.
    // Closed happens when the Customer Invoice is fully paid.

    res.json({ item: full.rows[0] });
  });
}

function addHubPayment(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    await _assertPiHub(req, id);
    const data = z.object({
      amount:       z.coerce.number().positive(),
      method:       z.enum(['cash','upi','card','bank_transfer','other','app_payment']).default('bank_transfer'),
      reference_no: z.string().trim().max(100).optional().nullable(),
      // Was a bare z.string(): any text at all, so a hub payment could be
      // dated 2019 or 2099 and nothing stopped it. The UI never sent the field,
      // which is the only reason it never bit — but the edit endpoint below
      // makes this reachable, and a strict edit beside a wide-open create is
      // worse than neither. Same shape the customer-invoice side enforces.
      paid_at:      z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'paid_at must be YYYY-MM-DD').optional().nullable(),
      notes:        z.string().trim().max(500).optional().nullable(),
    }).parse(req.body);

    const piRow = await pool.query(
      `SELECT status, payment_status, grand_total, amount_paid, hub_id FROM purchase_invoices WHERE id = $1`, [id]
    );
    if (!piRow.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = piRow.rows[0];
    if (pi.status !== 'approved') {
      return res.status(400).json({ error: 'Can only record payments against approved purchase invoices' });
    }
    /* A nil invoice is refused with its own sentence. It would be refused two
       lines below anyway (balance is 0, so any amount exceeds it), but
       "Payment ₹500 exceeds outstanding balance ₹0.00" describes the arithmetic
       rather than the situation. */
    if (parseFloat(pi.grand_total) <= 0.011) {
      return res.status(400).json({ error: 'This invoice comes to ₹0 — there is nothing to pay.' });
    }
    if (pi.payment_status === 'paid') {
      return res.status(400).json({ error: 'Purchase invoice is already fully paid' });
    }
    const balance = parseFloat(pi.grand_total) - parseFloat(pi.amount_paid);
    if (data.amount > balance + 0.01) {
      return res.status(400).json({ error: `Payment ₹${data.amount} exceeds outstanding balance ₹${balance.toFixed(2)}` });
    }

    // Money already on its way through the gateway.
    //
    // Recording a payment by hand now settles the invoice, and the transfer
    // confirms an hour later and writes its own row — the hub has been paid
    // twice and the ledger shows an overpayment nobody can attribute. The
    // mirror-image guard (starting a payout on an invoice that already has one
    // open) lives in payouts.service.js, under a row lock.
    const inFlight = await _openPayoutFor(pool, id);
    if (inFlight) {
      return res.status(409).json({
        error: `A bank transfer (${inFlight}) is already on its way for this invoice. `
             + `Wait for it to finish, or refresh it on the Payouts screen, before recording a payment by hand.`,
      });
    }

    // Same rules the edit endpoint applies, so a date that cannot be set by
    // editing cannot be smuggled in at creation either.
    if (data.paid_at) {
      const invRow = await pool.query(`SELECT invoice_date::text AS invoice_date FROM purchase_invoices WHERE id = $1`, [id]);
      const bad = await checkHubPaymentDate(data.paid_at, { invoiceDate: invRow.rows[0]?.invoice_date });
      if (bad) return res.status(409).json(bad);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO hub_payments (purchase_invoice_id, hub_id, amount, method, reference_no, paid_at, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),$7,$8)`,
        [id, pi.hub_id, data.amount, data.method, data.reference_no||null,
         data.paid_at||null, data.notes||null, req.user?.id||null]
      );
      // Recalculates amount_paid, payment_status and the split-installment
      // waterfall in one place — see hubBalance.service.js.
      await _recalcHubPaymentStatus(client, id);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);

    // The counterpart to the DELETE log — a trail that only records removals
    // tells you a payment vanished but not that it ever arrived.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'hub_payment',
      entityId: id,
      description:
        `Hub payment recorded on PI-${String(id).padStart(6, '0')}: ` +
        `₹${Number(data.amount).toFixed(2)} via ${data.method}` +
        (data.reference_no ? ` (ref ${data.reference_no})` : '') +
        ` — invoice now ${full.rows[0].payment_status}`,
    });

    res.status(201).json({ item: full.rows[0] });
  });
}

function recalculatePurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // Fetch the invoice
    const piRow = await pool.query(
      `SELECT pi.id, pi.rate_mode, pi.hub_id, pi.created_at, pi.hub_has_gst FROM purchase_invoices pi WHERE pi.id = $1`, [id]
    );
    if (!piRow.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    assertHubOwns(req, piRow.rows[0], 'hub_id', 'Purchase invoice');
    const pi = piRow.rows[0];

    if (pi.rate_mode !== 'tech_rate') {
      return res.status(400).json({ error: 'Recalculate only applies to Tech Rate mode invoices' });
    }

    // Fetch hub tech rates
    const hubRow = await pool.query(
      `SELECT tech_rate_service, tech_rate_parts FROM hubs WHERE id = $1`, [pi.hub_id]
    );
    const hub             = hubRow.rows[0] || {};
    const techRateService = hub.tech_rate_service != null ? Number(hub.tech_rate_service) : 0;
    const techRateParts   = hub.tech_rate_parts   != null ? Number(hub.tech_rate_parts)   : 0;

    // Fetch all items for this invoice
    const itemsRow = await pool.query(
      `SELECT id, item_type, quantity, customer_rate, gst_percent FROM purchase_invoice_items WHERE purchase_invoice_id = $1`,
      [id]
    );

    // created_at, NOT invoice_date — this selects the rounding mode off a
    // hardcoded cutover date (utils/math.js). Keyed to a backdatable field
    // it would silently change the totals of an already-issued document.
    const roundFn = getRoundingFunction(pi.created_at);

    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const updatedItems = itemsRow.rows.map(item => {
      const qty      = Number(item.quantity);
      const custRate = Number(item.customer_rate);
      const gstPct   = Number(item.gst_percent);

      const isService  = item.item_type === 'service';
      const techRate   = isService ? techRateService : techRateParts;
      const techDeduct = roundFn(custRate * (techRate / 100), 4);
      const hubRate    = roundFn(custRate - techDeduct, 4);

      const hubAmount    = roundFn(hubRate * qty);
      // Snapshot on the row, not hubs.has_gst — a hub that registered after this
      // invoice was raised must not make it grow a tax line now.
      const gstAmount    = hubGst(hubAmount, gstPct, piRow.rows[0].hub_has_gst, roundFn);
      const totalPayable = roundFn(hubAmount + gstAmount);

      subtotalExGst += hubAmount;
      totalGst      += gstAmount;
      grandTotal    += totalPayable;

      return { id: item.id, hubRate, techRate, gstAmount, totalPayable };
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const item of updatedItems) {
        await client.query(
          `UPDATE purchase_invoice_items
           SET hub_rate=$1, commission_percent=$2, gst_amount=$3, total_payable=$4
           WHERE id=$5`,
          [item.hubRate, item.techRate, item.gstAmount, item.totalPayable, item.id]
        );
      }

      await client.query(
        `UPDATE purchase_invoices
         SET subtotal_ex_gst=$1, total_gst=$2, grand_total=$3, updated_at=NOW()
         WHERE id=$4`,
        [subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2), id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);
    res.json({ item: full.rows[0] });
  });
}

function deleteHubPayment(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const payId = idParam.parse(req.params.payId);

    await _assertPiHub(req, id);

    const client = await pool.connect();
    let deleted = null;
    try {
      await client.query('BEGIN');

      // The DELETE is INSIDE the transaction. It used to run on the pool first,
      // with the recalc in a separate transaction afterwards — so if the recalc
      // threw, the payment row was already gone while purchase_invoices.
      // amount_paid still counted it. The invoice would show money paid with no
      // record of it, and nothing to reverse.
      //
      // RETURNING because the row is needed for the audit log below and this is
      // the last moment it exists.
      // A row produced by a gateway transfer is NOT deletable here.
      //
      // Deleting it would leave hub_payouts saying 'processed' — money really
      // did leave the company account — over a ledger that no longer contains
      // it. The invoice would reopen and be paid a second time, and nothing on
      // any screen would explain why. A transfer that has to be undone is undone
      // at the bank, and arrives back as payout.reversed, which deletes these
      // rows itself with the payout row updated to match.
      //
      // Checked inside the transaction, on the row being deleted, rather than in
      // a pre-flight SELECT: a pre-flight check can be true and then stop being
      // true before the DELETE runs.
      const r = await client.query(
        `DELETE FROM hub_payments
          WHERE id = $1 AND purchase_invoice_id = $2 AND hub_payout_id IS NULL
      RETURNING amount, method, reference_no, paid_at`,
        [payId, id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        // Two reasons for zero rows, and they need different sentences.
        const why = await pool.query(
          `SELECT hub_payout_id, (SELECT payout_ref FROM hub_payouts WHERE id = hp.hub_payout_id) AS payout_ref
             FROM hub_payments hp WHERE hp.id = $1 AND hp.purchase_invoice_id = $2`,
          [payId, id]);
        if (why.rows[0]?.hub_payout_id) {
          return res.status(409).json({
            error: `This payment came from bank transfer ${why.rows[0].payout_ref} and cannot be deleted here. `
                 + `If the transfer needs reversing, do it at the bank — the reversal is recorded automatically.`,
          });
        }
        return res.status(404).json({ error: 'Payment not found' });
      }
      deleted = r.rows[0];

      await _recalcHubPaymentStatus(client, id);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);

    // Money leaving the record with nothing to show for it is exactly what an
    // audit trail is for — and deleting a hub payout also unblocks deleting the
    // customer payment behind it, so this is the first link in a chain that can
    // erase a whole job's money. Logged AFTER commit: a failed log must not roll
    // back a delete that already succeeded.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'hub_payment',
      entityId: payId,
      description:
        `Hub payment deleted on PI-${String(id).padStart(6, '0')}: ` +
        `₹${Number(deleted.amount).toFixed(2)} via ${deleted.method}` +
        (deleted.reference_no ? ` (ref ${deleted.reference_no})` : '') +
        ` — invoice now ${full.rows[0].payment_status}, ₹${Number(full.rows[0].amount_paid || 0).toFixed(2)} of ₹${Number(full.rows[0].grand_total).toFixed(2)} paid`,
    });

    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared date rules for a hub payment.
//
// The invoice-side framework (utils/invoiceDate.validateInvoiceDate) does not
// apply here: it enforces a chain of DOCUMENT dates — estimate ≤ purchase
// invoice ≤ customer invoice — and a payment is not a document in that chain.
// What it shares is the two rules that exist to protect the books.
//
// Returns null when the date is fine, or an { error, code } to send back.
// ─────────────────────────────────────────────────────────────────────────────
const PAID_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

async function checkHubPaymentDate(paidAt, { invoiceDate }) {
  if (!PAID_AT_RE.test(paidAt)) {
    return { error: 'Payment date must be a calendar date in YYYY-MM-DD form.', code: 'INVALID_FORMAT' };
  }
  // Rejects 2026-02-31, which passes the regex but is not a real day.
  const [y, m, d] = paidAt.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    return { error: `${paidAt} is not a real calendar date.`, code: 'INVALID_FORMAT' };
  }

  const today = istToday();
  if (paidAt > today) {
    return { error: `Payment date cannot be in the future (today is ${today} IST).`, code: 'FUTURE_DATE' };
  }

  // A payout cannot predate the bill it settles.
  if (invoiceDate && paidAt < invoiceDate) {
    return {
      error: `Payment date ${paidAt} is before the purchase invoice date (${invoiceDate}).`,
      code: 'BEFORE_INVOICE',
    };
  }

  // The books lock. This is the rule the payment path never had — a hub payout
  // could be dated into a period already filed with the tax authority.
  const settings = await loadDateSettings();
  const lockedThrough = settings.books_locked_through;
  if (lockedThrough && paidAt <= lockedThrough) {
    return {
      error: `The books are closed through ${lockedThrough}. A payment cannot be dated inside a period that may already have been filed.`,
      code: 'PERIOD_LOCKED',
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/purchase-invoices/:id/payments/:payId
//   Correct the date on one hub payment. Amount, method and reference are not
//   editable — those are what the payment WAS, and changing them silently would
//   make the record disagree with the bank statement behind it. A wrong amount
//   is a delete and a re-entry.
//
//   Nothing is recalculated: paid_at drives no total. amount_paid,
//   payment_status and the split installments all derive from `amount`, and the
//   payout due date is anchored to CUSTOMER invoice payments in a different
//   table entirely (utils/payoutSchedule.syncPayoutDueDate).
// ─────────────────────────────────────────────────────────────────────────────
function updateHubPaymentDate(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const payId = idParam.parse(req.params.payId);
    await _assertPiHub(req, id);
    const { paid_at } = z.object({ paid_at: z.string().trim() }).parse(req.body);

    const row = await pool.query(
      `SELECT hp.id, hp.paid_at::text AS paid_at, hp.amount, hp.payment_batch_id,
              pi.invoice_date::text AS invoice_date
         FROM hub_payments hp
         JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
        WHERE hp.id = $1 AND hp.purchase_invoice_id = $2`,
      [payId, id]
    );
    if (!row.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    const pay = row.rows[0];

    // A row inside a batch must be moved with its batch, not on its own —
    // otherwise one bank transfer ends up displaying two different dates and
    // the grouped history header disagrees with its own children.
    if (pay.payment_batch_id) {
      return res.status(409).json({
        error: 'This payment is part of a bulk payment. Change the date on the bulk payment so every invoice in it stays consistent.',
        code: 'IN_BATCH',
        batch_id: pay.payment_batch_id,
      });
    }

    const bad = await checkHubPaymentDate(paid_at, { invoiceDate: pay.invoice_date });
    if (bad) return res.status(409).json(bad);

    const old = String(pay.paid_at).slice(0, 10);
    if (old === paid_at) {
      return res.status(400).json({ error: 'That is already the payment date.', code: 'UNCHANGED' });
    }

    // paid_at is timestamptz; ::date on a bare YYYY-MM-DD keeps it at IST
    // midnight rather than inheriting the server's clock.
    await pool.query(`UPDATE hub_payments SET paid_at = $1::date WHERE id = $2`, [paid_at, payId]);

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'hub_payment',
      entityId: payId,
      description:
        `Hub payment date changed on PI-${String(id).padStart(6, '0')}: ` +
        `${old} → ${paid_at} (₹${Number(pay.amount).toFixed(2)})`,
    });

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/purchase-invoices/payment-batch/:batchId
//   Move a whole bulk payment to a different date — every invoice in it, in one
//   statement, so the rows cannot diverge.
//
//   The date is checked against the LATEST invoice date in the batch: the
//   payment has to be valid for every invoice it settles, and the latest one is
//   the binding constraint.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Batch variant of _assertPiHub: a payment batch spans several purchase
 * invoices, so every one of them must belong to the caller's hub. Refusing the
 * whole batch (rather than filtering it) is deliberate — a partial re-date or
 * partial delete would silently split a batch the user thinks of as one payment.
 */
async function _assertBatchHub(req, batchId, db = pool) {
  if (!req.user?.hub_id) return;
  const r = await db.query(
    `SELECT DISTINCT pi.hub_id
       FROM hub_payments hp
       JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
      WHERE hp.payment_batch_id = $1`,
    [batchId]
  );
  if (r.rowCount === 0) return; // no rows — the handler's own 404 path applies
  for (const row of r.rows) assertHubOwns(req, row, 'hub_id', 'Payment batch');
}

function updateHubPaymentBatchDate(req, res, next) {
  handle(req, res, next, async () => {
    const batchId = String(req.params.batchId || '').trim();
    if (!batchId || batchId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(batchId)) {
      return res.status(400).json({ error: 'Invalid batch id' });
    }
    const { paid_at } = z.object({ paid_at: z.string().trim() }).parse(req.body);

    await _assertBatchHub(req, batchId);

    const rows = await pool.query(
      `SELECT hp.id, hp.amount, hp.purchase_invoice_id,
              hp.paid_at::text AS paid_at,
              pi.invoice_date::text AS invoice_date
         FROM hub_payments hp
         JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
        WHERE hp.payment_batch_id = $1
        ORDER BY hp.id`,
      [batchId]
    );
    if (rows.rowCount === 0) return res.status(404).json({ error: 'Payment batch not found' });

    // Latest invoice date wins — the payment must not predate ANY of the
    // invoices it settles, so the newest is the one that binds.
    const latestInvoiceDate = rows.rows
      .map(r => r.invoice_date)
      .filter(Boolean)
      .sort()
      .pop() || null;

    const bad = await checkHubPaymentDate(paid_at, { invoiceDate: latestInvoiceDate });
    if (bad) return res.status(409).json(bad);

    const old = String(rows.rows[0].paid_at).slice(0, 10);
    if (old === paid_at) {
      return res.status(400).json({ error: 'That is already the payment date.', code: 'UNCHANGED' });
    }

    // One statement, so the rows in a batch can never end up with different
    // dates. No transaction needed — a single UPDATE is already atomic.
    const upd = await pool.query(
      `UPDATE hub_payments SET paid_at = $1::date WHERE payment_batch_id = $2`,
      [paid_at, batchId]
    );

    const total = rows.rows.reduce((s, r) => s + Number(r.amount), 0);
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'hub_payment',
      entityId: null,
      description:
        `Bulk hub payment date changed: ${old} → ${paid_at} — ` +
        `₹${total.toFixed(2)} across ${upd.rowCount} invoice(s): ` +
        rows.rows.map(r => `PI-${String(r.purchase_invoice_id).padStart(6, '0')}`).join(', '),
    });

    res.json({ ok: true, updated: upd.rowCount, paid_at });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/purchase-invoices/payment-batch/:batchId
//
// Reverse a whole bulk payment — every row it created, across every invoice it
// touched. The per-invoice delete above still exists and still works on a single
// row inside a batch; this is for when the transfer itself was wrong rather than
// one invoice's share of it.
//
// All of it in ONE transaction: a batch half-reversed is worse than either
// state, because the remaining rows still look like a complete payment.
// ─────────────────────────────────────────────────────────────────────────────
function deleteHubPaymentBatch(req, res, next) {
  handle(req, res, next, async () => {
    const batchId = String(req.params.batchId || '').trim();
    // Same shape base64url produces. Rejecting here means an attacker-shaped
    // value never reaches a query.
    if (!batchId || batchId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(batchId)) {
      return res.status(400).json({ error: 'Invalid batch id' });
    }

    await _assertBatchHub(req, batchId);

    const client = await pool.connect();
    let rows = [];
    try {
      await client.query('BEGIN');

      // ── A gateway payout reuses payment_batch_id ────────────────────────────
      // Its payout_ref goes in that column so the existing history screen groups
      // a multi-invoice transfer into the one line it actually was. What it must
      // NOT inherit is this reversal: undoing a real bank transfer by deleting
      // rows would leave hub_payouts saying 'processed' over a ledger that no
      // longer holds the money, and every one of those invoices would be paid
      // again. Refused, with the reason, before anything is deleted.
      const gw = await client.query(
        `SELECT DISTINCT p.payout_ref
           FROM hub_payments hp JOIN hub_payouts p ON p.id = hp.hub_payout_id
          WHERE hp.payment_batch_id = $1`,
        [batchId]);
      if (gw.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `This batch is bank transfer ${gw.rows[0].payout_ref} and cannot be reversed here. `
               + `If the transfer needs reversing, do it at the bank — the reversal is recorded automatically.`,
        });
      }

      const r = await client.query(
        `DELETE FROM hub_payments
          WHERE payment_batch_id = $1 AND hub_payout_id IS NULL
      RETURNING purchase_invoice_id, amount, method, reference_no`,
        [batchId]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Payment batch not found' });
      }
      rows = r.rows;

      // Every invoice the batch touched needs recalculating, not just one.
      // Set, because a batch could in principle carry two rows for the same
      // invoice and recalculating it twice would be wasted work.
      const piIds = [...new Set(rows.map(x => x.purchase_invoice_id))];
      for (const piId of piIds) {
        await _recalcHubPaymentStatus(client, piId);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    const total = rows.reduce((sum, x) => sum + Number(x.amount), 0);
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'hub_payment',
      entityId: null,
      description:
        `Bulk hub payment reversed via ${rows[0].method}` +
        (rows[0].reference_no ? ` (ref ${rows[0].reference_no})` : '') +
        `: ₹${total.toFixed(2)} across ${rows.length} invoice(s) — ` +
        rows.map(x => `PI-${String(x.purchase_invoice_id).padStart(6, '0')} ₹${Number(x.amount).toFixed(2)}`).join(', '),
    });

    res.json({ ok: true, deleted: rows.length, total });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/purchase-invoices/:id
// Update take rates per item after approval.
// Blocked when money has actually moved — not when the label says 'paid'.
// ─────────────────────────────────────────────────────────────────────────────
function updatePurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertPiHub(req, id);

    const { item_rates } = z.object({
      item_rates: z.array(z.object({
        item_id:   z.number().int(),
        take_rate: z.number().min(0).max(100),
      })).min(1),
    }).parse(req.body || {});

    const r = await pool.query(
      `SELECT status, payment_status, amount_paid, created_at FROM purchase_invoices WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = r.rows[0];
    // created_at, NOT invoice_date — this selects the rounding mode off a
    // hardcoded cutover date (utils/math.js). Keyed to a backdatable field
    // it would silently change the totals of an already-issued document.
    const roundFn = getRoundingFunction(pi.created_at);
    /* ── "Has money moved?", not "does it say paid?" ─────────────────────
       These are the same question for every ordinary invoice and different for
       a nil one, which is settled without a rupee having moved. Asked the old
       way, a ₹0 invoice could never have its commission corrected — the one
       thing anybody would want to do with it. */
    if (parseFloat(pi.amount_paid) > 0) {
      return res.status(400).json({ error: 'Cannot edit — payment has already been recorded.' });
    }

    const rateMap = {};
    item_rates.forEach(r => { rateMap[r.item_id] = r.take_rate; });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const itemsRow = await client.query(
        `SELECT id, quantity, customer_rate, gst_percent FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [id]
      );

      let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
      for (const item of itemsRow.rows) {
        const qty      = Number(item.quantity);
        const custRate = Number(item.customer_rate);
        const gstPct   = Number(item.gst_percent);
        const takeRate = rateMap[item.id] != null ? rateMap[item.id] : 0;

        const techDeduct = roundFn(custRate * (takeRate / 100), 4);
        const hubRate    = roundFn(custRate - techDeduct, 4);
        const hubAmount  = roundFn(hubRate * qty);
        const gstAmt     = hubGst(hubAmount, gstPct, pi.hub_has_gst, roundFn);
        const total      = roundFn(hubAmount + gstAmt);

        subtotalExGst += hubAmount;
        totalGst      += gstAmt;
        grandTotal    += total;

        await client.query(
          `UPDATE purchase_invoice_items SET hub_rate=$1, commission_percent=$2, gst_amount=$3, total_payable=$4 WHERE id=$5`,
          [hubRate, takeRate, gstAmt, total, item.id]
        );
      }

      await client.query(
        `UPDATE purchase_invoices SET subtotal_ex_gst=$1, total_gst=$2, grand_total=$3, updated_at=NOW() WHERE id=$4`,
        [subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2), id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/purchase-invoices/:id/sync-from-estimate
// Re-derives all line items + totals from the linked estimate.
// Blocked when money has actually moved — see updatePurchaseInvoice.
// ─────────────────────────────────────────────────────────────────────────────
function syncPurchaseInvoiceFromEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // A hub has no edit access to its own Sales Invoice. This route rewrites
    // every line item and total from the estimate, and its only other guard is
    // payment_status = 'paid' — so an APPROVED invoice, one that has already
    // claimed a number from the hub's consecutive series and been handed to
    // their accountant, could be rewritten from under it.
    //
    // Checked on the ROLE, not a permission code: a hub login can legitimately
    // carry CREATE_INVOICE and would sail through requirePermission. The route
    // gate is staff-only too; this is the guard that holds regardless of how
    // the route is wired later.
    if (isHubUser(req)) {
      return res.status(403).json({
        error: 'A Sales Invoice cannot be changed from the hub portal. Ask Spinoto to update it.',
      });
    }

    const piRow = await pool.query(
      `SELECT pi.id, pi.estimate_id, pi.hub_id, pi.rate_mode, pi.commission_percent,
              pi.payment_status, pi.created_at, pi.hub_has_gst
       FROM purchase_invoices pi WHERE pi.id = $1`,
      [id]
    );
    if (piRow.rows[0]) assertHubOwns(req, piRow.rows[0], 'hub_id', 'Purchase invoice');
    if (!piRow.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = piRow.rows[0];

    // Same rule as updatePurchaseInvoice: the money, not the word.
    if (parseFloat(pi.amount_paid || 0) > 0) {
      return res.status(400).json({ error: 'Cannot sync — payment has already been recorded against this invoice.' });
    }

    // Re-fetch estimate discount fields
    const estRow = await pool.query(
      `SELECT e.discount_mode, e.transaction_discount_type, e.transaction_discount_value
       FROM estimates e WHERE e.id = $1`,
      [pi.estimate_id]
    );
    const est = estRow.rows[0] || {};

    // Hub rates
    const hubRow = await pool.query(
      `SELECT commission_percent, tech_rate_service, tech_rate_parts FROM hubs WHERE id = $1`,
      [pi.hub_id]
    );
    const hub             = hubRow.rows[0] || {};
    const commissionPct   = hub.commission_percent != null ? Number(hub.commission_percent) : null;
    const techRateService = hub.tech_rate_service  != null ? Number(hub.tech_rate_service)  : null;
    const techRateParts   = hub.tech_rate_parts    != null ? Number(hub.tech_rate_parts)    : null;
    const useCommission   = commissionPct != null && commissionPct > 0;
    const rateMode        = useCommission ? 'commission' : 'tech_rate';

    // Eligible items
    const itemsRow = await pool.query(
      `SELECT * FROM estimate_items
       WHERE estimate_id = $1 AND customer_approved = true AND work_status = 'completed'`,
      [pi.estimate_id]
    );
    if (itemsRow.rowCount === 0) {
      return res.status(400).json({ error: 'No completed approved items found in estimate.' });
    }

    // created_at, NOT invoice_date — this selects the rounding mode off a
    // hardcoded cutover date (utils/math.js). Keyed to a backdatable field
    // it would silently change the totals of an already-issued document.
    const roundFn = getRoundingFunction(pi.created_at);

    // Transaction discount
    const txDiscountMode  = est.discount_mode || 'none';
    const txDiscountType  = est.transaction_discount_type || 'percent';
    const txDiscountValue = parseFloat(est.transaction_discount_value) || 0;
    /* The same shared calculation generatePurchaseInvoice uses. These two
       functions produce the SAME invoice from the same estimate — one at
       generation, one when the estimate is later re-synced — so any drift
       between them shows up as an invoice that changes amount for no reason
       anybody can point at. They now read one implementation. */
    const custTotals = applyTransactionDiscount({
      items:         itemsRow.rows,
      discountType:  txDiscountMode === 'transaction' ? txDiscountType : null,
      discountValue: txDiscountMode === 'transaction' ? txDiscountValue : 0,
      roundFn,
    });

    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const items = itemsRow.rows.map((item, idx) => {
      const qty    = Number(item.quantity);
      const gstPct = Number(item.gst_percent);

      // Post-discount ex-GST per unit — see the note in generatePurchaseInvoice.
      const custRate = qty > 0 ? roundFn(custTotals.lines[idx].taxable / qty, 4) : 0;

      let appliedRatePct, hubRate;
      if (useCommission) {
        appliedRatePct = commissionPct;
        hubRate        = roundFn(custRate * (1 - commissionPct / 100), 4);
      } else {
        const isService  = item.item_type === 'service';
        const techRate   = isService ? (techRateService ?? 0) : (techRateParts ?? 0);
        appliedRatePct   = techRate;
        const techDeduct = roundFn(custRate * (techRate / 100), 4);
        hubRate          = roundFn(custRate - techDeduct, 4);
      }

      const hubAmount    = roundFn(hubRate * qty);
      const gstAmount    = hubGst(hubAmount, gstPct, pi.hub_has_gst, roundFn);
      const totalPayable = roundFn(hubAmount + gstAmount);

      subtotalExGst += hubAmount;
      totalGst      += gstAmount;
      grandTotal    += totalPayable;

      return { ...item, custRate, hubRate, appliedRatePct, gstAmount, totalPayable };
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Replace items
      await client.query(`DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO purchase_invoice_items
             (purchase_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, commission_percent, hub_rate,
              gst_percent, gst_amount, total_payable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id, item.id, item.item_type, item.description,
            item.quantity, item.custRate,
            item.appliedRatePct ?? 0,
            item.hubRate,
            item.gst_percent, item.gstAmount, item.totalPayable,
          ]
        );
      }

      // Update PI totals
      await client.query(
        `UPDATE purchase_invoices
         SET subtotal_ex_gst=$1, total_gst=$2, grand_total=$3,
             rate_mode=$4, commission_percent=$5, updated_at=NOW()
         WHERE id=$6`,
        [
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          rateMode, useCommission ? commissionPct : 0,
          id,
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);
    res.json({ item: full.rows[0] });
  });
}

// ── GET /api/purchase-invoices/payouts — dashboard of pending hub payouts, bucketed
function listPayouts(req, res, next) {
  handle(req, res, next, async () => {
    const today = new Date().toISOString().split('T')[0];
    const params = [today];
    const hubScope = hubScopeSql(req, params, 'pi.hub_id');

    // Fetch all approved, unpaid PIs with their urgency bucket
    const r = await pool.query(
      `SELECT
         pi.id, pi.public_token AS purchase_invoice_token,
         pi.hub_id, pi.grand_total, pi.amount_paid, pi.payment_status,
         pi.payout_due_date, pi.payout_schedule, pi.approved_at,
         h.hub_name, h.payout_terms,
         COALESCE(a.customer_name, e.customer_name)   AS customer_name,
         COALESCE(a.vehicle_number, e.vehicle_number) AS vehicle_number,
         ci.id            AS customer_invoice_id,
         ci.public_token  AS customer_invoice_token,
         ci.grand_total   AS ci_grand_total,
         ci.amount_paid   AS ci_amount_paid,
         ci.status        AS ci_status,
         ci.ci_last_paid_at,
         CASE
           WHEN pi.payout_due_date IS NULL                                                         THEN 'awaiting_payment'
           WHEN pi.payout_due_date <  $1::date                                                     THEN 'overdue'
           WHEN pi.payout_due_date =  $1::date                                                     THEN 'due_today'
           WHEN pi.payout_due_date <= ($1::date + INTERVAL '7 days')                               THEN 'due_this_week'
           WHEN pi.payout_due_date <= ($1::date + INTERVAL '30 days')                              THEN 'due_this_month'
           ELSE 'upcoming'
         END AS urgency
       FROM purchase_invoices pi
       JOIN hubs h ON h.id = pi.hub_id
       LEFT JOIN appointments a ON a.id = pi.appointment_id
       LEFT JOIN estimates e ON e.id = pi.estimate_id
       -- One LATERAL instead of the two correlated subqueries this used to run,
       -- now that five CI columns are needed rather than two.
       --
       -- The ORDER BY is the point, not the performance. Those subqueries had a
       -- bare LIMIT 1: when a legacy customer invoice's purchase_invoice_id
       -- points at a DIFFERENT purchase invoice than its estimate's, the row
       -- chosen was arbitrary — and each subquery could pick a different one, so
       -- the id and the token could describe two different invoices. Preferring
       -- the explicit link, then the lowest id, is the same fix
       -- customer_invoices.controller.js already applies to the mirror-image
       -- join (see its loadDateContext LATERAL).
       LEFT JOIN LATERAL (
         SELECT c.id, c.public_token, c.grand_total, c.amount_paid, c.status,
                -- When the customer finished paying. This is the anchor
                -- syncPayoutDueDate uses for the hub's due date, so the tooltip
                -- explains the Due Date column beside it.
                (SELECT MAX(p.paid_at) FROM invoice_payment_lines p
                  WHERE p.customer_invoice_id = c.id) AS ci_last_paid_at
           FROM customer_invoices c
          WHERE c.purchase_invoice_id = pi.id OR c.estimate_id = pi.estimate_id
          ORDER BY (c.purchase_invoice_id = pi.id) DESC, c.id
          LIMIT 1
       ) ci ON TRUE
       WHERE pi.status = 'approved' AND pi.payment_status NOT IN ('paid', 'not_required')${hubScope ? ` AND ${hubScope}` : ''}
       ORDER BY pi.payout_due_date ASC NULLS LAST`,
      params
    );

    // Attach installment schedules for split invoices
    const splitIds = r.rows.filter(pi => pi.payout_schedule === 'split').map(pi => pi.id);
    let scheduleMap = {};
    if (splitIds.length > 0) {
      const sched = await pool.query(
        `SELECT purchase_invoice_id, id, installment_no, amount_due, due_date, paid_amount, status
         FROM pi_payment_schedule WHERE purchase_invoice_id = ANY($1) ORDER BY installment_no`,
        [splitIds]
      );
      for (const row of sched.rows) {
        if (!scheduleMap[row.purchase_invoice_id]) scheduleMap[row.purchase_invoice_id] = [];
        scheduleMap[row.purchase_invoice_id].push(row);
      }
    }

    // Bucket the results
    const buckets = { overdue: [], due_today: [], due_this_week: [], due_this_month: [], upcoming: [], awaiting_payment: [] };
    for (const pi of r.rows) {
      if (pi.payout_schedule === 'split') pi.schedule = scheduleMap[pi.id] || [];
      const bucket = pi.urgency || 'awaiting_payment';
      if (buckets[bucket]) buckets[bucket].push(pi);
    }

    res.json(buckets);
  });
}

// ── GET /api/purchase-invoices/hub-payments — all hub payments, filterable ──
function listHubPayments(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params     = [];

    // Hub pin first; the query-param filter is then skipped so a client cannot
    // widen it back out to every hub's payment history.
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
      `SELECT
         hp.id, hp.amount, hp.method, hp.reference_no, hp.notes, hp.paid_at,
         hp.purchase_invoice_id, hp.payment_batch_id,
         -- Set ⇒ produced by a bank transfer, and not deletable by hand. The UI
         -- uses it to hide the delete action rather than render a button that
         -- 409s; the refusal itself lives in deleteHubPayment.
         hp.hub_payout_id, hpo.payout_ref, hpo.status AS payout_status,
         pi.public_token AS purchase_invoice_token,
         pi.grand_total AS pi_grand_total,
         pi.amount_paid AS pi_amount_paid,
         h.id AS hub_id, h.hub_name,
         COALESCE(a.vehicle_number, e.vehicle_number) AS vehicle_number,
         COALESCE(a.customer_name, e.customer_name)   AS customer_name,
         u.name AS created_by_name
       FROM hub_payments hp
       JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
       JOIN hubs h ON h.id = pi.hub_id
       LEFT JOIN hub_payouts hpo ON hpo.id = hp.hub_payout_id
       LEFT JOIN appointments a ON a.id = pi.appointment_id
       LEFT JOIN estimates e ON e.id = pi.estimate_id
       LEFT JOIN users u ON u.id = hp.created_by
       ${where}
       ORDER BY hp.paid_at DESC`,
      params
    );

    // Group by hub
    const byHub = {};
    for (const row of r.rows) {
      const key = row.hub_name || 'Unknown';
      if (!byHub[key]) byHub[key] = { hub_id: row.hub_id, hub_name: row.hub_name, payments: [], total: 0 };
      byHub[key].payments.push(row);
      byHub[key].total += parseFloat(row.amount);
    }

    res.json({
      payments: r.rows,
      by_hub:   Object.values(byHub).sort((a, b) => b.total - a.total),
      total:    r.rows.reduce((s, r) => s + parseFloat(r.amount), 0),
    });
  });
}

// ── GET /api/purchase-invoices/tech-rate-summary ─────────────────────────────
function getTechRateSummary(req, res, next) {
  handle(req, res, next, async () => {
    // customer_rate - hub_rate IS the platform's take. Unscoped, this hands a
    // hub partner the company-wide margin figure in a single number.
    //
    // Scoping it was not enough, and that was the bug: a scoped answer is the
    // margin the company makes ON THAT HUB — the single most useful number a
    // partner could take into a rate negotiation, served pre-summed. There is no
    // version of this figure a hub should see, so the refusal is total.
    if (isHubUser(req)) {
      return res.status(403).json({ error: 'This summary is not available to hub logins.' });
    }
    const params = [];
    const hubScope = hubScopeSql(req, params, 'pi.hub_id');
    const r = await pool.query(
      `SELECT
         SUM((pii.customer_rate - pii.hub_rate) * pii.quantity)                              AS total_ex_gst,
         SUM((pii.customer_rate - pii.hub_rate) * pii.quantity * (1 + pii.gst_percent/100)) AS total_inc_gst
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
       WHERE pi.status = 'approved'
         AND pi.rate_mode = 'tech_rate'${hubScope ? ` AND ${hubScope}` : ''}`,
      params
    );
    const row = r.rows[0];
    res.json({
      total_ex_gst:  parseFloat(row.total_ex_gst  || 0),
      total_inc_gst: parseFloat(row.total_inc_gst || 0),
    });
  });
}

// ── POST /api/purchase-invoices/bulk-payment ──────────────────────────────────
// Body: { payments: [{pi_id, amount}], method, reference_no, notes }
// Processes all payments in a single DB transaction, oldest PI first.
function bulkPayment(req, res, next) {
  handle(req, res, next, async () => {
    const { payments, method, reference_no, notes } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'No payments provided.' });
    }
    if (!method) return res.status(400).json({ error: 'Payment method is required.' });

    const client = await pool.connect();
    // One id shared by every row this call creates. The rows stay per-invoice
    // (migration 105 explains why they must), but the history groups on this and
    // shows the single payment the user actually made.
    const batchId = crypto.randomBytes(12).toString('base64url');
    try {
      await client.query('BEGIN');

      const results = [];
      for (const { pi_id, amount } of payments) {
        if (!pi_id || !amount || parseFloat(amount) <= 0) continue;

        // Fetch PI to get hub_id and validate balance
        const piRow = await client.query(
          `SELECT pi.id, pi.hub_id, pi.grand_total, pi.amount_paid, pi.payout_schedule
           FROM purchase_invoices pi WHERE pi.id = $1 AND pi.status = 'approved'`,
          [pi_id]
        );
        if (!piRow.rows[0]) continue;
        const pi = piRow.rows[0];
        // Silently skip anything outside the caller's hub, matching how this
        // loop already skips unapproved and zero-balance invoices. `results`
        // reports what was actually paid, so nothing is claimed that didn't run.
        if (req.user?.hub_id && pi.hub_id !== req.user.hub_id) continue;
        const balance = parseFloat(pi.grand_total) - parseFloat(pi.amount_paid || 0);
        const payAmt  = Math.min(parseFloat(amount), balance); // never overpay
        if (payAmt <= 0) continue;

        await client.query(
          `INSERT INTO hub_payments (purchase_invoice_id, hub_id, amount, method, reference_no, paid_at, notes, created_by, payment_batch_id)
           VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8)`,
          [pi.id, pi.hub_id, payAmt.toFixed(2), method, reference_no||null, notes||null, req.user?.id||null, batchId]
        );
        await _recalcHubPaymentStatus(client, pi.id);
        results.push({ pi_id: pi.id, amount: payAmt });
      }

      await client.query('COMMIT');

      // One line for the batch, not one per invoice: this was a single decision
      // by the user and reads as one in the log. The per-PI split is in the
      // description so a specific invoice is still findable.
      logActivity({
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'CREATE',
        entity: 'hub_payment',
        entityId: null,
        description:
          `Bulk hub payment via ${method}` +
          (reference_no ? ` (ref ${reference_no})` : '') +
          `: ₹${results.reduce((s, r) => s + r.amount, 0).toFixed(2)} across ${results.length} invoice(s) — ` +
          results.map(r => `PI-${String(r.pi_id).padStart(6, '0')} ₹${r.amount.toFixed(2)}`).join(', '),
      });

      res.json({ success: true, processed: results.length, payments: results });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ── Export Payouts as CSV ────────────────────────────────────────────────────
function exportPayouts(req, res, next) {
  handle(req, res, next, async () => {
    const type = req.query.type || 'outstanding'; // outstanding | history
    const hubId = req.query.hub_id ? Number(req.query.hub_id) : null;
    const status = req.query.status || '';
    const search = (req.query.search || '').trim().toLowerCase();
    const from = req.query.from || '';
    const to = req.query.to || '';

    const csvEscape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    if (type === 'outstanding') {
      /* NOT IN, not != 'paid'. A nil invoice is settled and must stay out of
         this queue — with a bare != it would reappear the day migration 174
         relabelled it, asking somebody to pay ₹0. */
      const conditions = ["pi.status = 'approved'", "pi.payment_status NOT IN ('paid', 'not_required')"];
      const params = [];

      // The CSV builds its own WHERE, so scoping applied only to listPayouts
      // would leave this route as an open door.
      const hubScope = hubScopeSql(req, params, 'pi.hub_id');
      if (hubScope) {
        conditions.push(hubScope);
      } else if (hubId) {
        params.push(hubId);
        conditions.push(`pi.hub_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`pi.payment_status = $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const r = await pool.query(
        `SELECT
           pi.id, pi.grand_total, pi.amount_paid, pi.payment_status,
           pi.payout_due_date, pi.created_at,
           h.hub_name,
           COALESCE(a.vehicle_number, e.vehicle_number) AS vehicle_number,
           u.name AS created_by_name
         FROM purchase_invoices pi
         JOIN hubs h ON h.id = pi.hub_id
         LEFT JOIN appointments a ON a.id = pi.appointment_id
         LEFT JOIN estimates e ON e.id = pi.estimate_id
         LEFT JOIN users u ON u.id = pi.created_by
         ${where}
         ORDER BY pi.payout_due_date ASC NULLS LAST`,
        params
      );

      let rows = r.rows;
      if (search) {
        rows = rows.filter(pi => 
          `pi-${String(pi.id).padStart(6,'0')}`.includes(search) ||
          (pi.vehicle_number || '').toLowerCase().includes(search)
        );
      }

      const headers = [
        'Invoice ID', 'Hub Name', 'Vehicle Number', 'Grand Total (INR)',
        'Amount Paid (INR)', 'Balance Due (INR)', 'Payout Due Date',
        'Payment Status', 'Created At'
      ];

      const csvRows = rows.map(pi => {
        const balance = parseFloat(pi.grand_total) - parseFloat(pi.amount_paid || 0);
        return [
          `PI-${String(pi.id).padStart(6, '0')}`,
          pi.hub_name || '',
          pi.vehicle_number || '—',
          pi.grand_total,
          pi.amount_paid || '0.00',
          balance.toFixed(2),
          pi.payout_due_date ? new Date(pi.payout_due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
          pi.payment_status || 'pending',
          pi.created_at ? new Date(pi.created_at).toISOString().slice(0, 19).replace('T', ' ') : ''
        ].map(csvEscape).join(',');
      });

      const csv = [headers.join(','), ...csvRows].join('\r\n');
      const date = new Date().toISOString().slice(0, 10);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payouts_outstanding_${date}.csv"`);
      res.send('\ufeff' + csv);

    } else {
      const conditions = [];
      const params = [];

      const hubScope = hubScopeSql(req, params, 'pi.hub_id');
      if (hubScope) {
        conditions.push(hubScope);
      } else if (hubId) {
        params.push(hubId);
        conditions.push(`pi.hub_id = $${params.length}`);
      }
      if (from) {
        params.push(from);
        conditions.push(`hp.paid_at::date >= $${params.length}::date`);
      }
      if (to) {
        params.push(to);
        conditions.push(`hp.paid_at::date <= $${params.length}::date`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const r = await pool.query(
        `SELECT
           hp.id, hp.amount, hp.method, hp.reference_no, hp.notes, hp.paid_at,
           hp.purchase_invoice_id,
           h.hub_name,
           COALESCE(a.vehicle_number, e.vehicle_number) AS vehicle_number,
           u.name AS created_by_name
         FROM hub_payments hp
         JOIN purchase_invoices pi ON pi.id = hp.purchase_invoice_id
         JOIN hubs h ON h.id = pi.hub_id
         LEFT JOIN appointments a ON a.id = pi.appointment_id
         LEFT JOIN estimates e ON e.id = pi.estimate_id
         LEFT JOIN users u ON u.id = hp.created_by
         ${where}
         ORDER BY hp.paid_at DESC`,
        params
      );

      let rows = r.rows;
      if (search) {
        rows = rows.filter(p => 
          `pi-${String(p.purchase_invoice_id).padStart(6,'0')}`.includes(search) ||
          (p.vehicle_number || '').toLowerCase().includes(search) ||
          (p.hub_name || '').toLowerCase().includes(search) ||
          (p.reference_no || '').toLowerCase().includes(search)
        );
      }

      const headers = [
        'Payment ID', 'Payment Date & Time', 'Invoice ID', 'Hub Name',
        'Vehicle Number', 'Amount Paid (INR)', 'Payment Method',
        'Reference Number', 'Recorded By', 'Notes'
      ];

      const csvRows = rows.map(p => [
        p.id,
        p.paid_at ? new Date(p.paid_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
        `PI-${String(p.purchase_invoice_id).padStart(6, '0')}`,
        p.hub_name || '',
        p.vehicle_number || '—',
        p.amount,
        p.method || '',
        p.reference_no || '—',
        p.created_by_name || '—',
        p.notes || ''
      ].map(csvEscape).join(','));

      const csv = [headers.join(','), ...csvRows].join('\r\n');
      const date = new Date().toISOString().slice(0, 10);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payouts_payments_${date}.csv"`);
      res.send('\ufeff' + csv);
    }
  });
}

async function rejectPurchaseInvoiceApproval(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertPiHub(req, id);

    const r = await pool.query(
      `SELECT pi.status,
              (SELECT COUNT(*)::int FROM hub_payments WHERE purchase_invoice_id = pi.id) AS payment_count
       FROM purchase_invoices pi
       WHERE pi.id = $1`,
      [id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = r.rows[0];

    if (pi.status !== 'approved') {
      return res.status(400).json({ error: `Only approved purchase invoices can have their approvals rejected. Current status: '${pi.status}'.` });
    }

    if (pi.payment_count > 0) {
      return res.status(400).json({ error: 'Cannot reject approval of a purchase invoice that has payments registered against it.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `DELETE FROM pi_payment_schedule WHERE purchase_invoice_id = $1`,
        [id]
      );

      /* payment_status goes back too, and its absence here was a bug.
         Approval SETS payment_status ('pending', or 'not_required' for a nil
         invoice). Un-approving cleared approved_by, approved_at,
         payout_due_date and the schedule but left the payment label standing —
         so a rejected nil invoice returned to pending_approval still carrying
         the old 'paid', and updatePurchaseInvoice went on refusing to edit it.
         The escape hatch did not escape.

         'pending' is right regardless of the total: re-approving recomputes it,
         and an unapproved invoice has no payment position to describe. Guarded
         on amount_paid because rejectApproval already refuses an invoice with
         payments — this is the assertion that says so in the SQL. */
      await client.query(
        `UPDATE purchase_invoices
         SET status = 'pending_approval',
             approved_by = NULL,
             approved_at = NULL,
             payout_due_date = NULL,
             payment_status = CASE WHEN COALESCE(amount_paid, 0) > 0
                                   THEN payment_status ELSE 'pending' END,
             updated_at = NOW()
         WHERE id = $1`,
         [id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items         = await _getItems(id);
    full.rows[0].hub_payments  = await _getHubPayments(id);
    full.rows[0].schedule      = await _getPaymentSchedule(id);

    res.json({ item: full.rows[0] });
  });
}

/**
 * Cancel a purchase invoice.
 *
 * ── Why cancel and not delete ───────────────────────────────────────────────
 *
 * Approving a PI claims a number from the hub's own invoice series
 * (claimHubInvoiceNumber), and that series must not have holes — a supplier
 * jumping from 0041 to 0043 has to explain 0042 to their accountant, and the
 * explanation "the customer deleted it" is not one. Cancelling keeps the
 * number, keeps the document, and marks it void, which is what every
 * accounting system in the world does with a wrong invoice.
 *
 * `status = 'cancelled'` has been legal since migration 065 and nothing has
 * ever set it. The list screen already has the badge and the filter option.
 *
 * ── What it frees ──────────────────────────────────────────────────────────
 *
 * Migration 174 replaced UNIQUE(estimate_id) with a partial unique index that
 * ignores cancelled rows, so cancelling releases the estimate and a corrected
 * PI can be generated for it. Without that this endpoint would be a trap: one
 * dead end traded for a worse one.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * Any invoice money has moved against. A payout that has left the bank is a
 * fact about the bank, and no status on this row makes it untrue — reverse the
 * payment first, deliberately, and then decide.
 */
async function cancelPurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertPiHub(req, id);

    const r = await pool.query(
      `SELECT pi.status, pi.payment_status, COALESCE(pi.amount_paid, 0) AS amount_paid,
              pi.invoice_number,
              (SELECT COUNT(*)::int FROM hub_payments WHERE purchase_invoice_id = pi.id) AS payment_count
         FROM purchase_invoices pi WHERE pi.id = $1`, [id]);

    if (!r.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = r.rows[0];

    if (pi.status === 'cancelled') {
      return res.status(400).json({ error: 'This purchase invoice is already cancelled.' });
    }

    /* Both checks, not one. amount_paid is DERIVED from hub_payments by
       recalcHubInvoiceState, so in a healthy database they agree — and the one
       time they do not is exactly the time this must refuse. */
    if (pi.payment_count > 0 || parseFloat(pi.amount_paid) > 0) {
      return res.status(400).json({
        error: `Cannot cancel — ₹${Number(pi.amount_paid).toFixed(2)} has already been paid against this invoice. `
             + `Reverse the payment first if that is what you mean to do.`,
        code: 'PI_HAS_PAYMENTS',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The schedule describes future payouts on an invoice that will not be
      // paid. Deleted rather than left, exactly as rejectApproval does.
      await client.query(`DELETE FROM pi_payment_schedule WHERE purchase_invoice_id = $1`, [id]);

      /* invoice_number is deliberately NOT cleared — see the header. The number
         stays on the cancelled document so the hub's series stays whole.

         payment_status goes to 'not_required': nothing is owed on a cancelled
         invoice and nothing was paid, which is precisely what that value means
         (migration 174). Leaving it 'pending' would keep the invoice looking
         like an outstanding liability on a document that has been voided. */
      await client.query(
        `UPDATE purchase_invoices
            SET status = 'cancelled',
                payment_status = 'not_required',
                payout_due_date = NULL,
                updated_at = NOW()
          WHERE id = $1`, [id]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`[purchase_invoices] ${pi.invoice_number || `#${id}`} cancelled by user ${req.user?.id}`);

    const full = await pool.query(`${PI_SELECT} WHERE pi.id = $1`, [id]);
    full.rows[0].items        = await _getItems(id);
    full.rows[0].hub_payments = await _getHubPayments(id);
    full.rows[0].schedule     = await _getPaymentSchedule(id);
    res.json({ item: full.rows[0] });
  });
}

module.exports = { listPurchaseInvoices, getPurchaseInvoice, getPurchaseInvoicePdf, getPurchaseInvoiceByToken, generatePurchaseInvoice, approvePurchaseInvoice, rejectPurchaseInvoiceApproval, updatePurchaseInvoice, addHubPayment, deleteHubPayment, deleteHubPaymentBatch, updateHubPaymentDate, updateHubPaymentBatchDate, listPayouts, recalculatePurchaseInvoice, syncPurchaseInvoiceFromEstimate, listHubPayments, getTechRateSummary, bulkPayment, exportPayouts, cancelPurchaseInvoice };
