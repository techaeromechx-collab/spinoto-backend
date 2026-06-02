'use strict';

const { z }    = require('zod');
const { pool } = require('../config/db');

// ── Validators ────────────────────────────────────────────────────────────────
const partSchema = z.object({
  name:         z.string().trim().min(1).max(200),
  category:     z.string().trim().max(120).optional().nullable(),
  vehicle_type:  z.enum(['2W', '4W', 'both']).optional().nullable(),
  is_active:     z.boolean().optional(),
  customer_rate: z.coerce.number().min(0).optional().nullable(),
  gst_percent:   z.coerce.number().min(0).max(100).optional().nullable(),
  hsn_code:      z.string().trim().max(20).optional().nullable(),
});

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'A part with this name already exists.' });
    if (err.code === '23503')
      return res.status(409).json({ error: 'In use — cannot delete' });
    next(err);
  });
}

// ── LIST ──────────────────────────────────────────────────────────────────────
function listParts(req, res, next) {
  handle(req, res, next, async () => {
    const search      = req.query.search       ? `%${req.query.search}%` : null;
    const category    = req.query.category     || null;
    const vehicleType = req.query.vehicle_type || null;

    const r = await pool.query(
      `SELECT id, name, category, vehicle_type, is_active, customer_rate, gst_percent, hsn_code, created_at, updated_at
         FROM parts
        WHERE ($1::text IS NULL OR name ILIKE $1)
          AND ($2::text IS NULL OR LOWER(category) = LOWER($2))
          AND ($3::text IS NULL OR vehicle_type = $3)
        ORDER BY name ASC`,
      [search, category, vehicleType]
    );
    res.json({ items: r.rows });
  });
}

// ── CREATE ────────────────────────────────────────────────────────────────────
function createPart(req, res, next) {
  handle(req, res, next, async () => {
    const data = partSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO parts (name, category, vehicle_type, is_active, customer_rate, gst_percent, hsn_code)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), $5, $6, $7)
       RETURNING id, name, category, vehicle_type, is_active, customer_rate, gst_percent, hsn_code, created_at, updated_at`,
      [data.name, data.category ?? null, data.vehicle_type ?? null, data.is_active, data.customer_rate ?? null, data.gst_percent ?? null, data.hsn_code ?? null]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
function updatePart(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = partSchema.partial().parse(req.body);

    const fields = [];
    const values = [];
    let   n      = 1;

    if (data.name         !== undefined) { fields.push(`name = $${n++}`);         values.push(data.name); }
    if (data.category     !== undefined) { fields.push(`category = $${n++}`);     values.push(data.category ?? null); }
    if (data.vehicle_type !== undefined) { fields.push(`vehicle_type = $${n++}`); values.push(data.vehicle_type ?? null); }
    if (data.is_active      !== undefined) { fields.push(`is_active = $${n++}`);      values.push(data.is_active); }
    if (data.customer_rate  !== undefined) { fields.push(`customer_rate = $${n++}`);  values.push(data.customer_rate ?? null); }
    if (data.gst_percent    !== undefined) { fields.push(`gst_percent = $${n++}`);    values.push(data.gst_percent   ?? null); }
    if (data.hsn_code       !== undefined) { fields.push(`hsn_code = $${n++}`);       values.push(data.hsn_code      ?? null); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    const r = await pool.query(
      `UPDATE parts SET ${fields.join(', ')} WHERE id = $${n}
       RETURNING id, name, category, vehicle_type, is_active, customer_rate, gst_percent, hsn_code, created_at, updated_at`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Part not found' });
    res.json({ item: r.rows[0] });
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
function deletePart(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM parts WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Part not found' });
    res.status(204).end();
  });
}

module.exports = { listParts, createPart, updatePart, deletePart };
