'use strict';
const crypto   = require('crypto');
const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { getRoundingFunction } = require('../utils/math');
const { syncPayoutDueDate } = require('../utils/payoutSchedule');
const { generatePublicToken, resolveTokenToId } = require('../utils/publicToken');
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
const { istToday, validateInvoiceDate, validationError } = require('../utils/invoiceDate');
const { buildSearchSql } = require('../utils/listSearch');
const { logActivity } = require('../services/activityLog.service');

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

async function _getItems(purchaseInvoiceId) {
  const r = await pool.query(
    `SELECT id, estimate_item_id, item_type, description, quantity,
            customer_rate, commission_percent, hub_rate,
            gst_percent, gst_amount, total_payable
     FROM purchase_invoice_items WHERE purchase_invoice_id = $1 ORDER BY id`,
    [purchaseInvoiceId]
  );
  return r.rows;
}

async function _getHubPayments(purchaseInvoiceId) {
  const r = await pool.query(
    `SELECT hp.id, hp.amount, hp.method, hp.reference_no, hp.paid_at, hp.notes,
            hp.payment_batch_id,
            u.name AS created_by_name
     FROM hub_payments hp
     LEFT JOIN users u ON u.id = hp.created_by
     WHERE hp.purchase_invoice_id = $1 ORDER BY hp.paid_at ASC`,
    [purchaseInvoiceId]
  );
  return r.rows;
}

async function _getPaymentSchedule(purchaseInvoiceId) {
  const r = await pool.query(
    `SELECT id, installment_no, amount_due, due_date, paid_amount, status
     FROM pi_payment_schedule WHERE purchase_invoice_id = $1 ORDER BY installment_no`,
    [purchaseInvoiceId]
  );
  return r.rows;
}

async function _recalcHubPaymentStatus(client, purchaseInvoiceId) {
  const r = await client.query(
    `SELECT pi.grand_total, COALESCE(SUM(hp.amount), 0) AS paid
     FROM purchase_invoices pi
     LEFT JOIN hub_payments hp ON hp.purchase_invoice_id = pi.id
     WHERE pi.id = $1 GROUP BY pi.grand_total`,
    [purchaseInvoiceId]
  );
  const { grand_total, paid } = r.rows[0];
  const amtPaid = parseFloat(paid);
  const total   = parseFloat(grand_total);
  const status  = amtPaid <= 0 ? 'pending' : amtPaid >= total - 0.011 ? 'paid' : 'partially_paid';
  await client.query(
    `UPDATE purchase_invoices SET amount_paid=$1, payment_status=$2, updated_at=NOW() WHERE id=$3`,
    [amtPaid.toFixed(2), status, purchaseInvoiceId]
  );
}


function listPurchaseInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const conditions = [], params = [];

    const searchSql = buildSearchSql({ search: req.query.search, params, ...PI_SEARCH });
    if (searchSql) conditions.push(searchSql);
    if (req.query.hub_ids) {
      const ids = req.query.hub_ids.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`pi.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (req.query.hub_id) {
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
    item.items        = await _getItems(id);
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
    invoice.items        = await _getItems(id);
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

    // Fetch hub rates — commission takes priority over tech rates
    const hubRow = await pool.query(
      `SELECT commission_percent, tech_rate_service, tech_rate_parts FROM hubs WHERE id = $1`,
      [est.hub_id]
    );
    const hub = hubRow.rows[0] || {};
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

    // Sum of total_inc_gst across all eligible items (base for proportional split)
    const totalIncGstSum = itemsRow.rows.reduce((s, it) => s + Number(it.total_inc_gst ?? 0), 0);

    // Compute the total transaction discount amount (inc-GST)
    let txDiscountTotal = 0;
    if (txDiscountMode === 'transaction' && txDiscountValue > 0 && totalIncGstSum > 0) {
      if (txDiscountType === 'percent') {
        txDiscountTotal = parseFloat((totalIncGstSum * txDiscountValue / 100).toFixed(2));
      } else {
        txDiscountTotal = Math.min(txDiscountValue, totalIncGstSum);
      }
    }

    const roundFn = getRoundingFunction(new Date());

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
    const items = itemsRow.rows.map(item => {
      const qty    = Number(item.quantity);
      const gstPct = Number(item.gst_percent);

      // Determine post-discount inc-GST for this item:
      // 1. Start with line-item discount (total_inc_gst already reflects it)
      // 2. Then apply this item's proportional share of the transaction discount
      const itemIncGst = Number(item.total_inc_gst ?? 0);
      const itemTxDiscount = txDiscountTotal > 0 && totalIncGstSum > 0
        ? roundFn(itemIncGst / totalIncGstSum * txDiscountTotal, 4)
        : 0;
      const postDiscIncGst = roundFn(itemIncGst - itemTxDiscount, 4);

      // custRate = post-discount ex-GST per unit
      const custRate = roundFn(postDiscIncGst / qty / (1 + gstPct / 100), 4);

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
      const gstAmount    = roundFn(hubAmount * gstPct / 100);
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
            updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 $11::date, $12::date, $13, $14, $15, $16) RETURNING id`,
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

    // Allow optional payout_schedule + per-item rate overrides at approval time
    const { payout_schedule, item_rates } = z.object({
      payout_schedule: z.enum(['lump_sum', 'split']).default('lump_sum'),
      item_rates: z.array(z.object({
        item_id:   z.number().int(),
        take_rate: z.number().min(0).max(100),
      })).optional().default([]),
    }).parse(req.body || {});

    const r = await pool.query(
      `SELECT pi.status, pi.grand_total, pi.hub_id, pi.appointment_id, pi.rate_mode,
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
          const gstAmt     = roundFn(hubAmount * gstPct / 100);
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

      // A ₹0 PI (hub-borne warranty redo) has nothing to pay out — mark its
      // payment_status 'paid' at approval so it never lingers in the payouts
      // queue (payouts lists status='approved' AND payment_status != 'paid').
      // NOTE: 'paid' lives in payment_status, NOT status — the status column's
      // CHECK only allows pending_approval/approved/cancelled. Normal PIs
      // always have grand_total > 0 and are untouched by this.
      const zeroPayable = parseFloat(pi.grand_total) <= 0.011;

      await client.query(
        `UPDATE purchase_invoices
         SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW(),
             payout_due_date=NULL, payout_schedule=$2,
             payment_status=$4
         WHERE id=$3`,
        [req.user?.id || null, payout_schedule, id, zeroPayable ? 'paid' : 'pending']
      );

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
    if (pi.payment_status === 'paid') {
      return res.status(400).json({ error: 'Purchase invoice is already fully paid' });
    }
    const balance = parseFloat(pi.grand_total) - parseFloat(pi.amount_paid);
    if (data.amount > balance + 0.01) {
      return res.status(400).json({ error: `Payment ₹${data.amount} exceeds outstanding balance ₹${balance.toFixed(2)}` });
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
      await _recalcHubPaymentStatus(client, id);

      // Update split installment statuses based on cumulative paid amount
      const updatedPi = await client.query(
        `SELECT amount_paid, payout_schedule FROM purchase_invoices WHERE id = $1`, [id]
      );
      if (updatedPi.rows[0].payout_schedule === 'split') {
        const schedule = await client.query(
          `SELECT id, amount_due FROM pi_payment_schedule WHERE purchase_invoice_id=$1 ORDER BY installment_no`,
          [id]
        );
        let remaining = parseFloat(updatedPi.rows[0].amount_paid);
        for (const inst of schedule.rows) {
          const due = parseFloat(inst.amount_due);
          const paidAmt = Math.min(remaining, due);
          const instStatus = paidAmt <= 0 ? 'pending' : paidAmt >= due ? 'paid' : 'partially_paid';
          await client.query(
            `UPDATE pi_payment_schedule SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
            [paidAmt.toFixed(2), instStatus, inst.id]
          );
          remaining -= paidAmt;
        }
      }

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
      `SELECT pi.id, pi.rate_mode, pi.hub_id, pi.created_at FROM purchase_invoices pi WHERE pi.id = $1`, [id]
    );
    if (!piRow.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
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
      const gstAmount    = roundFn(hubAmount * gstPct / 100);
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
      const r = await client.query(
        `DELETE FROM hub_payments
          WHERE id = $1 AND purchase_invoice_id = $2
      RETURNING amount, method, reference_no, paid_at`,
        [payId, id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Payment not found' });
      }
      deleted = r.rows[0];

      await _recalcHubPaymentStatus(client, id);

      // Recalculate split installment statuses after deletion
      const updatedPi = await client.query(
        `SELECT amount_paid, payout_schedule FROM purchase_invoices WHERE id = $1`, [id]
      );
      if (updatedPi.rows[0].payout_schedule === 'split') {
        const schedule = await client.query(
          `SELECT id, amount_due FROM pi_payment_schedule WHERE purchase_invoice_id=$1 ORDER BY installment_no`,
          [id]
        );
        let remaining = parseFloat(updatedPi.rows[0].amount_paid);
        for (const inst of schedule.rows) {
          const due     = parseFloat(inst.amount_due);
          const paidAmt = Math.min(remaining, due);
          const instStatus = paidAmt <= 0 ? 'pending' : paidAmt >= due ? 'paid' : 'partially_paid';
          await client.query(
            `UPDATE pi_payment_schedule SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
            [paidAmt.toFixed(2), instStatus, inst.id]
          );
          remaining = Math.max(0, remaining - paidAmt);
        }
      }

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
function updateHubPaymentBatchDate(req, res, next) {
  handle(req, res, next, async () => {
    const batchId = String(req.params.batchId || '').trim();
    if (!batchId || batchId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(batchId)) {
      return res.status(400).json({ error: 'Invalid batch id' });
    }
    const { paid_at } = z.object({ paid_at: z.string().trim() }).parse(req.body);

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

    const client = await pool.connect();
    let rows = [];
    try {
      await client.query('BEGIN');

      const r = await client.query(
        `DELETE FROM hub_payments
          WHERE payment_batch_id = $1
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

        const pi = await client.query(
          `SELECT amount_paid, payout_schedule FROM purchase_invoices WHERE id = $1`, [piId]
        );
        if (pi.rows[0]?.payout_schedule === 'split') {
          const schedule = await client.query(
            `SELECT id, amount_due FROM pi_payment_schedule WHERE purchase_invoice_id=$1 ORDER BY installment_no`,
            [piId]
          );
          let remaining = parseFloat(pi.rows[0].amount_paid);
          for (const inst of schedule.rows) {
            const due     = parseFloat(inst.amount_due);
            const paidAmt = Math.min(remaining, due);
            const instStatus = paidAmt <= 0 ? 'pending' : paidAmt >= due ? 'paid' : 'partially_paid';
            await client.query(
              `UPDATE pi_payment_schedule SET paid_amount=$1, status=$2, updated_at=NOW() WHERE id=$3`,
              [paidAmt.toFixed(2), instStatus, inst.id]
            );
            remaining = Math.max(0, remaining - paidAmt);
          }
        }
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
// Blocked if payment_status = 'paid' or any payment exists.
// ─────────────────────────────────────────────────────────────────────────────
function updatePurchaseInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

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
    if (pi.payment_status === 'paid' || parseFloat(pi.amount_paid) > 0) {
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
        const gstAmt     = roundFn(hubAmount * gstPct / 100);
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
// Blocked if PI payment_status = 'paid'.
// ─────────────────────────────────────────────────────────────────────────────
function syncPurchaseInvoiceFromEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const piRow = await pool.query(
      `SELECT pi.id, pi.estimate_id, pi.hub_id, pi.rate_mode, pi.commission_percent,
              pi.payment_status, pi.created_at
       FROM purchase_invoices pi WHERE pi.id = $1`,
      [id]
    );
    if (!piRow.rows[0]) return res.status(404).json({ error: 'Purchase invoice not found' });
    const pi = piRow.rows[0];

    if (pi.payment_status === 'paid') {
      return res.status(400).json({ error: 'Cannot sync — Purchase Invoice is already paid.' });
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
    const totalIncGstSum  = itemsRow.rows.reduce((s, it) => s + Number(it.total_inc_gst ?? 0), 0);
    let txDiscountTotal = 0;
    if (txDiscountMode === 'transaction' && txDiscountValue > 0 && totalIncGstSum > 0) {
      txDiscountTotal = txDiscountType === 'percent'
        ? roundFn(totalIncGstSum * txDiscountValue / 100)
        : Math.min(txDiscountValue, totalIncGstSum);
    }

    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const items = itemsRow.rows.map(item => {
      const qty    = Number(item.quantity);
      const gstPct = Number(item.gst_percent);

      const itemIncGst     = Number(item.total_inc_gst ?? 0);
      const itemTxDiscount = txDiscountTotal > 0 && totalIncGstSum > 0
        ? roundFn(itemIncGst / totalIncGstSum * txDiscountTotal, 4)
        : 0;
      const postDiscIncGst = roundFn(itemIncGst - itemTxDiscount, 4);
      const custRate       = roundFn(postDiscIncGst / qty / (1 + gstPct / 100), 4);

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
      const gstAmount    = roundFn(hubAmount * gstPct / 100);
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
                (SELECT MAX(p.paid_at) FROM customer_invoice_payments p
                  WHERE p.customer_invoice_id = c.id) AS ci_last_paid_at
           FROM customer_invoices c
          WHERE c.purchase_invoice_id = pi.id OR c.estimate_id = pi.estimate_id
          ORDER BY (c.purchase_invoice_id = pi.id) DESC, c.id
          LIMIT 1
       ) ci ON TRUE
       WHERE pi.status = 'approved' AND pi.payment_status != 'paid'
       ORDER BY pi.payout_due_date ASC NULLS LAST`,
      [today]
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

    if (req.query.hub_id) {
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
    const r = await pool.query(
      `SELECT
         SUM((pii.customer_rate - pii.hub_rate) * pii.quantity)                              AS total_ex_gst,
         SUM((pii.customer_rate - pii.hub_rate) * pii.quantity * (1 + pii.gst_percent/100)) AS total_inc_gst
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
       WHERE pi.status = 'approved'
         AND pi.rate_mode = 'tech_rate'`
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
      const conditions = ["pi.status = 'approved'", "pi.payment_status != 'paid'"];
      const params = [];

      if (hubId) {
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

      if (hubId) {
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

      await client.query(
        `UPDATE purchase_invoices
         SET status = 'pending_approval',
             approved_by = NULL,
             approved_at = NULL,
             payout_due_date = NULL,
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

module.exports = { listPurchaseInvoices, getPurchaseInvoice, getPurchaseInvoicePdf, getPurchaseInvoiceByToken, generatePurchaseInvoice, approvePurchaseInvoice, rejectPurchaseInvoiceApproval, updatePurchaseInvoice, addHubPayment, deleteHubPayment, deleteHubPaymentBatch, updateHubPaymentDate, updateHubPaymentBatchDate, listPayouts, recalculatePurchaseInvoice, syncPurchaseInvoiceFromEstimate, listHubPayments, getTechRateSummary, bulkPayment, exportPayouts };
