'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { getRoundingFunction } = require('../utils/math');
const { syncPayoutDueDate } = require('../utils/payoutSchedule');
const { generatePublicToken, resolveTokenToId } = require('../utils/publicToken');

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
    pi.commission_percent, pi.rate_mode, pi.status,
    pi.subtotal_ex_gst, pi.total_gst, pi.grand_total,
    pi.notes, pi.approved_by, pi.approved_at,
    pi.created_by, pi.created_at, pi.updated_at,
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

    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const n = params.length;
      conditions.push(`(COALESCE(a.customer_name, est_ctx.customer_name) ILIKE $${n} OR COALESCE(a.mobile, est_ctx.mobile) ILIKE $${n} OR COALESCE(a.vehicle_number, est_ctx.vehicle_number) ILIKE $${n})`);
    }
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
      pool.query(`${PI_SELECT} ${where} ORDER BY pi.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) FROM purchase_invoices pi LEFT JOIN appointments a ON a.id = pi.appointment_id LEFT JOIN estimates est_ctx ON est_ctx.id = pi.estimate_id ${where}`, params),
    ]);
    res.json({ items: dataRes.rows, total: parseInt(countRes.rows[0].count, 10), page, limit });
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
    const { estimate_id } = z.object({ estimate_id: z.coerce.number().int().positive() }).parse(req.body);

    // Validate estimate
    const estRow = await pool.query(
      `SELECT e.id, e.status, e.appointment_id, e.hub_id,
              e.discount_mode, e.transaction_discount_type, e.transaction_discount_value
       FROM estimates e WHERE e.id = $1`, [estimate_id]
    );
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const est = estRow.rows[0];

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

      let appliedRatePct; // the % stored per-item for audit trail
      let hubRate;

      if (useCommission) {
        // Commission mode: hub earns (100 - commission)% of customer rate
        appliedRatePct = commissionPct;
        hubRate        = roundFn(custRate * (1 - commissionPct / 100), 4);
      } else {
        // Tech rate mode: tech_rate% is deducted from customer rate (platform fee)
        // Hub earns: customer_rate - (customer_rate × tech_rate%)
        const isService    = item.item_type === 'service';
        const techRate     = isService ? (techRateService ?? 0) : (techRateParts ?? 0);
        appliedRatePct     = techRate;
        const techDeduct   = roundFn(custRate * (techRate / 100), 4);
        hubRate            = roundFn(custRate - techDeduct, 4);
      }

      const hubAmount    = roundFn(hubRate * qty);
      const techDeductAmt = roundFn(custRate * qty) - hubAmount; // deduction for display
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
            subtotal_ex_gst, total_gst, grand_total, created_by, public_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          estimate_id, est.appointment_id, est.hub_id,
          useCommission ? commissionPct : 0,      // 0 when using tech_rate mode — column is NOT NULL
          rateMode,
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          req.user?.id || null,
          generatePublicToken(),
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

      await client.query(
        `UPDATE purchase_invoices
         SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW(),
             payout_due_date=NULL, payout_schedule=$2
         WHERE id=$3`,
        [req.user?.id || null, payout_schedule, id]
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
      paid_at:      z.string().optional().nullable(),
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
    const r = await pool.query(
      `DELETE FROM hub_payments WHERE id=$1 AND purchase_invoice_id=$2`, [payId, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Payment not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
    res.json({ item: full.rows[0] });
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
         (SELECT ci.id FROM customer_invoices ci
          WHERE ci.purchase_invoice_id = pi.id OR ci.estimate_id = pi.estimate_id
          LIMIT 1) AS customer_invoice_id,
         (SELECT ci.public_token FROM customer_invoices ci
          WHERE ci.purchase_invoice_id = pi.id OR ci.estimate_id = pi.estimate_id
          LIMIT 1) AS customer_invoice_token,
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
         hp.purchase_invoice_id,
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
          `INSERT INTO hub_payments (purchase_invoice_id, hub_id, amount, method, reference_no, paid_at, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7)`,
          [pi.id, pi.hub_id, payAmt.toFixed(2), method, reference_no||null, notes||null, req.user?.id||null]
        );
        await _recalcHubPaymentStatus(client, pi.id);
        results.push({ pi_id: pi.id, amount: payAmt });
      }

      await client.query('COMMIT');
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

module.exports = { listPurchaseInvoices, getPurchaseInvoice, getPurchaseInvoiceByToken, generatePurchaseInvoice, approvePurchaseInvoice, rejectPurchaseInvoiceApproval, updatePurchaseInvoice, addHubPayment, deleteHubPayment, listPayouts, recalculatePurchaseInvoice, syncPurchaseInvoiceFromEstimate, listHubPayments, getTechRateSummary, bulkPayment, exportPayouts };
