'use strict';

const { z }    = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

// ── Validators ────────────────────────────────────────────────────────────────
const discountBaseSchema = z.object({
  name:           z.string().trim().min(1).max(200),
  discount_type:  z.enum(['percent', 'flat']),
  discount_value: z.coerce.number().min(0),
  applies_to:     z.enum(['category', 'service', 'part']),
  ref_id:         z.coerce.number().int().positive(),
  valid_from:     z.string().optional().nullable(),
  valid_until:    z.string().optional().nullable(),
  is_active:      z.boolean().optional(),
});

// Percent discounts above 100% would produce free/negative line items.
const percentCap = (d) =>
  !(d.discount_type === 'percent' && Number(d.discount_value) > 100);
const PERCENT_CAP_MSG = { message: 'Percent discounts cannot exceed 100%' };

const discountSchema = discountBaseSchema.refine(percentCap, PERCENT_CAP_MSG);

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'An active discount already exists for this item. Deactivate it first.' });
    next(err);
  });
}

// ── Shared SELECT ─────────────────────────────────────────────────────────────
// Joins to the three possible target tables to get the human-readable name
const DM_SELECT = `
  SELECT
    dm.id, dm.name, dm.discount_type, dm.discount_value,
    dm.applies_to, dm.ref_id,
    dm.valid_from, dm.valid_until, dm.is_active,
    dm.created_by, dm.created_at, dm.updated_at,
    COALESCE(sc.name, s.name, p.name) AS ref_name
  FROM discount_master dm
  LEFT JOIN service_categories sc ON dm.applies_to = 'category' AND sc.id = dm.ref_id
  LEFT JOIN services           s  ON dm.applies_to = 'service'  AND s.id  = dm.ref_id
  LEFT JOIN parts              p  ON dm.applies_to = 'part'     AND p.id  = dm.ref_id
`;

// ── LIST ──────────────────────────────────────────────────────────────────────
function listDiscounts(req, res, next) {
  handle(req, res, next, async () => {
    const appliesTo = req.query.applies_to || null;
    const isActive  = req.query.is_active !== undefined ? req.query.is_active === 'true' : null;
    const search    = req.query.search ? `%${req.query.search}%` : null;

    const r = await pool.query(
      `${DM_SELECT}
        WHERE ($1::text  IS NULL OR dm.applies_to = $1)
          AND ($2::boolean IS NULL OR dm.is_active = $2)
          AND ($3::text  IS NULL OR dm.name ILIKE $3)
        ORDER BY dm.applies_to, dm.name ASC`,
      [appliesTo, isActive, search]
    );
    res.json({ items: r.rows });
  });
}

// ── GET ONE ───────────────────────────────────────────────────────────────────
function getDiscount(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${DM_SELECT} WHERE dm.id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Discount not found' });
    res.json({ item: r.rows[0] });
  });
}

// ── CREATE ────────────────────────────────────────────────────────────────────
function createDiscount(req, res, next) {
  handle(req, res, next, async () => {
    const data = discountSchema.parse(req.body);
    const createdBy = req.user?.id ?? null;

    const r = await pool.query(
      `INSERT INTO discount_master
         (name, discount_type, discount_value, applies_to, ref_id, valid_from, valid_until, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE($6::date, CURRENT_DATE),
               $7::date,
               COALESCE($8, TRUE),
               $9)
       RETURNING id`,
      [
        data.name, data.discount_type, data.discount_value,
        data.applies_to, data.ref_id,
        data.valid_from  || null,
        data.valid_until || null,
        data.is_active,
        createdBy,
      ]
    );

    const full = await pool.query(`${DM_SELECT} WHERE dm.id = $1`, [r.rows[0].id]);
    getIO().emit('invalidate', { topic: 'discounts' });
    res.status(201).json({ item: full.rows[0] });
  });
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
function updateDiscount(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = discountBaseSchema.partial().parse(req.body);

    // applies_to and ref_id must change together — updating one alone would
    // leave the discount pointing at the wrong record.
    if ((data.applies_to !== undefined) !== (data.ref_id !== undefined)) {
      return res.status(400).json({ error: 'applies_to and ref_id must be updated together' });
    }

    // Enforce the percent ≤ 100 cap against the MERGED type + value
    // (the payload may change only one of the two fields).
    const curRow = await pool.query(
      `SELECT discount_type, discount_value FROM discount_master WHERE id = $1`, [id]
    );
    if (curRow.rowCount === 0) return res.status(404).json({ error: 'Discount not found' });
    const mergedType  = data.discount_type  ?? curRow.rows[0].discount_type;
    const mergedValue = data.discount_value ?? curRow.rows[0].discount_value;
    if (mergedType === 'percent' && Number(mergedValue) > 100) {
      return res.status(400).json({ error: 'Percent discounts cannot exceed 100%' });
    }

    const fields = [];
    const values = [];
    let   n      = 1;

    if (data.name           !== undefined) { fields.push(`name = $${n++}`);           values.push(data.name); }
    if (data.discount_type  !== undefined) { fields.push(`discount_type = $${n++}`);  values.push(data.discount_type); }
    if (data.discount_value !== undefined) { fields.push(`discount_value = $${n++}`); values.push(data.discount_value); }
    if (data.applies_to     !== undefined) { fields.push(`applies_to = $${n++}`);     values.push(data.applies_to); }
    if (data.ref_id         !== undefined) { fields.push(`ref_id = $${n++}`);         values.push(data.ref_id); }
    if (data.valid_from     !== undefined) { fields.push(`valid_from = $${n++}`);     values.push(data.valid_from  || null); }
    if (data.valid_until    !== undefined) { fields.push(`valid_until = $${n++}`);    values.push(data.valid_until || null); }
    if (data.is_active      !== undefined) { fields.push(`is_active = $${n++}`);      values.push(data.is_active); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at = NOW()`);
    values.push(id);
    const upd = await pool.query(
      `UPDATE discount_master SET ${fields.join(', ')} WHERE id = $${n} RETURNING id`,
      values
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Discount not found' });

    const full = await pool.query(`${DM_SELECT} WHERE dm.id = $1`, [id]);
    getIO().emit('invalidate', { topic: 'discounts' });
    res.json({ item: full.rows[0] });
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
function deleteDiscount(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM discount_master WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Discount not found' });
    getIO().emit('invalidate', { topic: 'discounts' });
    res.status(204).end();
  });
}

// ── LOOKUP — used when adding items to estimates/invoices ─────────────────────
// Returns the best matching active discount for a given service_id / part_id
// Priority: part > service > category
async function lookupDiscount(req, res, next) {
  handle(req, res, next, async () => {
    const serviceId  = req.query.service_id  ? parseInt(req.query.service_id,  10) : null;
    const partId     = req.query.part_id     ? parseInt(req.query.part_id,     10) : null;
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;

    const today = new Date().toISOString().slice(0, 10);

    const baseWhere = `
      WHERE dm.is_active = TRUE
        AND dm.valid_from <= $1
        AND (dm.valid_until IS NULL OR dm.valid_until >= $1)
    `;

    // Check in priority order
    let discount = null;

    if (partId) {
      const r = await pool.query(
        `${DM_SELECT} ${baseWhere} AND dm.applies_to = 'part' AND dm.ref_id = $2 LIMIT 1`,
        [today, partId]
      );
      if (r.rowCount > 0) discount = r.rows[0];
    }

    if (!discount && serviceId) {
      const r = await pool.query(
        `${DM_SELECT} ${baseWhere} AND dm.applies_to = 'service' AND dm.ref_id = $2 LIMIT 1`,
        [today, serviceId]
      );
      if (r.rowCount > 0) discount = r.rows[0];
    }

    if (!discount && categoryId) {
      const r = await pool.query(
        `${DM_SELECT} ${baseWhere} AND dm.applies_to = 'category' AND dm.ref_id = $2 LIMIT 1`,
        [today, categoryId]
      );
      if (r.rowCount > 0) discount = r.rows[0];
    }

    if (discount) {
      res.json({
        matched:        true,
        discount_type:  discount.discount_type,
        discount_value: discount.discount_value,
        name:           discount.name,
        ref_name:       discount.ref_name,
      });
    } else {
      res.json({ matched: false });
    }
  });
}

module.exports = { listDiscounts, getDiscount, createDiscount, updateDiscount, deleteDiscount, lookupDiscount };
