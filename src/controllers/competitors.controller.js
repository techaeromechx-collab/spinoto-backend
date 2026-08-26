'use strict';
/**
 * competitors.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The workshops we lose jobs to.
 *
 * ── Why this is referenced by ID and lost_reasons is not ────────────────────
 *
 * leads.lost_competitor_id is a real foreign key, so renaming "AutoZone" to
 * "Auto Zone Motors" is one UPDATE and nothing else has to move. lost_reasons
 * and lead_statuses are matched by NAME for historical reasons (migration 013
 * turned an enum into text and nothing has referenced those tables by key
 * since), which is why both of those controllers carry a rename cascade and
 * this one does not.
 *
 * New table, so it got to choose. It chose the key.
 *
 * ── Delete is still refused while in use ────────────────────────────────────
 *
 * The foreign key says ON DELETE SET NULL, which means deleting a competitor
 * would succeed and quietly blank the link on every lead that named them —
 * losing precisely the fact the table exists to record. Refused here instead,
 * with the count, so the choice is a person's.
 */
const { z }     = require('zod');
const { pool }  = require('../config/db');
const { getIO } = require('../socket');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

const competitorSchema = z.object({
  name:       z.string().trim().min(1).max(120),
  notes:      z.string().trim().max(500).nullable().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
  is_active:  z.boolean().default(true),
});

const COLS = 'id, name, notes, sort_order, is_active, created_at';

/* "How many jobs have we lost to them" is the only question this screen is
   really for, so the count is not an extra — it is the content. */
const WITH_COUNTS = `
  SELECT ${COLS},
         (SELECT COUNT(*)::int FROM leads l WHERE l.lost_competitor_id = c.id) AS lead_count
    FROM competitors c
`;

function listCompetitors(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `${WITH_COUNTS} ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

function createCompetitor(req, res, next) {
  handle(req, res, next, async () => {
    const data = competitorSchema.parse(req.body);

    const dup = await pool.query('SELECT id FROM competitors WHERE LOWER(name) = LOWER($1)', [data.name]);
    if (dup.rows[0]) return res.status(409).json({ error: 'A competitor with this name already exists.' });

    const maxRow    = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM competitors');
    const nextOrder = data.sort_order ?? maxRow.rows[0].next;

    const r = await pool.query(
      `INSERT INTO competitors (name, notes, sort_order, is_active)
       VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [data.name, data.notes ?? null, nextOrder, data.is_active]
    );
    getIO().emit('invalidate', { topic: 'competitors' });
    res.status(201).json({ item: { ...r.rows[0], lead_count: 0 } });
  });
}

function updateCompetitor(req, res, next) {
  handle(req, res, next, async () => {
    const id   = parseInt(req.params.id, 10);
    const data = competitorSchema.partial().parse(req.body);

    if (data.name) {
      const dup = await pool.query(
        'SELECT id FROM competitors WHERE LOWER(name) = LOWER($1) AND id != $2', [data.name, id]);
      if (dup.rows[0]) return res.status(409).json({ error: 'A competitor with this name already exists.' });
    }

    const fields = []; const params = [];
    for (const [k, v] of Object.entries(data)) { params.push(v); fields.push(`${k} = $${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const r = await pool.query(
      `UPDATE competitors SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${COLS}`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Competitor not found' });

    getIO().emit('invalidate', { topic: 'competitors' });
    res.json({ item: r.rows[0] });
  });
}

function deleteCompetitor(req, res, next) {
  handle(req, res, next, async () => {
    const id  = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT id, name FROM competitors WHERE id = $1', [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Competitor not found' });

    const inUse = await pool.query('SELECT COUNT(*) FROM leads WHERE lost_competitor_id = $1', [id]);
    if (Number(inUse.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${inUse.rows[0].count} lead(s) were lost to them. Deactivate instead: `
             + `they stop being offered on new leads and the history stays intact.`,
        code: 'COMPETITOR_IN_USE',
      });
    }

    await pool.query('DELETE FROM competitors WHERE id = $1', [id]);
    getIO().emit('invalidate', { topic: 'competitors' });
    res.status(204).end();
  });
}

function reorderCompetitors(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE competitors AS t SET sort_order = v.ord
           FROM unnest($1::int[]) WITH ORDINALITY AS v(id, ord)
          WHERE t.id = v.id`,
        [ids]
      );
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'competitors' });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = { listCompetitors, createCompetitor, updateCompetitor, deleteCompetitor, reorderCompetitors };
