const { z } = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

// ---------- validators ----------
const stateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(10).optional().nullable(),
  is_active: z.boolean().optional(),
});

const citySchema = z.object({
  state_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  is_active: z.boolean().optional(),
});

const areaSchema = z.object({
  city_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  pincode: z.string().trim().max(20).optional().nullable(),
  is_active: z.boolean().optional(),
});

const idParam = z.coerce.number().int().positive();

// Tiny helper that converts ZodError to a 400 with a readable message.
function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      // Postgres unique-violation
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Already exists' });
      }
      // Foreign-key violation
      if (err.code === '23503') {
        return res.status(409).json({ error: 'In use — cannot delete' });
      }
      next(err);
    });
}

// =====================================================================
// STATES
// =====================================================================
function listStates(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      'SELECT id, name, code, is_active FROM states ORDER BY name ASC'
    );
    res.json({ items: r.rows });
  });
}

function createState(req, res, next) {
  handle(req, res, next, async () => {
    const data = stateSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO states (name, code, is_active) VALUES ($1, $2, COALESCE($3, TRUE)) RETURNING id, name, code, is_active',
      [data.name, data.code || null, data.is_active]
    );
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(201).json({ item: r.rows[0] });
  });
}

function updateState(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = stateSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE states SET
         name      = COALESCE($1, name),
         code      = COALESCE($2, code),
         is_active = COALESCE($3, is_active)
       WHERE id = $4
       RETURNING id, name, code, is_active`,
      [data.name ?? null, data.code ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'State not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.json({ item: r.rows[0] });
  });
}

function deleteState(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM states WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'State not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(204).end();
  });
}

// =====================================================================
// CITIES
// =====================================================================
function listCities(req, res, next) {
  handle(req, res, next, async () => {
    // Optional ?state_id=  for dependent dropdowns
    const stateId = req.query.state_id
      ? idParam.parse(req.query.state_id)
      : null;
    const r = await pool.query(
      stateId
        ? 'SELECT id, state_id, name, is_active FROM cities WHERE state_id = $1 ORDER BY name ASC'
        : 'SELECT id, state_id, name, is_active FROM cities ORDER BY name ASC',
      stateId ? [stateId] : []
    );
    res.json({ items: r.rows });
  });
}

function createCity(req, res, next) {
  handle(req, res, next, async () => {
    const data = citySchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO cities (state_id, name, is_active) VALUES ($1, $2, COALESCE($3, TRUE)) RETURNING id, state_id, name, is_active',
      [data.state_id, data.name, data.is_active]
    );
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(201).json({ item: r.rows[0] });
  });
}

function updateCity(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = citySchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE cities SET
         state_id  = COALESCE($1, state_id),
         name      = COALESCE($2, name),
         is_active = COALESCE($3, is_active)
       WHERE id = $4
       RETURNING id, state_id, name, is_active`,
      [data.state_id ?? null, data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'City not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.json({ item: r.rows[0] });
  });
}

function deleteCity(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM cities WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'City not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(204).end();
  });
}

// =====================================================================
// AREAS
// =====================================================================
function listAreas(req, res, next) {
  handle(req, res, next, async () => {
    const cityId = req.query.city_id
      ? idParam.parse(req.query.city_id)
      : null;
    const r = await pool.query(
      cityId
        ? 'SELECT id, city_id, name, pincode, is_active FROM areas WHERE city_id = $1 ORDER BY name ASC'
        : 'SELECT id, city_id, name, pincode, is_active FROM areas ORDER BY name ASC',
      cityId ? [cityId] : []
    );
    res.json({ items: r.rows });
  });
}

function createArea(req, res, next) {
  handle(req, res, next, async () => {
    const data = areaSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO areas (city_id, name, pincode, is_active) VALUES ($1, $2, $3, COALESCE($4, TRUE)) RETURNING id, city_id, name, pincode, is_active',
      [data.city_id, data.name, data.pincode || null, data.is_active]
    );
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(201).json({ item: r.rows[0] });
  });
}

function updateArea(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = areaSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE areas SET
         city_id   = COALESCE($1, city_id),
         name      = COALESCE($2, name),
         pincode   = COALESCE($3, pincode),
         is_active = COALESCE($4, is_active)
       WHERE id = $5
       RETURNING id, city_id, name, pincode, is_active`,
      [data.city_id ?? null, data.name ?? null, data.pincode ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Area not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.json({ item: r.rows[0] });
  });
}

function deleteArea(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM areas WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Area not found' });
    getIO().emit('invalidate', { topic: 'locations' });
    res.status(204).end();
  });
}

module.exports = {
  listStates, createState, updateState, deleteState,
  listCities, createCity, updateCity, deleteCity,
  listAreas,  createArea, updateArea, deleteArea,
};
