'use strict';
const { z }    = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

const statusSchema = z.object({
  name:                    z.string().trim().min(1).max(100),
  color:                   z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6b7280'),
  bg_color:                z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f3f4f6'),
  sort_order:              z.coerce.number().int().min(0).default(0),
  is_active:               z.boolean().default(true),
  is_default:              z.boolean().default(false),
  needs_follow_up:         z.boolean().default(false),
  converts_to_appointment: z.boolean().default(false),
  is_pipeline:             z.boolean().default(true),
  logs_call:               z.boolean().default(false),
  is_locked:               z.boolean().default(false),
  // Its own flag, NOT is_pipeline — see migration 156. is_pipeline is about
  // dashboard value; this is about where a new WhatsApp message lands.
  is_closed:               z.boolean().default(false),
  // Where a RETURNING customer's new lead starts (migration 161). Two flags
  // because they are two different people: one said no and came back, the
  // other has already paid you.
  is_reenquiry:            z.boolean().default(false),
  is_repeat_customer:      z.boolean().default(false),
});

const SELECT_COLS = `
  id, name, color, bg_color, sort_order, is_active, is_default,
  needs_follow_up, converts_to_appointment, is_pipeline, logs_call, is_locked, is_closed,
  is_reenquiry, is_repeat_customer, created_at
`;

function listStatuses(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      `SELECT ${SELECT_COLS}
       FROM lead_statuses
       ${all ? '' : 'WHERE is_active = TRUE'}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ items: r.rows });
  });
}

function createStatus(req, res, next) {
  handle(req, res, next, async () => {
    const data = statusSchema.parse(req.body);
    const dup = await pool.query('SELECT id FROM lead_statuses WHERE LOWER(name) = LOWER($1)', [data.name]);
    if (dup.rows[0]) return res.status(409).json({ error: 'A status with this name already exists.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const maxRow = await client.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM lead_statuses');
      const nextOrder = maxRow.rows[0].next;
      if (data.is_default) {
        await client.query('UPDATE lead_statuses SET is_default = FALSE WHERE is_default = TRUE');
      }
      // Same "only one may hold it" handling is_default already gets, for the
      // two migration 161 flags. Cleared HERE rather than left to the partial
      // unique index, which would be correct and would surface as a 500 with a
      // Postgres constraint name in it — ticking a box somewhere else is a
      // choice, not an error.
      if (data.is_reenquiry) {
        await client.query('UPDATE lead_statuses SET is_reenquiry = FALSE WHERE is_reenquiry');
      }
      if (data.is_repeat_customer) {
        await client.query('UPDATE lead_statuses SET is_repeat_customer = FALSE WHERE is_repeat_customer');
      }
      const r = await client.query(
        `INSERT INTO lead_statuses
           (name, color, bg_color, sort_order, is_active, is_default, needs_follow_up, converts_to_appointment, is_pipeline, logs_call, is_locked, is_closed, is_reenquiry, is_repeat_customer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${SELECT_COLS}`,
        [data.name, data.color, data.bg_color, nextOrder, data.is_active, data.is_default,
         data.needs_follow_up, data.converts_to_appointment, data.is_pipeline, data.logs_call ?? false, data.is_locked ?? false, data.is_closed ?? false,
         data.is_reenquiry ?? false, data.is_repeat_customer ?? false]
      );
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'lead_statuses' });
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
      const dup = await pool.query('SELECT id FROM lead_statuses WHERE LOWER(name) = LOWER($1) AND id != $2', [data.name, id]);
      if (dup.rows[0]) return res.status(409).json({ error: 'A status with this name already exists.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── The old name, before it is gone ──────────────────────────────────
      //
      // Read inside the transaction and FOR UPDATE, because the rename below
      // depends on it and a value read a moment earlier is a value that may
      // already have changed.
      const before = await client.query(
        `SELECT name FROM lead_statuses WHERE id = $1 FOR UPDATE`, [id]);
      if (!before.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Status not found' });
      }
      const oldName = before.rows[0].name;

      if (data.is_default === true) {
        await client.query('UPDATE lead_statuses SET is_default = FALSE WHERE is_default = TRUE AND id != $1', [id]);
      }
      if (data.is_reenquiry === true) {
        await client.query('UPDATE lead_statuses SET is_reenquiry = FALSE WHERE is_reenquiry AND id != $1', [id]);
      }
      if (data.is_repeat_customer === true) {
        await client.query('UPDATE lead_statuses SET is_repeat_customer = FALSE WHERE is_repeat_customer AND id != $1', [id]);
      }

      const fields = []; const params = [];
      for (const [k, v] of Object.entries(data)) { params.push(v); fields.push(`${k} = $${params.length}`); }
      if (!fields.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing to update' }); }

      params.push(id);
      const r = await client.query(
        `UPDATE lead_statuses SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${SELECT_COLS}`,
        params
      );
      if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Status not found' }); }

      // ── Carry the rename to the leads that are wearing it ────────────────
      //
      // leads.status stores the NAME, not the id — migration 013 turned the
      // enum into VARCHAR(100) and nothing has referenced this table by key
      // since. So renaming a status here used to orphan every lead holding the
      // old string, and orphan them SILENTLY:
      //
      //   the board column and colour are matched on the name → grey, unsorted
      //   is_locked is matched on the name                    → editable again
      //   is_closed is matched on the name (migration 156)    → and this is the
      //     one that costs money. A status with no matching row is treated as
      //     OPEN by design, so renaming "Lost" quietly resurrects every Lost
      //     lead, and the next WhatsApp message from one of those customers is
      //     filed onto the dead lead instead of starting a fresh one — the
      //     exact failure migration 156 was written to prevent.
      //
      // Same transaction as the rename, necessarily: the two are one change,
      // and a crash between them leaves precisely the broken state above.
      //
      // Compared case-sensitively and exactly, because that is how the value
      // was written. Changing only the capitalisation is still a rename worth
      // carrying, so the guard is on identity, not on a normalised compare.
      let relabelled = 0;
      if (data.name && data.name !== oldName) {
        const moved = await client.query(
          `UPDATE leads SET status = $2, updated_at = NOW() WHERE status = $1`,
          [oldName, data.name]);
        relabelled = moved.rowCount;

        // ── And the history, which is the same name wearing a different hat ──
        //
        // Nothing in this schema stores a status ID. The name IS the key, so a
        // history row left on the old spelling does not preserve what was true
        // then — it splits one status into two in every report that groups on
        // it. getStageStats does exactly that, and after a rename it would show
        // "Lost" and "Lost Lead" as two separate stages with half the sample
        // each.
        //
        // Scoped by `type`, and that is not optional. lead_activities.new_value
        // holds a service name on service_added rows and a USER's name on
        // assigned_changed rows — an unscoped rewrite of a status called
        // "Priya" would quietly edit somebody's assignment history.
        await client.query(
          `UPDATE lead_activities SET new_value = $2
            WHERE new_value = $1 AND type IN ('status_changed', 'created')`,
          [oldName, data.name]);
        await client.query(
          `UPDATE lead_activities SET old_value = $2
            WHERE old_value = $1 AND type = 'status_changed'`,
          [oldName, data.name]);

        // Follow-ups are found by lead_id, so this is cosmetic — but a
        // follow-up card captioned with a status that no longer exists is the
        // kind of small wrongness nobody reports and everybody notices.
        await client.query(
          `UPDATE lead_events SET status_name = $2 WHERE status_name = $1`,
          [oldName, data.name]);

        if (relabelled) {
          console.log(`[lead_statuses] renamed "${oldName}" → "${data.name}", ` +
                      `moved ${relabelled} lead(s) with it`);
        }
      }

      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'lead_statuses' });
      // Reported so the screen can say "renamed, 42 leads updated" rather than
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

function deleteStatus(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT id, name, is_default FROM lead_statuses WHERE id = $1', [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Status not found' });
    if (row.rows[0].is_default) return res.status(409).json({ error: 'Cannot delete the default status. Set another status as default first.' });

    const name  = row.rows[0].name;
    const inUse = await pool.query('SELECT COUNT(*) FROM leads WHERE status = $1', [name]);
    if (Number(inUse.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${inUse.rows[0].count} lead(s) currently use this status. Reassign them first.`
      });
    }
    await pool.query('DELETE FROM lead_statuses WHERE id = $1', [id]);
    getIO().emit('invalidate', { topic: 'lead_statuses' });
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
      await client.query(
        // Batched: one statement instead of one UPDATE per row —
        // unnest preserves array order via WITH ORDINALITY.
        `UPDATE lead_statuses AS t SET sort_order = v.ord
           FROM unnest($1::int[]) WITH ORDINALITY AS v(id, ord)
          WHERE t.id = v.id`,
        [ids]
      );
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'lead_statuses' });
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
