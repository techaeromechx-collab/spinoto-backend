'use strict';

/**
 * Estimates controller
 *
 * Endpoints:
 *   GET    /api/estimates                          — list with filters
 *   POST   /api/estimates                          — create estimate (draft)
 *   GET    /api/estimates/:id                      — full detail with items
 *   PATCH  /api/estimates/:id                      — update notes/items (draft/revision_requested only)
 *   POST   /api/estimates/:id/submit               — hub submits for company review
 *   POST   /api/estimates/:id/company-approve      — company approves → sent_to_customer
 *   POST   /api/estimates/:id/company-revise       — company requests revision
 *   POST   /api/estimates/:id/customer-approval    — company marks customer item approvals
 */

const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

// ─── Validators ───────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();

const itemSchema = z.object({
  item_type:    z.enum(['service', 'part']),
  service_id:   z.coerce.number().int().positive().optional().nullable(),
  part_id:      z.coerce.number().int().positive().optional().nullable(),
  item_id:      z.coerce.number().int().positive().optional().nullable(),  // frontend unified field
  description:  z.string().trim().min(1).max(300),
  quantity:     z.coerce.number().positive().default(1),
  customer_rate: z.coerce.number().nonnegative(),
  gst_percent:  z.coerce.number().min(0).max(100).default(0),
  is_from_appointment: z.boolean().optional().default(false),
  discount_type:   z.enum(['percent', 'flat']).optional().nullable(),
  discount_value:  z.coerce.number().nonnegative().optional().default(0),
  discount_amount: z.coerce.number().nonnegative().optional().default(0),
  discount_source: z.enum(['master', 'manual']).optional().nullable(),
});

const createSchema = z.object({
  appointment_id: z.coerce.number().int().positive(),
  hub_id:         z.coerce.number().int().positive().optional().nullable(),
  notes:          z.string().trim().max(3000).optional().nullable(),
  items:          z.array(itemSchema).optional().default([]),
});

const updateSchema = z.object({
  notes: z.string().trim().max(3000).optional().nullable(),
  items: z.array(itemSchema).optional(),
});

const customerApprovalSchema = z.object({
  approvals: z.array(z.object({
    item_id:  z.coerce.number().int().positive(),
    approved: z.boolean(),
  })).min(1, 'At least one approval entry is required'),
});

const companyReviseSchema = z.object({
  notes: z.string().trim().max(3000).optional().nullable(),
});

// ─── Error handler ────────────────────────────────────────────────────────────

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
      }
      next(err);
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeItem(data) {
  const qty         = Number(data.quantity)        || 1;
  const rate        = Number(data.customer_rate)   || 0; // ex-GST (stored at 4dp precision)
  const gstPct      = Number(data.gst_percent)     || 0;
  const discountAmt = Number(data.discount_amount) || 0;

  // Step 1: total inc-GST before discount
  const totalBeforeDisc = parseFloat((rate * qty * (1 + gstPct / 100)).toFixed(2));
  // Step 2: apply line-item discount
  const totalIncGst = parseFloat((Math.max(0, totalBeforeDisc - discountAmt)).toFixed(2));
  // Step 3: back-calculate ex-GST from the discounted total (correct for Indian GST)
  const exGstTotal  = gstPct > 0
    ? parseFloat((totalIncGst / (1 + gstPct / 100)).toFixed(2))
    : totalIncGst;
  // Step 4: GST = total − exGST (NOT exGST × rate — prevents cumulative ₹0.01 drift)
  const gstAmount   = parseFloat((totalIncGst - exGstTotal).toFixed(2));
  return { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt };
}

async function recalcTotals(client, estimateId) {
  // subtotal_ex_gst = sum of post-discount ex-GST amounts = total_inc_gst − gst_amount
  await client.query(`
    UPDATE estimates SET
      subtotal_ex_gst = (SELECT COALESCE(SUM(total_inc_gst - gst_amount), 0) FROM estimate_items WHERE estimate_id = $1),
      total_gst       = (SELECT COALESCE(SUM(gst_amount), 0)                 FROM estimate_items WHERE estimate_id = $1),
      grand_total     = (SELECT COALESCE(SUM(total_inc_gst), 0)              FROM estimate_items WHERE estimate_id = $1),
      updated_at      = NOW()
    WHERE id = $1
  `, [estimateId]);
}

async function _getItems(estimateId) {
  const r = await pool.query(
    `SELECT
       ei.id,
       ei.estimate_id,
       ei.item_type,
       ei.description,
       ei.quantity,
       ei.customer_rate,
       ei.gst_percent,
       ei.gst_amount,
       ei.total_inc_gst,
       ei.is_from_appointment,
       ei.customer_approved,
       ei.work_status,
       ei.discount_type,
       ei.discount_value,
       ei.discount_amount,
       ei.discount_source,
       ei.created_at,
       ei.updated_at,
       COALESCE(ei.hsn_sac, s.sac_code, p.hsn_code) AS hsn_sac,
       s.id   AS service_id,   s.name  AS service_name,
       p.id   AS part_id,      p.name  AS part_name
     FROM estimate_items ei
     LEFT JOIN services s ON s.id = ei.service_id
     LEFT JOIN parts    p ON p.id = ei.part_id
     WHERE ei.estimate_id = $1
     ORDER BY ei.id`,
    [estimateId]
  );
  return r.rows;
}

// ─── Full SELECT fragment ─────────────────────────────────────────────────────

const EST_SELECT = `
  SELECT
    e.id,
    e.appointment_id,
    e.hub_id,
    e.status,
    e.notes,
    e.subtotal_ex_gst,
    e.total_gst,
    e.grand_total,
    e.reviewed_by,
    e.reviewed_at,
    e.created_by,
    e.created_at,
    e.updated_at,

    -- Appointment info
    a.customer_name,
    a.mobile,
    a.vehicle_number,
    a.scheduled_date,

    -- Vehicle details
    vt.name  AS vehicle_type_name,
    vm.name  AS make_name,
    vmod.name AS model_name,
    bt.name  AS body_type_name,
    cc.name  AS cc_category_name,
    cc.min_cc,
    cc.max_cc,
    vmod.engine_cc,
    (SELECT string_agg(sg.name, ', ') FROM segments sg WHERE sg.id = ANY(a.segment_ids)) AS segment_names,

    -- Hub
    h.hub_name,

    -- Reviewer
    rv.name  AS reviewed_by_name,

    -- Creator
    u.name   AS created_by_name,

    -- Item count
    (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id) AS item_count,

    -- Linked customer invoice (null if not yet generated)
    (SELECT ci.id FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_id,

    -- Linked purchase invoice (id + status, so UI can gate CI generation)
    (SELECT pi.id     FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_id,
    (SELECT pi.status FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_status

  FROM estimates e
  LEFT JOIN appointments  a    ON a.id    = e.appointment_id
  LEFT JOIN vehicle_types vt   ON vt.id   = a.vehicle_type_id
  LEFT JOIN vehicle_makes vm   ON vm.id   = a.make_id
  LEFT JOIN vehicle_models vmod ON vmod.id = a.model_id
  LEFT JOIN body_types     bt   ON bt.id   = a.body_type_id
  LEFT JOIN cc_categories  cc   ON cc.id   = a.cc_category_id
  LEFT JOIN hubs           h    ON h.id    = e.hub_id
  LEFT JOIN users          rv   ON rv.id   = e.reviewed_by
  LEFT JOIN users          u    ON u.id    = e.created_by
`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates — List
// ─────────────────────────────────────────────────────────────────────────────
function listEstimates(req, res, next) {
  handle(req, res, next, async () => {
    const appointmentId = req.query.appointment_id || '';
    const hubId         = req.query.hub_id         || '';
    const status        = req.query.status         || '';
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    if (appointmentId) { params.push(Number(appointmentId)); conditions.push(`e.appointment_id = $${params.length}`); }
    if (hubId)         { params.push(Number(hubId));         conditions.push(`e.hub_id = $${params.length}`); }
    if (status)        { params.push(status);                conditions.push(`e.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `${EST_SELECT} ${where} ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM estimates e ${where}`, params),
    ]);

    return res.json({
      items: dataRes.rows,
      total: countRes.rows[0]?.total || 0,
      page,
      limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates/:id — Detail
// ─────────────────────────────────────────────────────────────────────────────
function getEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates — Create
// ─────────────────────────────────────────────────────────────────────────────
function createEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);

    // Validate appointment exists
    const apptCheck = await pool.query(
      `SELECT id FROM appointments WHERE id = $1`,
      [data.appointment_id]
    );
    if (!apptCheck.rows[0]) {
      return res.status(400).json({ error: `Appointment #${data.appointment_id} not found.` });
    }

    // Guard: only one estimate per appointment
    const dupCheck = await pool.query(
      `SELECT id, status FROM estimates WHERE appointment_id = $1 LIMIT 1`,
      [data.appointment_id]
    );
    if (dupCheck.rows[0]) {
      return res.status(409).json({
        error: `An estimate already exists for appointment #${data.appointment_id} (estimate #${dupCheck.rows[0].id}, status: ${dupCheck.rows[0].status}).`,
        existing_estimate_id: dupCheck.rows[0].id,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO estimates (appointment_id, hub_id, status, notes, created_by)
         VALUES ($1, $2, 'draft', $3, $4)
         RETURNING id`,
        [data.appointment_id, data.hub_id, data.notes || null, req.user.id]
      );

      const estimateId = ins.rows[0].id;

      for (const item of data.items) {
        const { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt } = computeItem(item);
        const svcId  = item.item_type === 'service' ? (item.service_id || item.item_id || null) : null;
        const partId = item.item_type === 'part'    ? (item.part_id    || item.item_id || null) : null;
        await client.query(
          `INSERT INTO estimate_items
             (estimate_id, item_type, service_id, part_id, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst,
              is_from_appointment, hsn_sac,
              discount_type, discount_value, discount_amount, discount_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE(
               (SELECT sac_code FROM services WHERE id = $3),
               (SELECT hsn_code FROM parts    WHERE id = $4)
             ),
             $12,$13,$14,$15)`,
          [
            estimateId,
            item.item_type,
            svcId,
            partId,
            item.description,
            qty,
            rate,
            gstPct,
            gstAmount,
            totalIncGst,
            item.is_from_appointment ?? false,
            item.discount_type   || null,
            item.discount_value  || 0,
            discountAmt,
            item.discount_source || null,
          ]
        );
      }

      await recalcTotals(client, estimateId);
      await client.query('COMMIT');

      const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [estimateId]);
      const estimate = row.rows[0];
      estimate.items = await _getItems(estimateId);

      return res.status(201).json({ item: estimate });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/estimates/:id — Update (draft / revision_requested only)
// ─────────────────────────────────────────────────────────────────────────────
function updateEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    const { status } = cur.rows[0];
    if (!['draft', 'revision_requested'].includes(status)) {
      return res.status(409).json({
        error: `Estimate cannot be edited in status '${status}'. Only draft or revision_requested estimates are editable.`,
      });
    }

    if (data.notes === undefined && data.items === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (data.notes !== undefined) {
        await client.query(
          `UPDATE estimates SET notes = $1, updated_at = NOW() WHERE id = $2`,
          [data.notes, id]
        );
      }

      if (data.items !== undefined) {
        // Full replace
        await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [id]);
        for (const item of data.items) {
          const { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt } = computeItem(item);
          const svcId  = item.item_type === 'service' ? (item.service_id || item.item_id || null) : null;
          const partId = item.item_type === 'part'    ? (item.part_id    || item.item_id || null) : null;
          await client.query(
            `INSERT INTO estimate_items
               (estimate_id, item_type, service_id, part_id, description,
                quantity, customer_rate, gst_percent, gst_amount, total_inc_gst,
                is_from_appointment, hsn_sac,
                discount_type, discount_value, discount_amount, discount_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE(
                 (SELECT sac_code FROM services WHERE id = $3),
                 (SELECT hsn_code FROM parts    WHERE id = $4)
               ),
               $12,$13,$14,$15)`,
            [
              id,
              item.item_type,
              svcId,
              partId,
              item.description,
              qty,
              rate,
              gstPct,
              gstAmount,
              totalIncGst,
              item.is_from_appointment ?? false,
              item.discount_type   || null,
              item.discount_value  || 0,
              discountAmt,
              item.discount_source || null,
            ]
          );
        }
        await recalcTotals(client, id);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/submit — Hub submits for company review
// ─────────────────────────────────────────────────────────────────────────────
function submitEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    const { status } = cur.rows[0];
    if (!['draft', 'revision_requested'].includes(status)) {
      return res.status(409).json({
        error: `Only draft or revision_requested estimates can be submitted. Current status: '${status}'.`,
      });
    }

    // Must have at least 1 item
    const itemCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM estimate_items WHERE estimate_id = $1`,
      [id]
    );
    if (itemCount.rows[0].cnt === 0) {
      return res.status(400).json({ error: 'Estimate must have at least one item before submitting.' });
    }

    await pool.query(
      `UPDATE estimates SET status = 'pending_company_review', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);

    // Auto-advance appointment status
    await advanceAppointmentStatus(estimate.appointment_id, 'estimate-submitted');

    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/company-approve — Company approves → sent_to_customer
// ─────────────────────────────────────────────────────────────────────────────
function companyApprove(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    if (cur.rows[0].status !== 'pending_company_review') {
      return res.status(409).json({
        error: `Only estimates in 'pending_company_review' can be approved. Current status: '${cur.rows[0].status}'.`,
      });
    }

    await pool.query(
      `UPDATE estimates
       SET status = 'sent_to_customer', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, id]
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);

    // Auto-advance appointment status
    await advanceAppointmentStatus(estimate.appointment_id, 'estimate-approved');

    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/company-revise — Company requests revision
// ─────────────────────────────────────────────────────────────────────────────
function companyRevise(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = companyReviseSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    if (cur.rows[0].status !== 'pending_company_review') {
      return res.status(409).json({
        error: `Only estimates in 'pending_company_review' can be sent back for revision. Current status: '${cur.rows[0].status}'.`,
      });
    }

    const fields = [`status = 'revision_requested'`, `updated_at = NOW()`];
    const params = [];

    if (data.notes !== undefined) {
      params.push(data.notes);
      fields.push(`notes = $${params.length}`);
    }

    params.push(id);
    await pool.query(
      `UPDATE estimates SET ${fields.join(', ')} WHERE id = $${params.length}`,
      params
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/customer-approval — Company marks customer approvals
// ─────────────────────────────────────────────────────────────────────────────
function customerApproval(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = customerApprovalSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    if (cur.rows[0].status !== 'sent_to_customer') {
      return res.status(409).json({
        error: `Customer approvals can only be recorded when status is 'sent_to_customer'. Current status: '${cur.rows[0].status}'.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const { item_id, approved } of data.approvals) {
        await client.query(
          `UPDATE estimate_items
           SET customer_approved = $1, updated_at = NOW()
           WHERE id = $2 AND estimate_id = $3`,
          [approved, item_id, id]
        );
      }

      // Reset work_status to 'pending' for all approved items (handles re-approval)
      await client.query(
        `UPDATE estimate_items SET work_status = 'pending' WHERE estimate_id = $1 AND customer_approved = true`,
        [id]
      );

      // Determine new status based on all items
      const itemStats = await client.query(
        `SELECT
           COUNT(*)::int                                           AS total,
           COUNT(*) FILTER (WHERE customer_approved = TRUE)::int  AS approved_count,
           COUNT(*) FILTER (WHERE customer_approved = FALSE)::int AS rejected_count,
           COUNT(*) FILTER (WHERE customer_approved IS NULL)::int AS pending_count
         FROM estimate_items
         WHERE estimate_id = $1`,
        [id]
      );

      const { total, approved_count, rejected_count } = itemStats.rows[0];

      let newStatus;
      if (approved_count === total) {
        newStatus = 'fully_approved';
      } else if (approved_count > 0) {
        newStatus = 'partially_approved';
      } else if (rejected_count === total) {
        // All rejected — send back for revision
        newStatus = 'revision_requested';
      } else {
        // Some still pending — stay in sent_to_customer
        newStatus = 'sent_to_customer';
      }

      await client.query(
        `UPDATE estimates SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/estimates/:id/items/:itemId/work-status — Hub updates item work status
// ─────────────────────────────────────────────────────────────────────────────
function updateItemWorkStatus(req, res, next) {
  handle(req, res, next, async () => {
    const estimateId = idParam.parse(req.params.id);
    const itemId     = idParam.parse(req.params.itemId);

    const { work_status } = z.object({
      work_status: z.enum(['pending', 'in_progress', 'completed']),
    }).parse(req.body);

    // Validate item belongs to this estimate and is customer_approved
    const itemRow = await pool.query(
      `SELECT id, customer_approved FROM estimate_items WHERE id = $1 AND estimate_id = $2`,
      [itemId, estimateId]
    );
    if (itemRow.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    if (!itemRow.rows[0].customer_approved) {
      return res.status(400).json({ error: 'Cannot update work status for a rejected or pending-approval item' });
    }

    // Validate estimate is in a workable state
    const estRow = await pool.query(`SELECT status FROM estimates WHERE id = $1`, [estimateId]);
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const allowedStatuses = ['fully_approved', 'partially_approved', 'work_in_progress', 'work_completed'];
    if (!allowedStatuses.includes(estRow.rows[0].status)) {
      return res.status(400).json({ error: `Work cannot be updated when estimate is in status: ${estRow.rows[0].status}` });
    }

    let newEstStatus;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update the item
      await client.query(
        `UPDATE estimate_items SET work_status = $1, updated_at = NOW() WHERE id = $2`,
        [work_status, itemId]
      );

      // Derive new estimate status from all approved items' work_status
      const allItems = await client.query(
        `SELECT work_status FROM estimate_items WHERE estimate_id = $1 AND customer_approved = true`,
        [estimateId]
      );
      const statuses = allItems.rows.map(r => r.work_status);
      if (statuses.every(s => s === 'completed')) {
        newEstStatus = 'work_completed';
      } else if (statuses.some(s => s === 'in_progress' || s === 'completed')) {
        newEstStatus = 'work_in_progress';
      } else {
        // all pending — revert to approved state
        // check if partially or fully approved
        const approvalCheck = await client.query(
          `SELECT COUNT(*) FILTER (WHERE customer_approved = true)  AS approved_count,
                  COUNT(*) FILTER (WHERE customer_approved = false) AS rejected_count
           FROM estimate_items WHERE estimate_id = $1`,
          [estimateId]
        );
        const { approved_count, rejected_count } = approvalCheck.rows[0];
        newEstStatus = parseInt(rejected_count) > 0 ? 'partially_approved' : 'fully_approved';
      }

      await client.query(
        `UPDATE estimates SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newEstStatus, estimateId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Return updated estimate
    const est = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [estimateId]);
    const items = await _getItems(estimateId);

    // Auto-advance appointment status based on work state
    const apptId = est.rows[0]?.appointment_id;
    if (newEstStatus === 'work_in_progress') {
      await advanceAppointmentStatus(apptId, 'work-in-progress');
    } else if (newEstStatus === 'work_completed') {
      await advanceAppointmentStatus(apptId, 'work-completed');
    }

    return res.json({ item: { ...est.rows[0], items } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  submitEstimate,
  companyApprove,
  companyRevise,
  customerApproval,
  updateItemWorkStatus,
};
