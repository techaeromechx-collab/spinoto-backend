'use strict';

const { z }     = require('zod');
const { pool }  = require('../config/db');
const { getIO } = require('../socket');

// ── Validators ────────────────────────────────────────────────────────────────
const warrantyBaseSchema = z.object({
  name:            z.string().trim().min(1).max(200),
  promise_type:    z.enum(['warranty', 'guarantee']).optional().default('warranty'),
  applies_to:      z.enum(['category', 'service', 'part']),
  ref_id:          z.coerce.number().int().positive(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  duration_months: z.coerce.number().int().positive().optional().nullable(),
  duration_days:   z.coerce.number().int().positive().optional().nullable(),
  duration_km:     z.coerce.number().int().positive().optional().nullable(),
  custom_text:     z.string().trim().max(300).optional().nullable(),
  is_exclusion:    z.boolean().optional().default(false),
  valid_from:      z.string().optional().nullable(),
  valid_until:     z.string().optional().nullable(),
  is_active:       z.boolean().optional(),
});

// A warranty with no duration and no custom text promises nothing — unless
// it's an exclusion rule, which intentionally promises nothing (it blocks a
// broader category-level rule from applying to this item).
const hasSubstance = (w) =>
  w.is_exclusion === true ||
  w.duration_months != null || w.duration_days != null ||
  w.duration_km != null || (w.custom_text != null && w.custom_text !== '');
const SUBSTANCE_MSG = { message: 'Set at least one of months, days, KM, or custom text' };

const warrantySchema = warrantyBaseSchema.refine(hasSubstance, SUBSTANCE_MSG);

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'An active warranty already exists for this item and vehicle type. Deactivate it first.' });
    if (err.code === '23503')
      return res.status(409).json({ error: 'Referenced record does not exist.' });
    next(err);
  });
}

// ── Label helper ──────────────────────────────────────────────────────────────
// "6 Months / 5,000 KM (whichever is earlier)" — custom_text always wins.
function warrantyLabel({ duration_months, duration_days, duration_km, custom_text, is_exclusion }) {
  if (is_exclusion) return 'No coverage (excluded)';
  if (custom_text) return custom_text;
  const parts = [];
  if (duration_months) parts.push(`${duration_months} Month${duration_months > 1 ? 's' : ''}`);
  if (duration_days)   parts.push(`${duration_days} Day${duration_days > 1 ? 's' : ''}`);
  if (duration_km)     parts.push(`${Number(duration_km).toLocaleString('en-IN')} KM`);
  if (parts.length === 0) return '';
  return parts.length > 1 ? `${parts.join(' / ')} (whichever is earlier)` : parts[0];
}

// ── Shared SELECT ─────────────────────────────────────────────────────────────
const WM_SELECT = `
  SELECT
    wm.id, wm.name, wm.promise_type, wm.applies_to, wm.ref_id, wm.vehicle_type_id,
    wm.duration_months, wm.duration_days, wm.duration_km, wm.custom_text, wm.is_exclusion,
    wm.valid_from, wm.valid_until, wm.is_active,
    wm.created_by, wm.created_at, wm.updated_at,
    COALESCE(sc.name, s.name, p.name) AS ref_name,
    vt.name AS vehicle_type_name
  FROM warranty_master wm
  LEFT JOIN service_categories sc ON wm.applies_to = 'category' AND sc.id = wm.ref_id
  LEFT JOIN services           s  ON wm.applies_to = 'service'  AND s.id  = wm.ref_id
  LEFT JOIN parts              p  ON wm.applies_to = 'part'     AND p.id  = wm.ref_id
  LEFT JOIN vehicle_types      vt ON vt.id = wm.vehicle_type_id
`;

const withLabel = (row) => ({ ...row, label: warrantyLabel(row) });

// ── Ref existence check ───────────────────────────────────────────────────────
const REF_TABLES = { category: 'service_categories', service: 'services', part: 'parts' };
async function refExists(appliesTo, refId) {
  const r = await pool.query(`SELECT 1 FROM ${REF_TABLES[appliesTo]} WHERE id = $1`, [refId]);
  return r.rowCount > 0;
}

// ── LIST ──────────────────────────────────────────────────────────────────────
function listWarranties(req, res, next) {
  handle(req, res, next, async () => {
    const appliesTo   = req.query.applies_to || null;
    const isActive    = req.query.is_active !== undefined ? req.query.is_active === 'true' : null;
    const search      = req.query.search ? `%${req.query.search}%` : null;
    const vtId        = req.query.vehicle_type_id ? parseInt(req.query.vehicle_type_id, 10) : null;
    const promiseType = req.query.promise_type || null;

    const r = await pool.query(
      `${WM_SELECT}
        WHERE ($1::text    IS NULL OR wm.applies_to = $1)
          AND ($2::boolean IS NULL OR wm.is_active = $2)
          AND ($3::text    IS NULL OR wm.name ILIKE $3 OR COALESCE(sc.name, s.name, p.name) ILIKE $3)
          AND ($4::int     IS NULL OR wm.vehicle_type_id = $4)
          AND ($5::text    IS NULL OR wm.promise_type = $5)
        ORDER BY wm.promise_type, wm.applies_to, wm.name ASC`,
      [appliesTo, isActive, search, vtId, promiseType]
    );
    res.json({ items: r.rows.map(withLabel) });
  });
}

// ── GET ONE ───────────────────────────────────────────────────────────────────
function getWarranty(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${WM_SELECT} WHERE wm.id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Warranty not found' });
    res.json({ item: withLabel(r.rows[0]) });
  });
}

// ── CREATE ────────────────────────────────────────────────────────────────────
function createWarranty(req, res, next) {
  handle(req, res, next, async () => {
    const data = warrantySchema.parse(req.body);
    const createdBy = req.user?.id ?? null;

    if (!(await refExists(data.applies_to, data.ref_id))) {
      return res.status(400).json({ error: `Selected ${data.applies_to} does not exist` });
    }

    const r = await pool.query(
      `INSERT INTO warranty_master
         (name, promise_type, applies_to, ref_id, vehicle_type_id,
          duration_months, duration_days, duration_km, custom_text,
          valid_from, valid_until, is_active, created_by, is_exclusion)
       VALUES ($1, $13, $2, $3, $4, $5, $6, $7, $8,
               COALESCE($9::date, CURRENT_DATE),
               $10::date,
               COALESCE($11, TRUE),
               $12, $14)
       RETURNING id`,
      [
        data.name, data.applies_to, data.ref_id,
        data.vehicle_type_id ?? null,
        data.duration_months ?? null,
        data.duration_days   ?? null,
        data.duration_km     ?? null,
        data.custom_text || null,
        data.valid_from  || null,
        data.valid_until || null,
        data.is_active,
        createdBy,
        data.promise_type || 'warranty',
        data.is_exclusion === true,
      ]
    );

    const full = await pool.query(`${WM_SELECT} WHERE wm.id = $1`, [r.rows[0].id]);
    getIO().emit('invalidate', { topic: 'warranties' });
    res.status(201).json({ item: withLabel(full.rows[0]) });
  });
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
function updateWarranty(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = warrantyBaseSchema.partial().parse(req.body);

    // applies_to and ref_id must change together — updating one alone would
    // leave the warranty pointing at the wrong record.
    if ((data.applies_to !== undefined) !== (data.ref_id !== undefined)) {
      return res.status(400).json({ error: 'applies_to and ref_id must be updated together' });
    }

    const curRow = await pool.query(
      `SELECT applies_to, ref_id, duration_months, duration_days, duration_km, custom_text, is_exclusion
         FROM warranty_master WHERE id = $1`, [id]
    );
    if (curRow.rowCount === 0) return res.status(404).json({ error: 'Warranty not found' });
    const cur = curRow.rows[0];

    // Enforce the "at least one duration or custom text" rule against the
    // MERGED row (the payload may null out fields the DB currently has).
    // Exclusion rules are exempt — they intentionally promise nothing.
    const merged = {
      duration_months: data.duration_months !== undefined ? data.duration_months : cur.duration_months,
      duration_days:   data.duration_days   !== undefined ? data.duration_days   : cur.duration_days,
      duration_km:     data.duration_km     !== undefined ? data.duration_km     : cur.duration_km,
      custom_text:     data.custom_text     !== undefined ? data.custom_text     : cur.custom_text,
      is_exclusion:    data.is_exclusion    !== undefined ? data.is_exclusion    : cur.is_exclusion,
    };
    if (!hasSubstance(merged)) {
      return res.status(400).json({ error: SUBSTANCE_MSG.message });
    }

    if (data.applies_to !== undefined && !(await refExists(data.applies_to, data.ref_id))) {
      return res.status(400).json({ error: `Selected ${data.applies_to} does not exist` });
    }

    const fields = [];
    const values = [];
    let   n      = 1;

    if (data.name            !== undefined) { fields.push(`name = $${n++}`);            values.push(data.name); }
    if (data.promise_type    !== undefined) { fields.push(`promise_type = $${n++}`);    values.push(data.promise_type); }
    if (data.applies_to      !== undefined) { fields.push(`applies_to = $${n++}`);      values.push(data.applies_to); }
    if (data.ref_id          !== undefined) { fields.push(`ref_id = $${n++}`);          values.push(data.ref_id); }
    if (data.vehicle_type_id !== undefined) { fields.push(`vehicle_type_id = $${n++}`); values.push(data.vehicle_type_id ?? null); }
    if (data.duration_months !== undefined) { fields.push(`duration_months = $${n++}`); values.push(data.duration_months ?? null); }
    if (data.duration_days   !== undefined) { fields.push(`duration_days = $${n++}`);   values.push(data.duration_days ?? null); }
    if (data.duration_km     !== undefined) { fields.push(`duration_km = $${n++}`);     values.push(data.duration_km ?? null); }
    if (data.custom_text     !== undefined) { fields.push(`custom_text = $${n++}`);     values.push(data.custom_text || null); }
    if (data.is_exclusion    !== undefined) { fields.push(`is_exclusion = $${n++}`);    values.push(data.is_exclusion === true); }
    if (data.valid_from      !== undefined) { fields.push(`valid_from = $${n++}`);      values.push(data.valid_from  || null); }
    if (data.valid_until     !== undefined) { fields.push(`valid_until = $${n++}`);     values.push(data.valid_until || null); }
    if (data.is_active       !== undefined) { fields.push(`is_active = $${n++}`);       values.push(data.is_active); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at = NOW()`);
    values.push(id);
    const upd = await pool.query(
      `UPDATE warranty_master SET ${fields.join(', ')} WHERE id = $${n} RETURNING id`,
      values
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Warranty not found' });

    const full = await pool.query(`${WM_SELECT} WHERE wm.id = $1`, [id]);
    getIO().emit('invalidate', { topic: 'warranties' });
    res.json({ item: withLabel(full.rows[0]) });
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
function deleteWarranty(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM warranty_master WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Warranty not found' });
    getIO().emit('invalidate', { topic: 'warranties' });
    res.status(204).end();
  });
}

// ── LOOKUP — used when adding items to estimates ──────────────────────────────
// Best match for a given service/part (+ category fallback) and vehicle type,
// resolved INDEPENDENTLY for each promise type — an item can carry both a
// warranty and a guarantee at once. Priority within each type:
//   part+vt > part > service+vt > service > category+vt > category
// A NULL vehicle_type_id means "all vehicle types".
function lookupWarranty(req, res, next) {
  handle(req, res, next, async () => {
    const serviceId  = req.query.service_id      ? parseInt(req.query.service_id,      10) : null;
    const partId     = req.query.part_id         ? parseInt(req.query.part_id,         10) : null;
    const categoryId = req.query.category_id     ? parseInt(req.query.category_id,     10) : null;
    const vtId       = req.query.vehicle_type_id ? parseInt(req.query.vehicle_type_id, 10) : null;

    if (!serviceId && !partId && !categoryId) return res.json({ matched: false, warranty: null, guarantee: null });

    const today = new Date().toISOString().slice(0, 10);

    const r = await pool.query(
      `${WM_SELECT}
        WHERE wm.is_active = TRUE
          AND wm.valid_from <= $1
          AND (wm.valid_until IS NULL OR wm.valid_until >= $1)
          AND (
                (wm.applies_to = 'part'     AND $2::int IS NOT NULL AND wm.ref_id = $2)
             OR (wm.applies_to = 'service'  AND $3::int IS NOT NULL AND wm.ref_id = $3)
             OR (wm.applies_to = 'category' AND $4::int IS NOT NULL AND wm.ref_id = $4)
          )
          AND (wm.vehicle_type_id IS NULL OR wm.vehicle_type_id = $5::int)
        ORDER BY
          (CASE wm.applies_to WHEN 'part' THEN 0 WHEN 'service' THEN 2 ELSE 4 END)
          + (CASE WHEN wm.vehicle_type_id IS NULL THEN 1 ELSE 0 END)`,
      [today, partId, serviceId, categoryId, vtId]
    );

    // First (= most specific) row per promise type wins. If the winning row
    // is an EXCLUSION, that promise type resolves to nothing — this is how a
    // specific service opts out of its category's warranty/guarantee.
    const best = {};
    for (const row of r.rows) {
      if (!best[row.promise_type]) best[row.promise_type] = row;
    }
    if (best.warranty?.is_exclusion)  best.warranty  = null;
    if (best.guarantee?.is_exclusion) best.guarantee = null;

    const pack = (w) => w ? {
      warranty_id:     w.id,
      name:            w.name,
      applies_to:      w.applies_to,
      ref_name:        w.ref_name,
      vehicle_type_id: w.vehicle_type_id,
      duration_months: w.duration_months,
      duration_days:   w.duration_days,
      duration_km:     w.duration_km,
      custom_text:     w.custom_text,
      label:           warrantyLabel(w),
      matched_level:   `${w.applies_to}${w.vehicle_type_id ? ' + vehicle type' : ''}`,
    } : null;

    const warranty  = pack(best.warranty);
    const guarantee = pack(best.guarantee);

    res.json({
      matched: !!(warranty || guarantee),
      warranty,
      guarantee,
      // Backward-compatible top-level warranty fields
      ...(warranty || {}),
    });
  });
}

module.exports = {
  listWarranties, getWarranty, createWarranty, updateWarranty, deleteWarranty,
  lookupWarranty, warrantyLabel,
};
