const { z } = require('zod');
const { pool } = require('../config/db');

// ── Validators ────────────────────────────────────────────────────────────────

/**
 * A pricing rule targets EITHER a service OR a category — never both.
 * Exactly one of service_id / category_id must be present.
 */
// Base object — kept as ZodObject so .partial() works in updatePricing.
// The create handler adds the service_id/category_id refine on top of this.
const pricingBaseSchema = z.object({
  service_id:      z.coerce.number().int().positive().optional().nullable(),
  category_id:     z.coerce.number().int().positive().optional().nullable(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id:    z.coerce.number().int().positive().optional().nullable(),
  segment_id:      z.coerce.number().int().positive().optional().nullable(),
  make_id:         z.coerce.number().int().positive().optional().nullable(),
  model_id:        z.coerce.number().int().positive().optional().nullable(),
  cc_category_id:  z.coerce.number().int().positive().optional().nullable(),
  price:           z.coerce.number().positive(),
  is_active:       z.boolean().optional(),
});

// Full create schema — adds the mutual-exclusion constraint.
// ZodEffects (returned by .refine()) has no .partial(), so we keep
// pricingBaseSchema separate for use in updatePricing.
const pricingSchema = pricingBaseSchema.refine(
  d => Boolean(d.service_id) !== Boolean(d.category_id),
  { message: 'Exactly one of service_id or category_id must be provided' }
);

const statusSchema = z.object({
  is_active: z.boolean(),
});

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'A pricing rule with this exact combination already exists' });
    if (err.code === '23503')
      return res.status(409).json({ error: 'Referenced record not found' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the rule type label from a pricing row.
 * Supports multi-dimension combinations, e.g. "Make + Segment", "Model + Body Type".
 */
function ruleType(row) {
  const dims = [];
  if (row.model_id)        dims.push('Model');
  else if (row.make_id)    dims.push('Make');
  if (row.segment_id)      dims.push('Segment');
  if (row.body_type_id)    dims.push('Body Type');
  if (row.cc_category_id)  dims.push('CC Category');
  if (dims.length === 0) return 'Universal';
  return dims.join(' + ');
}

/**
 * Build a human-readable "Applies To" label for multi-dimension combinations.
 */
function appliesToLabel(row) {
  const parts = [];

  if (row.model_id) {
    parts.push(`${row.make_name || ''} ${row.model_name || ''}`.trim());
  } else if (row.make_id) {
    parts.push(row.make_name);
  }

  if (row.segment_id)   parts.push(row.segment_name);
  if (row.body_type_id) parts.push(row.body_type_name);

  if (row.cc_category_id) parts.push(`CC: ${row.cc_category_name}`);

  if (parts.length === 0) {
    if (row.vehicle_type_id) return `${row.vehicle_type_name} Vehicles`;
    return 'All Vehicles';
  }

  const label = parts.join(' · ');
  return row.vehicle_type_id ? `${row.vehicle_type_name} → ${label}` : label;
}

/**
 * Full SELECT with all joined names.
 * service_id / category_id are mutually exclusive — both JOINs are LEFT so
 * whichever is null doesn't break the row.
 */
const PRICING_SELECT = `
  SELECT
    p.id,
    p.service_id,   s.name    AS service_name,
    p.category_id,  sc.name   AS category_name,
    p.vehicle_type_id, vt.name  AS vehicle_type_name,
    p.body_type_id,    bt.name  AS body_type_name,
    p.segment_id,      seg.name AS segment_name,
    p.make_id,         mk.name  AS make_name,
    p.model_id,        mo.name  AS model_name,
    p.cc_category_id,  cc.name  AS cc_category_name,
    p.price, p.is_active, p.created_at, p.updated_at
  FROM pricing p
  LEFT JOIN services           s   ON s.id   = p.service_id
  LEFT JOIN service_categories sc  ON sc.id  = p.category_id
  LEFT JOIN vehicle_types  vt  ON vt.id  = p.vehicle_type_id
  LEFT JOIN body_types     bt  ON bt.id  = p.body_type_id
  LEFT JOIN segments       seg ON seg.id = p.segment_id
  LEFT JOIN vehicle_makes  mk  ON mk.id  = p.make_id
  LEFT JOIN vehicle_models mo  ON mo.id  = p.model_id
  LEFT JOIN cc_categories  cc  ON cc.id  = p.cc_category_id
`;

function enrichRow(row) {
  return {
    ...row,
    rule_type:     ruleType(row),
    applies_to:    appliesToLabel(row),
    price:         Number(row.price),
    // Handy flag so the frontend knows which type of rule this is
    target_type:      row.service_id ? 'service' : 'category',
    target_name:      row.service_id ? row.service_name : row.category_name,
    cc_category_name: row.cc_category_name ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════
function listPricing(req, res, next) {
  handle(req, res, next, async () => {
    const serviceId  = req.query.service_id  ? idParam.parse(req.query.service_id)  : null;
    const categoryId = req.query.category_id ? idParam.parse(req.query.category_id) : null;
    const search     = req.query.search      ? req.query.search                      : null;
    const ruleT      = req.query.rule_type   || null;
    const isActive   = req.query.is_active !== undefined
      ? req.query.is_active === 'true' : null;

    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const conds  = [];
    const params = [];
    let   n      = 1;

    if (serviceId  !== null) { conds.push(`p.service_id = $${n++}`);  params.push(serviceId);  }
    if (categoryId !== null) { conds.push(`p.category_id = $${n++}`); params.push(categoryId); }
    if (isActive   !== null) { conds.push(`p.is_active = $${n++}`);   params.push(isActive);   }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countR = await pool.query(
      `SELECT COUNT(*)::int AS total FROM pricing p ${where}`,
      params
    );
    const total = countR.rows[0].total;

    const dataR = await pool.query(
      `${PRICING_SELECT} ${where}
       ORDER BY p.created_at DESC
       LIMIT $${n++} OFFSET $${n++}`,
      [...params, limit, offset]
    );

    let rows = dataR.rows.map(enrichRow);

    // In-memory filter by rule_type (derived field)
    if (ruleT) rows = rows.filter((r) => r.rule_type === ruleT || r.rule_type?.includes(ruleT));

    // In-memory search
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        r.applies_to.toLowerCase().includes(q) ||
        (r.service_name  || '').toLowerCase().includes(q) ||
        (r.category_name || '').toLowerCase().includes(q)
      );
    }

    res.json({ items: rows, total, page, limit, pages: Math.ceil(total / limit) });
  });
}

// ── Relationship validators ───────────────────────────────────────────────────
async function validateRelationships(data) {
  if (data.model_id && data.make_id) {
    const r = await pool.query(
      'SELECT id FROM vehicle_models WHERE id = $1 AND make_id = $2',
      [data.model_id, data.make_id]
    );
    if (r.rowCount === 0) {
      const err = new Error('The selected model does not belong to the selected make.');
      err.status = 400; throw err;
    }
  }

  if (data.make_id && data.vehicle_type_id) {
    const r = await pool.query(
      'SELECT id FROM vehicle_makes WHERE id = $1 AND vehicle_type_id = $2',
      [data.make_id, data.vehicle_type_id]
    );
    if (r.rowCount === 0) {
      const err = new Error('The selected make does not belong to the selected vehicle type.');
      err.status = 400; throw err;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════
function createPricing(req, res, next) {
  handle(req, res, next, async () => {
    const data = pricingSchema.parse(req.body);
    await validateRelationships(data);

    const r = await pool.query(
      `INSERT INTO pricing
         (service_id, category_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id, cc_category_id, price, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, TRUE))
       RETURNING id`,
      [
        data.service_id      ?? null,
        data.category_id     ?? null,
        data.vehicle_type_id ?? null,
        data.body_type_id    ?? null,
        data.segment_id      ?? null,
        data.make_id         ?? null,
        data.model_id        ?? null,
        data.cc_category_id  ?? null,
        data.price,
        data.is_active,
      ]
    );

    const full = await pool.query(`${PRICING_SELECT} WHERE p.id = $1`, [r.rows[0].id]);
    res.status(201).json({ item: enrichRow(full.rows[0]) });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════════
function updatePricing(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = pricingBaseSchema.partial().parse(req.body);

    const fields = [];
    const values = [];
    let   i      = 1;

    if (data.vehicle_type_id !== undefined) { fields.push(`vehicle_type_id = $${i++}`); values.push(data.vehicle_type_id ?? null); }
    if (data.body_type_id    !== undefined) { fields.push(`body_type_id = $${i++}`);    values.push(data.body_type_id    ?? null); }
    if (data.segment_id      !== undefined) { fields.push(`segment_id = $${i++}`);      values.push(data.segment_id      ?? null); }
    if (data.make_id         !== undefined) { fields.push(`make_id = $${i++}`);         values.push(data.make_id         ?? null); }
    if (data.model_id        !== undefined) { fields.push(`model_id = $${i++}`);        values.push(data.model_id        ?? null); }
    if (data.cc_category_id  !== undefined) { fields.push(`cc_category_id = $${i++}`); values.push(data.cc_category_id  ?? null); }
    if (data.price           !== undefined) { fields.push(`price = $${i++}`);           values.push(data.price); }
    if (data.is_active       !== undefined) { fields.push(`is_active = $${i++}`);       values.push(data.is_active); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Merge current + incoming for relationship validation
    const current = await pool.query(`${PRICING_SELECT} WHERE p.id = $1`, [id]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found' });

    const merged = {
      vehicle_type_id: data.vehicle_type_id !== undefined ? data.vehicle_type_id : current.rows[0].vehicle_type_id,
      make_id:         data.make_id         !== undefined ? data.make_id         : current.rows[0].make_id,
      model_id:        data.model_id        !== undefined ? data.model_id        : current.rows[0].model_id,
    };
    await validateRelationships(merged);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const upd = await pool.query(
      `UPDATE pricing SET ${fields.join(', ')} WHERE id = $${i} RETURNING id`,
      values
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found' });

    const full = await pool.query(`${PRICING_SELECT} WHERE p.id = $1`, [id]);
    res.json({ item: enrichRow(full.rows[0]) });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOGGLE STATUS
// ═══════════════════════════════════════════════════════════════════════════
function togglePricingStatus(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = statusSchema.parse(req.body);
    const r    = await pool.query(
      `UPDATE pricing SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [data.is_active, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found' });
    const full = await pool.query(`${PRICING_SELECT} WHERE p.id = $1`, [id]);
    res.json({ item: enrichRow(full.rows[0]) });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════
function deletePricing(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM pricing WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found' });
    res.status(204).end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LOOKUP  GET /api/pricing/lookup
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Find the best-matching active pricing rule for a given vehicle + service/category
 * combination using a specificity scoring approach.
 *
 * Specificity weights (higher = more specific):
 *   model_id       → 64
 *   make_id        → 32
 *   segment_id     →  8
 *   body_type_id   →  8
 *   cc_category_id →  8
 *   vehicle_type_id →  4
 *
 * A rule with NULL in a dimension matches ANY value for that dimension.
 * Non-NULL dimensions must match exactly.
 *
 * Query params (all optional except one of service_id/category_id):
 *   service_id | category_id  — which service or category to price
 *   vehicle_type_id, body_type_id, segment_id, make_id, model_id, cc_category_id
 *
 * Returns: { matched: true, rule: {...}, price: 123.45 }
 *       or: { matched: false, reason: '...' }
 */
function lookupPrice(req, res, next) {
  handle(req, res, next, async () => {
    const serviceId     = req.query.service_id      ? idParam.parse(req.query.service_id)      : null;
    const categoryId    = req.query.category_id     ? idParam.parse(req.query.category_id)     : null;
    const vehicleTypeId = req.query.vehicle_type_id ? idParam.parse(req.query.vehicle_type_id) : null;
    const bodyTypeId    = req.query.body_type_id    ? idParam.parse(req.query.body_type_id)    : null;
    const segmentId     = req.query.segment_id      ? idParam.parse(req.query.segment_id)      : null;
    const makeId        = req.query.make_id         ? idParam.parse(req.query.make_id)         : null;
    const modelId       = req.query.model_id        ? idParam.parse(req.query.model_id)        : null;
    const ccCategoryId  = req.query.cc_category_id  ? idParam.parse(req.query.cc_category_id)  : null;

    if (!serviceId && !categoryId) {
      return res.status(400).json({ error: 'Provide service_id or category_id' });
    }
    if (serviceId && categoryId) {
      return res.status(400).json({ error: 'Provide only one of service_id or category_id' });
    }

    /*
     * Match rules where:
     *   - the target (service/category) matches
     *   - each non-NULL dimension on the rule matches the lookup values
     *   - the rule is active
     *
     * Then order by descending specificity score and take the top 1.
     */
    const r = await pool.query(
      `${PRICING_SELECT}
       WHERE p.is_active = TRUE
         AND ($1::int IS NULL OR p.service_id  = $1)
         AND ($2::int IS NULL OR p.category_id = $2)
         AND (p.vehicle_type_id IS NULL OR p.vehicle_type_id = $3)
         AND (p.body_type_id    IS NULL OR p.body_type_id    = $4)
         AND (p.segment_id      IS NULL OR p.segment_id      = $5)
         AND (p.make_id         IS NULL OR p.make_id         = $6)
         AND (p.model_id        IS NULL OR p.model_id        = $7)
         AND (p.cc_category_id  IS NULL OR p.cc_category_id  = $8)
       ORDER BY
         (CASE WHEN p.model_id        IS NOT NULL THEN 64 ELSE 0 END +
          CASE WHEN p.make_id         IS NOT NULL THEN 32 ELSE 0 END +
          CASE WHEN p.segment_id      IS NOT NULL THEN  9 ELSE 0 END +
          CASE WHEN p.body_type_id    IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN p.cc_category_id  IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN p.vehicle_type_id IS NOT NULL THEN  4 ELSE 0 END) DESC
       LIMIT 1`,
      [serviceId, categoryId, vehicleTypeId, bodyTypeId, segmentId, makeId, modelId, ccCategoryId]
    );

    if (r.rowCount === 0) {
      return res.json({
        matched: false,
        reason: 'No active pricing rule found for this combination',
      });
    }

    const rule = enrichRow(r.rows[0]);
    return res.json({
      matched:    true,
      price:      rule.price,
      rule_id:    rule.id,
      rule_type:  rule.rule_type,
      applies_to: rule.applies_to,
      rule,
    });
  });
}

module.exports = {
  listPricing, createPricing, updatePricing, togglePricingStatus, deletePricing,
  lookupPrice,
};
