'use strict';

const { z }    = require('zod');
const { pool } = require('../config/db');

// ── Validators ────────────────────────────────────────────────────────────────
const ccSchema = z.object({
  name:        z.string().trim().min(1).max(20),
  min_cc:      z.coerce.number().int().min(0),
  max_cc:      z.coerce.number().int().min(1),
  description: z.string().trim().optional().nullable(),
  is_active:   z.boolean().optional(),
}).refine(d => d.min_cc < d.max_cc, {
  message: 'min_cc must be less than max_cc',
  path:    ['min_cc'],
});

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    // PostgreSQL exclusion constraint violation (overlapping range)
    if (err.code === '23P01')
      return res.status(409).json({ error: 'CC range overlaps with an existing active category. Adjust min_cc or max_cc.' });
    if (err.code === '23505')
      return res.status(409).json({ error: 'A category with this name already exists.' });
    if (err.code === '23503')
      return res.status(409).json({ error: 'In use — cannot delete' });
    next(err);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST — GET /api/cc-categories
// ═══════════════════════════════════════════════════════════════════════════
function listCategories(req, res, next) {
  handle(req, res, next, async () => {
    const activeOnly = req.query.all !== 'true';
    const r = await pool.query(
      `SELECT id, name, min_cc, max_cc, description, is_active, created_at, updated_at
         FROM cc_categories
        ${activeOnly ? 'WHERE is_active = TRUE' : ''}
        ORDER BY min_cc ASC`,
    );
    res.json({ items: r.rows });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE — POST /api/cc-categories
// ═══════════════════════════════════════════════════════════════════════════
function createCategory(req, res, next) {
  handle(req, res, next, async () => {
    const data = ccSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO cc_categories (name, min_cc, max_cc, description, is_active)
       VALUES ($1, $2, $3, $4, COALESCE($5, TRUE))
       RETURNING id, name, min_cc, max_cc, description, is_active`,
      [data.name, data.min_cc, data.max_cc, data.description ?? null, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE — PUT /api/cc-categories/:id
// ═══════════════════════════════════════════════════════════════════════════
function updateCategory(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = ccSchema.partial().parse(req.body);

    // Custom refine for partial update: if both are present, min must be < max
    if (data.min_cc !== undefined && data.max_cc !== undefined && data.min_cc >= data.max_cc) {
      return res.status(400).json({ error: 'min_cc must be less than max_cc' });
    }

    const fields = [];
    const values = [];
    let   n      = 1;

    if (data.name        !== undefined) { fields.push(`name        = $${n++}`); values.push(data.name); }
    if (data.min_cc      !== undefined) { fields.push(`min_cc      = $${n++}`); values.push(data.min_cc); }
    if (data.max_cc      !== undefined) { fields.push(`max_cc      = $${n++}`); values.push(data.max_cc); }
    if (data.description !== undefined) { fields.push(`description = $${n++}`); values.push(data.description ?? null); }
    if (data.is_active   !== undefined) { fields.push(`is_active   = $${n++}`); values.push(data.is_active); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const r = await pool.query(
      `UPDATE cc_categories SET ${fields.join(', ')} WHERE id = $${n}
       RETURNING id, name, min_cc, max_cc, description, is_active`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'CC category not found' });
    res.json({ item: r.rows[0] });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE — DELETE /api/cc-categories/:id
// Soft-delete if used in pricing. Hard-delete otherwise.
// ═══════════════════════════════════════════════════════════════════════════
function deleteCategory(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // Check if used in any pricing rules
    const usedInPricing = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM pricing WHERE cc_category_id = $1', [id]
    );
    const usedInModels = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM vehicle_models WHERE cc_category_id = $1', [id]
    );

    const inUse = (usedInPricing.rows[0].cnt + usedInModels.rows[0].cnt) > 0;

    if (inUse) {
      // Soft delete — deactivate instead
      const r = await pool.query(
        `UPDATE cc_categories SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'CC category not found' });
      return res.json({
        warning: 'This category is referenced by pricing rules or vehicles and has been deactivated instead of deleted.',
        deactivated: true,
      });
    }

    const r = await pool.query('DELETE FROM cc_categories WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'CC category not found' });
    res.status(204).end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CLASSIFY — POST /api/cc-categories/classify  { cc: 150 }
// Returns the matching active category for a given CC value.
// ═══════════════════════════════════════════════════════════════════════════
function classify(req, res, next) {
  handle(req, res, next, async () => {
    const cc = z.coerce.number().int().min(0).parse(req.body.cc);
    const r  = await pool.query(
      `SELECT id, name, min_cc, max_cc, description
         FROM cc_categories
        WHERE is_active = TRUE AND min_cc <= $1 AND max_cc >= $1
        LIMIT 1`,
      [cc]
    );
    if (!r.rows[0]) return res.json({ item: null });
    res.json({ item: r.rows[0] });
  });
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory, classify };
