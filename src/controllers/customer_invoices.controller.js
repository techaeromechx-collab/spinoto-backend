'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

const CI_SELECT = `
  SELECT
    ci.id, ci.purchase_invoice_id, ci.estimate_id, ci.appointment_id, ci.hub_id,
    -- Fall back to appointment data if CI columns were stored as null
    COALESCE(ci.customer_name, a.customer_name) AS customer_name,
    COALESCE(ci.mobile,        a.mobile)        AS mobile,
    COALESCE(ci.vehicle_number, a.vehicle_number) AS vehicle_number,
    ci.status, ci.subtotal_ex_gst, ci.total_gst, ci.grand_total, ci.amount_paid,
    ci.notes, ci.created_at, ci.updated_at,
    ci.discount_mode, ci.transaction_discount_type,
    ci.transaction_discount_value, ci.transaction_discount_amount,
    ('Spinoto ' || ar.name) AS hub_name, h.gst_number AS hub_gst,
    (ci.grand_total - ci.amount_paid) AS balance,
    (SELECT COUNT(*)::int FROM customer_invoice_payments cip WHERE cip.customer_invoice_id = ci.id) AS payment_count,
    (SELECT pi.id FROM purchase_invoices pi WHERE pi.estimate_id = ci.estimate_id LIMIT 1) AS linked_purchase_invoice_id,

    -- Vehicle details from linked appointment
    vt.name   AS vehicle_type_name,
    vm.name   AS make_name,
    vmod.name AS model_name,
    bt.name   AS body_type_name,
    cc.name   AS cc_category_name,
    cc.min_cc,
    cc.max_cc,
    vmod.engine_cc,
    (SELECT string_agg(sg.name, ', ') FROM segments sg WHERE sg.id = ANY(a.segment_ids)) AS segment_names

  FROM customer_invoices ci
  LEFT JOIN hubs           h    ON h.id    = ci.hub_id
  LEFT JOIN areas          ar   ON ar.id   = h.area_id
  LEFT JOIN appointments   a    ON a.id    = ci.appointment_id
  LEFT JOIN vehicle_types  vt   ON vt.id   = a.vehicle_type_id
  LEFT JOIN vehicle_makes  vm   ON vm.id   = a.make_id
  LEFT JOIN vehicle_models vmod ON vmod.id = a.model_id
  LEFT JOIN body_types     bt   ON bt.id   = a.body_type_id
  LEFT JOIN cc_categories  cc   ON cc.id   = a.cc_category_id
`;

async function _getItems(ciId) {
  const r = await pool.query(
    `SELECT id, estimate_item_id, item_type, description, quantity,
            customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac,
            discount_type, discount_value, discount_amount
     FROM customer_invoice_items WHERE customer_invoice_id = $1 ORDER BY id`,
    [ciId]
  );
  return r.rows;
}

async function _getPayments(ciId) {
  const r = await pool.query(
    `SELECT cip.id, cip.amount, cip.method, cip.reference_no, cip.paid_at, cip.notes,
            u.name AS created_by_name
     FROM customer_invoice_payments cip
     LEFT JOIN users u ON u.id = cip.created_by
     WHERE cip.customer_invoice_id = $1 ORDER BY cip.paid_at ASC`,
    [ciId]
  );
  return r.rows;
}

async function _recalcStatus(client, ciId) {
  const r = await client.query(
    `SELECT ci.grand_total, ci.status AS current_status, ci.appointment_id,
            COALESCE(SUM(p.amount),0) AS paid
     FROM customer_invoices ci
     LEFT JOIN customer_invoice_payments p ON p.customer_invoice_id = ci.id
     WHERE ci.id = $1 GROUP BY ci.grand_total, ci.status, ci.appointment_id`,
    [ciId]
  );
  const { grand_total, current_status, appointment_id, paid } = r.rows[0];
  const amtPaid = parseFloat(paid);
  const total   = parseFloat(grand_total);

  let status;
  if (amtPaid >= total && total > 0) {
    status = 'paid';
  } else if (amtPaid > 0) {
    status = 'partially_paid';
  } else {
    // Preserve 'approved' if company already approved — don't revert to 'generated'
    status = current_status === 'approved' ? 'approved' : 'generated';
  }

  await client.query(
    `UPDATE customer_invoices SET amount_paid=$1, status=$2, updated_at=NOW() WHERE id=$3`,
    [amtPaid.toFixed(2), status, ciId]
  );

  return { status, appointment_id };
}

function listCustomerInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const conditions = [], params = [];

    // ── User scoping ──────────────────────────────────────────────────────────
    // Super admins and VIEW_INVOICE users see all. Others see only their own.
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_INVOICE');
    if (!isAll) {
      params.push(req.user.id);
      conditions.push(
        `EXISTS (SELECT 1 FROM estimates e WHERE e.id = ci.estimate_id AND e.created_by = $${params.length})`
      );
    }

    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const n = params.length;
      conditions.push(`(ci.customer_name ILIKE $${n} OR ci.mobile ILIKE $${n} OR ci.vehicle_number ILIKE $${n})`);
    }
    if (req.query.hub_id) { params.push(Number(req.query.hub_id)); conditions.push(`ci.hub_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status);         conditions.push(`ci.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [dataRes, countRes] = await Promise.all([
      pool.query(`${CI_SELECT} ${where} ORDER BY ci.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) FROM customer_invoices ci ${where}`, params),
    ]);
    res.json({ items: dataRes.rows, total: parseInt(countRes.rows[0].count, 10), page, limit });
  });
}

function getCustomerInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    const item = r.rows[0];
    item.items    = await _getItems(id);
    item.payments = await _getPayments(id);
    res.json({ item });
  });
}

function addPayment(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = z.object({
      amount:       z.coerce.number().positive(),
      method:       z.enum(['cash','upi','card','bank_transfer','other']).default('cash'),
      reference_no: z.string().trim().max(100).optional().nullable(),
      paid_at:      z.string().optional().nullable(),
      notes:        z.string().trim().max(500).optional().nullable(),
    }).parse(req.body);

    const ciRow = await pool.query(`SELECT status, grand_total, amount_paid FROM customer_invoices WHERE id = $1`, [id]);
    if (!ciRow.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
    const ci = ciRow.rows[0];
    if (['paid','cancelled'].includes(ci.status)) return res.status(400).json({ error: `Cannot add payment to a ${ci.status} invoice` });

    const balance = parseFloat(ci.grand_total) - parseFloat(ci.amount_paid);
    if (data.amount > balance + 0.01) {
      return res.status(400).json({ error: `Payment amount ₹${data.amount} exceeds outstanding balance ₹${balance.toFixed(2)}` });
    }

    const client = await pool.connect();
    let recalcResult;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO customer_invoice_payments (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()),$6,$7)`,
        [id, data.amount, data.method, data.reference_no||null, data.paid_at||null, data.notes||null, req.user?.id||null]
      );
      recalcResult = await _recalcStatus(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Auto-advance appointment → CLOSED when CI is fully paid
    if (recalcResult?.status === 'paid') {
      await advanceAppointmentStatus(recalcResult.appointment_id, 'closed');
    }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.status(201).json({ item: full.rows[0] });
  });
}

function deletePayment(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const payId = idParam.parse(req.params.payId);

    const r = await pool.query(`DELETE FROM customer_invoice_payments WHERE id=$1 AND customer_invoice_id=$2`, [payId, id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Payment not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await _recalcStatus(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/customer-invoices/from-estimate — Generate CI from a work_completed
//   estimate. REQUIRES an approved Purchase Invoice to exist first.
//   Flow: Estimate → PI (hub payout) → Approve PI → CI → Approve CI → Pay CI → CLOSED
// ─────────────────────────────────────────────────────────────────────────────
function generateCustomerInvoiceFromEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const { estimate_id } = z.object({ estimate_id: z.coerce.number().int().positive() }).parse(req.body);

    // Validate estimate exists and is work_completed
    const estRow = await pool.query(
      `SELECT e.id, e.status, e.appointment_id, e.hub_id,
              e.discount_mode, e.transaction_discount_type,
              e.transaction_discount_value, e.transaction_discount_amount
       FROM estimates e WHERE e.id = $1`,
      [estimate_id]
    );
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const est = estRow.rows[0];
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

    // Pull appointment details for the CI header
    const apptRow = await pool.query(
      `SELECT customer_name, mobile, vehicle_number FROM appointments WHERE id = $1`,
      [est.appointment_id]
    );
    const appt = apptRow.rows[0] || {};

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
    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const ciItems = itemsRow.rows.map(item => {
      const totalIncGst = parseFloat(item.total_inc_gst) || 0;
      const gstAmt      = parseFloat(item.gst_amount)    || 0;
      const amtExGst    = parseFloat((totalIncGst - gstAmt).toFixed(2));
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
        txDiscountAmount = parseFloat((grandTotal * txDiscountValue / 100).toFixed(2));
      } else if (txDiscountType === 'flat') {
        txDiscountAmount = Math.min(txDiscountValue, grandTotal);
      }
      grandTotal = parseFloat((grandTotal - txDiscountAmount).toFixed(2));
    }

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
            transaction_discount_value, transaction_discount_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          estimate_id, est.appointment_id, est.hub_id,
          appt.customer_name || null, appt.mobile || null, appt.vehicle_number || null,
          subtotalExGst.toFixed(2), totalGst.toFixed(2), grandTotal.toFixed(2),
          discountMode, txDiscountType,
          txDiscountValue, txDiscountAmount.toFixed(2),
        ]
      );
      const ciId = ciRow.rows[0].id;

      for (const item of ciItems) {
        await client.query(
          `INSERT INTO customer_invoice_items
             (customer_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac,
              discount_type, discount_value, discount_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [ciId, item.id, item.item_type, item.description,
           item.quantity, item.customer_rate, item.gst_percent,
           item.gst_amount.toFixed(2), item.total_inc_gst.toFixed(2),
           item.hsn_sac || null,
           item.discount_type || null, item.discount_value || 0, item.discount_amount || 0]
        );
      }
      await client.query('COMMIT');

      // Advance appointment → Invoice Generated
      await advanceAppointmentStatus(est.appointment_id, 'invoice-generated');

      const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [ciId]);
      full.rows[0].items    = await _getItems(ciId);
      full.rows[0].payments = [];
      res.status(201).json({ item: full.rows[0] });
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
      `SELECT status, appointment_id FROM customer_invoices WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
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

    const full = await pool.query(`${CI_SELECT} WHERE ci.id = $1`, [id]);
    full.rows[0].items    = await _getItems(id);
    full.rows[0].payments = await _getPayments(id);
    res.json({ item: full.rows[0] });
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
        ('Spinoto ' || ar.name) AS hub_name,
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
            = UPPER(REPLACE($1, ' ', ''))
      GROUP BY ci.id, a.customer_name, a.mobile, a.vehicle_number, ar.name
      ORDER BY ci.created_at DESC
      LIMIT 50
    `, [vnum]);

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
      `SELECT id, estimate_id, status FROM customer_invoices WHERE id = $1`, [id]
    );
    if (!ciRow.rows[0]) return res.status(404).json({ error: 'Customer invoice not found' });
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

    // Use the estimate items' STORED amounts — discounts + GST already baked
    // in, so CI totals always match the estimate (see generate handler).
    let subtotalExGst = 0, totalGst = 0, grandTotal = 0;
    const ciItems = itemsRow.rows.map(item => {
      const totalIncGst = parseFloat(item.total_inc_gst) || 0;
      const gstAmt      = parseFloat(item.gst_amount)    || 0;
      const amtExGst    = parseFloat((totalIncGst - gstAmt).toFixed(2));
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
        txDiscountAmount = parseFloat((grandTotal * txDiscountValue / 100).toFixed(2));
      } else if (txDiscountType === 'flat') {
        txDiscountAmount = Math.min(txDiscountValue, grandTotal);
      }
      grandTotal = parseFloat((grandTotal - txDiscountAmount).toFixed(2));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Replace items
      await client.query(`DELETE FROM customer_invoice_items WHERE customer_invoice_id = $1`, [id]);
      for (const item of ciItems) {
        await client.query(
          `INSERT INTO customer_invoice_items
             (customer_invoice_id, estimate_item_id, item_type, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac,
              discount_type, discount_value, discount_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, item.id, item.item_type, item.description,
            item.quantity, item.customer_rate, item.gst_percent,
            item.gst_amount, item.total_inc_gst, item.hsn_sac || null,
            item.discount_type || null, item.discount_value || 0, item.discount_amount || 0,
          ]
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

module.exports = { listCustomerInvoices, getCustomerInvoice, addPayment, deletePayment, approveCustomerInvoice, generateCustomerInvoiceFromEstimate, syncCustomerInvoiceFromEstimate, getVehicleHistory };
