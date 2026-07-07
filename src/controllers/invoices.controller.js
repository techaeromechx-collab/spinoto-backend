'use strict';

/**
 * Invoices controller
 *
 * Endpoints:
 *   POST   /api/invoices                  — create (from appointment or manual)
 *   GET    /api/invoices                  — list with filters
 *   GET    /api/invoices/:id              — full detail with line items
 *   PATCH  /api/invoices/:id              — update status / notes / discount
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { getRoundingFunction } = require('../utils/math');

// ─── Validators ───────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  appointment_id: z.coerce.number().int().positive().optional().nullable(),
  lead_id:        z.coerce.number().int().positive().optional().nullable(),
  customer_name:  z.string().trim().max(160).optional().nullable(),
  mobile:         z.string().trim().min(1).max(20),
  vehicle_number: z.string().trim().max(30).optional().nullable(),
  hub_id:         z.coerce.number().int().positive().optional().nullable(),
  status_id:      z.coerce.number().int().positive().optional().nullable(),
  discount:       z.coerce.number().nonnegative().optional().default(0),
  discount_type:  z.enum(['flat', 'percent']).optional().default('flat'),
  gst_rate:       z.coerce.number().min(0).max(100).optional().default(0),
  notes:          z.string().trim().max(3000).optional().nullable(),
  services: z.array(z.object({
    service_id:   z.coerce.number().int().positive().optional().nullable(),
    category_id:  z.coerce.number().int().positive().optional().nullable(),
    description:  z.string().trim().max(200).optional().nullable(),
    qty:          z.coerce.number().positive().optional().default(1),
    unit_price:   z.coerce.number().nonnegative(),
  })).min(1, 'At least one service line item is required'),
});

const updateSchema = z.object({
  status_id:     z.coerce.number().int().positive().optional().nullable(),
  discount:      z.coerce.number().nonnegative().optional(),
  discount_type: z.enum(['flat', 'percent']).optional(),
  gst_rate:      z.coerce.number().min(0).max(100).optional(),
  notes:         z.string().trim().max(3000).optional().nullable(),
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

// ─── Full SELECT fragment ─────────────────────────────────────────────────────

const INV_SELECT = `
  SELECT
    i.id,
    i.appointment_id,
    i.lead_id,
    i.customer_name,
    i.mobile,
    i.vehicle_number,
    i.subtotal,
    i.discount,
    COALESCE(i.discount_type, 'flat') AS discount_type,
    COALESCE(i.gst_rate, 0)           AS gst_rate,
    i.total,
    i.amount_paid,
    (i.total - i.amount_paid) AS outstanding,
    i.notes,
    i.created_at,
    i.updated_at,

    -- Hub
    h.id       AS hub_id,
    h.hub_name,

    -- Status
    ist.id       AS status_id,
    ist.name     AS status_name,
    ist.color    AS status_color,
    ist.bg_color AS status_bg,

    -- Creator
    u.id   AS created_by_id,
    u.name AS created_by_name

  FROM invoices i
  LEFT JOIN hubs            h   ON h.id   = i.hub_id
  LEFT JOIN invoice_statuses ist ON ist.id = i.status_id
  LEFT JOIN users           u   ON u.id   = i.created_by
`;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/invoices — Create
// ─────────────────────────────────────────────────────────────────────────────
function createInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);

    // Fix #17: verify appointment_id exists before inserting
    if (data.appointment_id) {
      const apptCheck = await pool.query(
        `SELECT id FROM appointments WHERE id = $1`,
        [data.appointment_id]
      );
      if (!apptCheck.rows[0]) {
        return res.status(400).json({ error: `Appointment #${data.appointment_id} not found.` });
      }
    }

    // Resolve default status
    let statusId = data.status_id;
    if (!statusId) {
      const defRow = await pool.query(
        `SELECT id FROM invoice_statuses WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`
      );
      statusId = defRow.rows[0]?.id || null;
    }

    const roundFn = getRoundingFunction(new Date());

    const subtotal      = data.services.reduce((sum, s) => sum + Number(s.unit_price) * Number(s.qty ?? 1), 0);
    const discountType  = data.discount_type || 'flat';
    const discountInput = Number(data.discount || 0);
    const gstRate       = Number(data.gst_rate || 0);
    const discountAmt   = discountType === 'percent'
      ? roundFn(subtotal * discountInput / 100)
      : discountInput;
    const afterDiscount = Math.max(0, subtotal - discountAmt);
    const gstAmount     = roundFn(afterDiscount * gstRate / 100);
    const total         = afterDiscount + gstAmount;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO invoices (
          appointment_id, lead_id, customer_name, mobile,
          vehicle_number, hub_id, status_id,
          subtotal, discount, discount_type, gst_rate, total, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id`,
        [
          data.appointment_id || null,
          data.lead_id        || null,
          data.customer_name  || null,
          data.mobile,
          data.vehicle_number || null,
          data.hub_id         || null,
          statusId,
          subtotal,
          discountAmt,
          discountType,
          gstRate,
          total,
          data.notes          || null,
          req.user.id,
        ]
      );

      const invoiceId = ins.rows[0].id;

      for (const svc of data.services) {
        const lineTotal = Number(svc.unit_price) * Number(svc.qty ?? 1);
        await client.query(
          `INSERT INTO invoice_services
             (invoice_id, service_id, category_id, description, qty, unit_price, total_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            invoiceId,
            svc.service_id   || null,
            svc.category_id  || null,
            svc.description  || null,
            svc.qty          ?? 1,
            svc.unit_price,
            lineTotal,
          ]
        );
      }

      await client.query('COMMIT');

      const row = await pool.query(`${INV_SELECT} WHERE i.id = $1`, [invoiceId]);
      const inv = row.rows[0];
      inv.services = await _getLines(invoiceId);

      logActivity({ userId: req.user?.id, userName: req.user?.name, action: 'CREATE', entity: 'invoice', entityId: invoiceId, description: `Created invoice #${invoiceId}` });
      return res.status(201).json({ item: inv });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/invoices — List
// ─────────────────────────────────────────────────────────────────────────────
function listInvoices(req, res, next) {
  handle(req, res, next, async () => {
    const search    = (req.query.search    || '').trim();
    const statusId  = req.query.status_id  || '';
    const hubId     = req.query.hub_id     || '';
    // Fix #13: date range filters
    const dateFrom  = req.query.date_from  || '';
    const dateTo    = req.query.date_to    || '';
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const n = params.length;
      conditions.push(
        `(LOWER(COALESCE(i.customer_name,'')) LIKE $${n}
          OR i.mobile LIKE $${n}
          OR LOWER(COALESCE(i.vehicle_number,'')) LIKE $${n})`
      );
    }
    if (statusId) { params.push(Number(statusId)); conditions.push(`i.status_id = $${params.length}`); }
    if (hubId)    { params.push(Number(hubId));    conditions.push(`i.hub_id    = $${params.length}`); }
    if (dateFrom) { params.push(dateFrom);         conditions.push(`i.created_at::date >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);           conditions.push(`i.created_at::date <= $${params.length}::date`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `${INV_SELECT} ${where} ORDER BY i.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM invoices i ${where}`, params),
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
// GET /api/invoices/:id — Detail
// ─────────────────────────────────────────────────────────────────────────────
function getInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const row = await pool.query(`${INV_SELECT} WHERE i.id = $1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    const inv = row.rows[0];
    inv.services = await _getLines(id);
    return res.json({ item: inv });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/invoices/:id — Update status / discount / notes
// ─────────────────────────────────────────────────────────────────────────────
function updateInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    const fields = [];
    const params = [];

    if (data.status_id !== undefined) { params.push(data.status_id); fields.push(`status_id = $${params.length}`); }
    if (data.notes     !== undefined) { params.push(data.notes);     fields.push(`notes     = $${params.length}`); }

    // If discount or gst_rate changed, recalculate total properly
    const needsRecalc = data.discount !== undefined || data.discount_type !== undefined || data.gst_rate !== undefined;
    if (needsRecalc) {
      // Fetch current row to get values we might not be changing
      const cur = await pool.query(`SELECT subtotal, discount, discount_type, gst_rate, created_at FROM invoices WHERE id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
      const c = cur.rows[0];
      const roundFn = getRoundingFunction(c.created_at);

      const discountType  = data.discount_type ?? c.discount_type ?? 'flat';
      const discountInput = data.discount      !== undefined ? Number(data.discount) : Number(c.discount);
      const gstRate       = data.gst_rate      !== undefined ? Number(data.gst_rate) : Number(c.gst_rate ?? 0);
      const subtotal      = Number(c.subtotal);

      const discountAmt   = discountType === 'percent'
        ? roundFn(subtotal * discountInput / 100)
        : discountInput;
      const afterDiscount = Math.max(0, subtotal - discountAmt);
      const gstAmount     = roundFn(afterDiscount * gstRate / 100);
      const total         = afterDiscount + gstAmount;

      params.push(discountAmt);   fields.push(`discount      = $${params.length}`);
      params.push(discountType);  fields.push(`discount_type = $${params.length}`);
      params.push(gstRate);       fields.push(`gst_rate      = $${params.length}`);
      params.push(total);         fields.push(`total         = $${params.length}`);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const r = await pool.query(
      `UPDATE invoices SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length} RETURNING id`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const row = await pool.query(`${INV_SELECT} WHERE i.id = $1`, [id]);
    const inv = row.rows[0];
    inv.services = await _getLines(id);
    return res.json({ item: inv });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────
async function _getLines(invoiceId) {
  const r = await pool.query(
    `SELECT
       ivs.id, ivs.qty, ivs.unit_price, ivs.total_price, ivs.description,
       s.id   AS service_id,   s.name  AS service_name,
       sc.id  AS category_id,  sc.name AS category_name
     FROM invoice_services ivs
     LEFT JOIN services           s  ON s.id  = ivs.service_id
     LEFT JOIN service_categories sc ON sc.id = ivs.category_id
     WHERE ivs.invoice_id = $1
     ORDER BY ivs.id`,
    [invoiceId]
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/invoices/vehicle-history/:vnum — service history for a vehicle number
// ─────────────────────────────────────────────────────────────────────────────
function getVehicleHistory(req, res, next) {
  handle(req, res, next, async () => {
    const vnum = (req.params.vnum || '').trim().toUpperCase();
    if (!vnum) return res.json({ items: [] });

    const r = await pool.query(`
      SELECT
        i.id, i.customer_name, i.mobile, i.vehicle_number,
        i.subtotal, i.discount, i.gst_rate, i.total, i.amount_paid,
        (i.total - i.amount_paid) AS outstanding,
        i.created_at,
        ist.name AS status_name, ist.color AS status_color, ist.bg_color AS status_bg,
        h.hub_name,
        COALESCE(json_agg(
          json_build_object(
            'service_name', COALESCE(s.name, ivs.description),
            'qty', ivs.qty,
            'unit_price', ivs.unit_price,
            'total_price', ivs.total_price
          ) ORDER BY ivs.id
        ) FILTER (WHERE ivs.id IS NOT NULL), '[]') AS services
      FROM invoices i
      LEFT JOIN invoice_statuses ist ON ist.id = i.status_id
      LEFT JOIN hubs h ON h.id = i.hub_id
      LEFT JOIN invoice_services ivs ON ivs.invoice_id = i.id
      LEFT JOIN services s ON s.id = ivs.service_id
      WHERE UPPER(REPLACE(i.vehicle_number, ' ', '')) = UPPER(REPLACE($1, ' ', ''))
      GROUP BY i.id, ist.name, ist.color, ist.bg_color, h.hub_name
      ORDER BY i.created_at DESC
      LIMIT 50
    `, [vnum]);

    res.json({ items: r.rows, vehicle_number: vnum });
  });
}

module.exports = { createInvoice, listInvoices, getInvoice, updateInvoice, getVehicleHistory };
