'use strict';

const { z }    = require('zod');
const { pool } = require('../config/db');

const outcomeSchema = z.object({
  name:       z.string().trim().min(1).max(100),
  sort_order: z.coerce.number().int().min(0).optional(),
  is_active:  z.boolean().default(true),
});

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

// GET /api/call-outcomes
function listOutcomes(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `SELECT id, name, sort_order, is_active, created_at
       FROM call_outcomes
       ${all ? '' : 'WHERE is_active = TRUE'}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

// POST /api/call-outcomes
function createOutcome(req, res, next) {
  handle(req, res, next, async () => {
    const data = outcomeSchema.parse(req.body);
    const dup = await pool.query(
      'SELECT id FROM call_outcomes WHERE LOWER(name) = LOWER($1)', [data.name]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'An outcome with this name already exists.' });

    const maxRow = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM call_outcomes');
    const nextOrder = data.sort_order ?? maxRow.rows[0].next;

    const r = await pool.query(
      `INSERT INTO call_outcomes (name, sort_order, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, name, sort_order, is_active, created_at`,
      [data.name, nextOrder, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}

// PATCH /api/call-outcomes/:id
function updateOutcome(req, res, next) {
  handle(req, res, next, async () => {
    const id   = parseInt(req.params.id, 10);
    const data = outcomeSchema.partial().parse(req.body);

    if (data.name) {
      const dup = await pool.query(
        'SELECT id FROM call_outcomes WHERE LOWER(name) = LOWER($1) AND id != $2', [data.name, id]
      );
      if (dup.rows[0]) return res.status(409).json({ error: 'An outcome with this name already exists.' });
    }

    const fields = []; const params = [];
    for (const [k, v] of Object.entries(data)) { params.push(v); fields.push(`${k} = $${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const r = await pool.query(
      `UPDATE call_outcomes SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, sort_order, is_active, created_at`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Outcome not found' });
    res.json({ item: r.rows[0] });
  });
}

// DELETE /api/call-outcomes/:id
function deleteOutcome(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT id FROM call_outcomes WHERE id = $1', [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Outcome not found' });

    // Check if in use
    const inUse = await pool.query('SELECT COUNT(*) FROM call_logs WHERE outcome = (SELECT name FROM call_outcomes WHERE id = $1)', [id]);
    if (Number(inUse.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${inUse.rows[0].count} call log(s) use this outcome. Deactivate it instead.`
      });
    }

    await pool.query('DELETE FROM call_outcomes WHERE id = $1', [id]);
    res.status(204).end();
  });
}

// POST /api/call-outcomes/reorder
function reorderOutcomes(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE call_outcomes SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = { listOutcomes, createOutcome, updateOutcome, deleteOutcome, reorderOutcomes };
