'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

const sourceSchema = z.object({
  name:       z.string().trim().min(1).max(80),
  is_active:  z.boolean().default(true),
  sort_order: z.coerce.number().int().min(0).default(0),
});

// GET /api/lead-sources          → active only (for dropdowns)
// GET /api/lead-sources?all=true → all (for admin panel)
function listSources(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `SELECT id, name, is_active, sort_order, created_at
       FROM lead_sources
       ${all ? '' : 'WHERE is_active = TRUE'}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

// POST /api/lead-sources
function createSource(req, res, next) {
  handle(req, res, next, async () => {
    const data = sourceSchema.parse(req.body);
    const dup = await pool.query('SELECT id FROM lead_sources WHERE LOWER(name) = LOWER($1)', [data.name]);
    if (dup.rows[0]) return res.status(409).json({ error: 'A source with this name already exists.' });

    const maxRow = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM lead_sources');
    const nextOrder = maxRow.rows[0].next;

    const r = await pool.query(
      `INSERT INTO lead_sources (name, is_active, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, name, is_active, sort_order, created_at`,
      [data.name, data.is_active, nextOrder]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}

// PATCH /api/lead-sources/:id
function updateSource(req, res, next) {
  handle(req, res, next, async () => {
    const id   = parseInt(req.params.id, 10);
    const data = sourceSchema.partial().parse(req.body);

    if (data.name) {
      const dup = await pool.query(
        'SELECT id FROM lead_sources WHERE LOWER(name) = LOWER($1) AND id != $2', [data.name, id]
      );
      if (dup.rows[0]) return res.status(409).json({ error: 'A source with this name already exists.' });
    }

    const r = await pool.query(
      `UPDATE lead_sources
       SET name       = COALESCE($1, name),
           is_active  = COALESCE($2, is_active),
           sort_order = COALESCE($3, sort_order)
       WHERE id = $4
       RETURNING id, name, is_active, sort_order, created_at`,
      [data.name ?? null, data.is_active ?? null, data.sort_order ?? null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Source not found' });
    res.json({ item: r.rows[0] });
  });
}

// DELETE /api/lead-sources/:id
function deleteSource(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const r  = await pool.query('DELETE FROM lead_sources WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Source not found' });
    res.status(204).end();
  });
}

// POST /api/lead-sources/reorder  { ids: [1,3,2,...] }
function reorderSources(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    await Promise.all(ids.map((id, i) =>
      pool.query('UPDATE lead_sources SET sort_order = $1 WHERE id = $2', [i + 1, id])
    ));
    res.json({ ok: true });
  });
}

module.exports = { listSources, createSource, updateSource, deleteSource, reorderSources };
