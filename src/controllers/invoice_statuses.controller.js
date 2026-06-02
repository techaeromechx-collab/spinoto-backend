'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

const statusSchema = z.object({
  name:       z.string().trim().min(1).max(100),
  color:      z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6b7280'),
  bg_color:   z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f3f4f6'),
  sort_order: z.coerce.number().int().min(0).default(0),
  is_active:  z.boolean().default(true),
  is_default: z.boolean().default(false),
});

const SELECT_COLS = `id, name, color, bg_color, sort_order, is_active, is_default, created_at`;

function listStatuses(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `SELECT ${SELECT_COLS} FROM invoice_statuses
       ${all ? '' : 'WHERE is_active = TRUE'}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

function createStatus(req, res, next) {
  handle(req, res, next, async () => {
    const data = statusSchema.parse(req.body);
    const dup = await pool.query('SELECT id FROM invoice_statuses WHERE LOWER(name) = LOWER($1)', [data.name]);
    if (dup.rows[0]) return res.status(409).json({ error: 'A status with this name already exists.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const maxRow = await client.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM invoice_statuses');
      const nextOrder = maxRow.rows[0].next;
      if (data.is_default) {
        await client.query('UPDATE invoice_statuses SET is_default = FALSE WHERE is_default = TRUE');
      }
      const r = await client.query(
        `INSERT INTO invoice_statuses (name, color, bg_color, sort_order, is_active, is_default)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT_COLS}`,
        [data.name, data.color, data.bg_color, nextOrder, data.is_active, data.is_default]
      );
      await client.query('COMMIT');
      res.status(201).json({ item: r.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function updateStatus(req, res, next) {
  handle(req, res, next, async () => {
    const id   = parseInt(req.params.id, 10);
    const data = statusSchema.partial().parse(req.body);

    if (data.name) {
      const dup = await pool.query(
        'SELECT id FROM invoice_statuses WHERE LOWER(name) = LOWER($1) AND id != $2',
        [data.name, id]
      );
      if (dup.rows[0]) return res.status(409).json({ error: 'A status with this name already exists.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (data.is_default === true) {
        await client.query(
          'UPDATE invoice_statuses SET is_default = FALSE WHERE is_default = TRUE AND id != $1',
          [id]
        );
      }

      const fields = []; const params = [];
      for (const [k, v] of Object.entries(data)) { params.push(v); fields.push(`${k} = $${params.length}`); }
      if (!fields.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing to update' }); }

      params.push(id);
      const r = await client.query(
        `UPDATE invoice_statuses SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${SELECT_COLS}`,
        params
      );
      if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Status not found' }); }
      await client.query('COMMIT');
      res.json({ item: r.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function deleteStatus(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT id, name, is_default FROM invoice_statuses WHERE id = $1', [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Status not found' });
    if (row.rows[0].is_default) return res.status(409).json({ error: 'Cannot delete the default status. Set another status as default first.' });
    await pool.query('DELETE FROM invoice_statuses WHERE id = $1', [id]);
    res.status(204).end();
  });
}

function reorderStatuses(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE invoice_statuses SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]]);
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

module.exports = { listStatuses, createStatus, updateStatus, deleteStatus, reorderStatuses };
