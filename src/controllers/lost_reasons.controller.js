'use strict';
/**
 * lost_reasons.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The reasons offered when a lead is set to a status with needs_lost_reason.
 *
 * Shaped on call_outcomes.controller.js, which solves the same problem — a
 * short admin-owned list a popup offers as chips. Two things here that it does
 * not do, both of them consequences of HOW the value is stored:
 *
 *   RENAME CASCADES. leads.lost_reason holds the NAME, not this table's id.
 *   Renaming a reason without carrying it leaves every lead wearing the old
 *   spelling: the settings screen counts zero against the new name, any report
 *   grouping on it splits one reason into two, and nothing errors. Exactly the
 *   problem lead_statuses.controller solves for status names, for the same
 *   reason, in the same way.
 *
 *   DELETE IS REFUSED WHILE IN USE. The alternative is orphaning the text on
 *   those leads, and there is no correct destination to move them to — only a
 *   person knows which reason those leads should now carry.
 *
 * (call_outcomes has the same latent rename bug against call_logs.outcome. Not
 *  fixed here: one change, one decision.)
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

const reasonSchema = z.object({
  name:       z.string().trim().min(1).max(120),
  sort_order: z.coerce.number().int().min(0).optional(),
  is_active:  z.boolean().default(true),

  /* Asks WHO took the job and WHEN they did it. Separate from the interval
     below on purpose — see migration 173. */
  requires_competitor: z.boolean().default(false),

  /* NULL means this reason is never chased again, which is the honest default
     for "Wrong Number". Capped at five years: anything longer is a typo, and a
     typo here schedules a call nobody alive will make. */
  retarget_after_months: z.coerce.number().int().min(1).max(60).nullable().optional(),
});

const COLS = `
  id, name, sort_order, is_active,
  requires_competitor, retarget_after_months, created_at
`;

/* The lead count is what makes this screen worth looking at — "Competitor
   Service · 31 leads" is the number that tells you where the work is going.
   A correlated subquery rather than a GROUP BY join so a reason with no leads
   still appears, which is the whole point of a master list. */
const WITH_COUNTS = `
  SELECT ${COLS},
         (SELECT COUNT(*)::int FROM leads l WHERE l.lost_reason = r.name) AS lead_count
    FROM lost_reasons r
`;

function listReasons(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `${WITH_COUNTS} ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

function createReason(req, res, next) {
  handle(req, res, next, async () => {
    const data = reasonSchema.parse(req.body);

    const dup = await pool.query('SELECT id FROM lost_reasons WHERE LOWER(name) = LOWER($1)', [data.name]);
    if (dup.rows[0]) return res.status(409).json({ error: 'A reason with this name already exists.' });

    const maxRow    = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM lost_reasons');
    const nextOrder = data.sort_order ?? maxRow.rows[0].next;

    const r = await pool.query(
      `INSERT INTO lost_reasons (name, sort_order, is_active, requires_competitor, retarget_after_months)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [data.name, nextOrder, data.is_active, data.requires_competitor, data.retarget_after_months ?? null]
    );
    getIO().emit('invalidate', { topic: 'lost_reasons' });
    res.status(201).json({ item: { ...r.rows[0], lead_count: 0 } });
  });
}

function updateReason(req, res, next) {
  handle(req, res, next, async () => {
    const id   = parseInt(req.params.id, 10);
    const data = reasonSchema.partial().parse(req.body);

    if (data.name) {
      const dup = await pool.query(
        'SELECT id FROM lost_reasons WHERE LOWER(name) = LOWER($1) AND id != $2', [data.name, id]);
      if (dup.rows[0]) return res.status(409).json({ error: 'A reason with this name already exists.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      /* Read inside the transaction and FOR UPDATE: the cascade below depends
         on the old name, and a value read a moment earlier is a value that may
         already have changed. */
      const before = await client.query('SELECT name FROM lost_reasons WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reason not found' }); }
      const oldName = before.rows[0].name;

      const fields = []; const params = [];
      for (const [k, v] of Object.entries(data)) { params.push(v); fields.push(`${k} = $${params.length}`); }
      if (!fields.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing to update' }); }

      params.push(id);
      const r = await client.query(
        `UPDATE lost_reasons SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${COLS}`, params);

      /* ── Carry the rename to the leads wearing it ────────────────────────
         Compared exactly and case-sensitively, because that is how the value
         was written. Changing only the capitalisation is still a rename worth
         carrying, so the guard is on identity rather than a normalised match. */
      let relabelled = 0;
      if (data.name && data.name !== oldName) {
        const moved = await client.query(
          'UPDATE leads SET lost_reason = $2, updated_at = NOW() WHERE lost_reason = $1',
          [oldName, data.name]);
        relabelled = moved.rowCount;
        if (relabelled) {
          console.log(`[lost_reasons] renamed "${oldName}" → "${data.name}", moved ${relabelled} lead(s) with it`);
        }
      }

      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'lost_reasons' });
      // Reported so the screen can say "renamed, 31 leads updated" rather than
      // leaving somebody to wonder whether their leads came along.
      res.json({ item: r.rows[0], leads_relabelled: relabelled });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function deleteReason(req, res, next) {
  handle(req, res, next, async () => {
    const id  = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT id, name FROM lost_reasons WHERE id = $1', [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Reason not found' });

    const inUse = await pool.query('SELECT COUNT(*) FROM leads WHERE lost_reason = $1', [row.rows[0].name]);
    if (Number(inUse.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${inUse.rows[0].count} lead(s) carry this reason. Deactivate it instead: `
             + `it stops being offered on new leads and the existing ones keep their history.`,
        code: 'REASON_IN_USE',
      });
    }

    await pool.query('DELETE FROM lost_reasons WHERE id = $1', [id]);
    getIO().emit('invalidate', { topic: 'lost_reasons' });
    res.status(204).end();
  });
}

function reorderReasons(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        // Batched: one statement instead of one UPDATE per row —
        // unnest preserves array order via WITH ORDINALITY.
        `UPDATE lost_reasons AS t SET sort_order = v.ord
           FROM unnest($1::int[]) WITH ORDINALITY AS v(id, ord)
          WHERE t.id = v.id`,
        [ids]
      );
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'lost_reasons' });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = { listReasons, createReason, updateReason, deleteReason, reorderReasons };
