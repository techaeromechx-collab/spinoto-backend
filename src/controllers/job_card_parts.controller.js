'use strict';

/**
 * Parts issued from the store, and the labour time log.
 *
 * ══ TWO LEDGERS, ONE SCREEN ════════════════════════════════════════════════
 *
 * `job_card_parts` is the store's ledger: what physically left the shelf for
 * this car. `estimate_items` is the customer's: what they agreed to pay for.
 * They are joined by an OPTIONAL `estimate_item_id`, and the gap between them
 * is the thing worth reporting — see `partsReconciliation` below.
 *
 * ══ WHY THE LINE IS VERIFIED, NOT TRUSTED ══════════════════════════════════
 *
 * `estimate_item_id` arrives from the browser, and an id is an id. Every write
 * re-reads it through `estimates.appointment_id = card.appointment_id` before
 * accepting it, so a line belonging to a different customer's visit cannot be
 * attached to this card by editing a request. The 400 that comes back says
 * "not on any estimate for this visit" rather than "forbidden", because the
 * honest case — a stale screen after somebody deleted the estimate — is far
 * more common than the dishonest one.
 *
 * ══ WHY RETURNS ARE ADDITIVE ═══════════════════════════════════════════════
 *
 * A storekeeper says "one more came back", not "the total returned is now
 * three". POST /return adds, and the DB CHECK (returned_quantity <= quantity)
 * is the backstop; the controller turns that constraint into a sentence
 * before it can ever fire.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { loadCard, logJc, handle, idParam } = require('./job_cards.controller');

const rowParam = z.coerce.number().int().positive();

/* ── Reading ────────────────────────────────────────────────────────────── */

const PARTS_SELECT = `
  SELECT p.*,
         u.name  AS issued_by_name,
         t.name  AS issued_to_name,
         ei.description   AS line_description,
         ei.quantity      AS line_quantity,
         ei.estimate_id   AS line_estimate_id,
         (p.quantity - p.returned_quantity) AS net_quantity
    FROM job_card_parts p
    LEFT JOIN users          u  ON u.id  = p.issued_by
    LEFT JOIN technicians    t  ON t.id  = p.issued_to
    LEFT JOIN estimate_items ei ON ei.id = p.estimate_item_id`;

const LABOUR_SELECT = `
  SELECT l.*,
         t.name  AS technician_name,
         t.skill AS technician_skill,
         u.name  AS created_by_name,
         ei.description AS line_description,
         ei.estimate_id AS line_estimate_id
    FROM job_card_labour l
    JOIN technicians     t  ON t.id  = l.technician_id
    LEFT JOIN users      u  ON u.id  = l.created_by
    LEFT JOIN estimate_items ei ON ei.id = l.estimate_item_id`;

/**
 * Every estimate line on this visit, with what has already been issued or
 * logged against it. This is what the pickers on the screen are built from,
 * and it is computed here rather than in the browser so that "2 of 3 issued"
 * cannot mean two different things in two places.
 */
async function billableLines(appointmentId) {
  const r = await pool.query(
    `SELECT ei.id, ei.estimate_id, ei.item_type, ei.description,
            ei.quantity, ei.customer_rate, ei.work_status,
            e.parent_estimate_id, e.status AS estimate_status,
            COALESCE(pq.issued, 0)  AS issued_quantity,
            COALESCE(lm.minutes, 0)::int AS logged_minutes
       FROM estimate_items ei
       JOIN estimates e ON e.id = ei.estimate_id
       LEFT JOIN LATERAL (
         SELECT SUM(quantity - returned_quantity) AS issued
           FROM job_card_parts WHERE estimate_item_id = ei.id) pq ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(minutes) AS minutes
           FROM job_card_labour WHERE estimate_item_id = ei.id) lm ON TRUE
      WHERE e.appointment_id = $1 AND e.status <> 'cancelled'
      ORDER BY (e.parent_estimate_id IS NOT NULL), e.id, ei.id`,
    [appointmentId]
  );
  return r.rows;
}

/**
 * The gap between the two ledgers, in the words a service manager would use.
 * Exported because the parts_reconciled gate answers from exactly this and
 * there must be one definition of "unbilled".
 *
 * A part is unbilled when the whole of it is still out (net quantity above
 * zero) and it has no estimate line. Customer-supplied parts are excluded
 * on purpose: they are never meant to be billed, and counting them would
 * make the gate cry wolf on every job where the customer brought their own
 * oil.
 */
async function partsReconciliation(jobCardId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE estimate_item_id IS NULL
                AND source <> 'customer'
                AND quantity - returned_quantity > 0)::int AS unbilled,
            COUNT(*) FILTER (WHERE returned_quantity > 0)::int AS with_returns,
            COALESCE(STRING_AGG(part_name, ', ') FILTER (
              WHERE estimate_item_id IS NULL
                AND source <> 'customer'
                AND quantity - returned_quantity > 0), ', ') AS unbilled_names
       FROM job_card_parts WHERE job_card_id = $1`,
    [jobCardId]
  );
  return r.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/:id/parts
// ─────────────────────────────────────────────────────────────────────────────
function listParts(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const card = await loadCard(req, id);
    const [rows, lines, recon] = await Promise.all([
      pool.query(`${PARTS_SELECT} WHERE p.job_card_id = $1 ORDER BY p.id`, [id]),
      billableLines(card.appointment_id),
      partsReconciliation(id),
    ]);
    return res.json({ items: rows.rows, lines, reconciliation: recon });
  });
}

/* Verifies a line belongs to THIS visit. Returns the row or throws a 400 that
   explains itself. Runs on the same client as the write when given one, so a
   line deleted between the check and the insert cannot slip through. */
async function requireLine(db, estimateItemId, appointmentId) {
  if (estimateItemId == null) return null;
  const r = await db.query(
    `SELECT ei.id, ei.description, ei.item_type
       FROM estimate_items ei
       JOIN estimates e ON e.id = ei.estimate_id
      WHERE ei.id = $1 AND e.appointment_id = $2`,
    [estimateItemId, appointmentId]
  );
  if (!r.rowCount) {
    const err = new Error('That line is not on any estimate for this visit. Reload the card and pick it again.');
    err.status = 400;
    throw err;
  }
  return r.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/parts
// ─────────────────────────────────────────────────────────────────────────────
const partSchema = z.object({
  part_id:          z.coerce.number().int().positive().nullable().optional(),
  estimate_item_id: z.coerce.number().int().positive().nullable().optional(),
  /* Optional only when part_id is given — the name is then copied from master
     data. One of the two must produce a name, and the refinement below says so
     in a sentence rather than leaving a NOT NULL to fail at the database. */
  part_name:        z.string().trim().min(1).max(200).optional(),
  part_number:      z.string().trim().max(100).nullable().optional(),
  quantity:         z.coerce.number().positive().max(99999),
  unit:             z.string().trim().min(1).max(20).optional(),
  source:           z.enum(['store', 'purchased', 'customer']).optional(),
  issued_to:        z.coerce.number().int().positive().nullable().optional(),
  old_part_shown:   z.boolean().nullable().optional(),
  note:             z.string().trim().max(500).nullable().optional(),
}).refine(d => d.part_name || d.part_id, {
  message: 'Give the part a name, or pick one from the parts list.',
});

function addPart(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const d    = partSchema.parse(req.body);
    const card = await loadCard(req, id);

    await requireLine(pool, d.estimate_item_id ?? null, card.appointment_id);

    /* The name is SNAPSHOT here and never read from `parts` again. Migration
       194 explains why: master data gets renamed, and a card from March has to
       keep saying what was actually fitted in March. */
    let name = d.part_name;
    if (!name && d.part_id) {
      const m = await pool.query(`SELECT name FROM parts WHERE id = $1`, [d.part_id]);
      if (!m.rowCount) {
        return res.status(400).json({ error: 'That part is not in the parts list any more. Type the name instead.' });
      }
      name = m.rows[0].name;
    }

    /* A technician issued to must belong to this hub. Same reasoning as the
       estimate line: an id from a browser is not a permission. */
    if (d.issued_to) {
      const t = await pool.query(
        `SELECT 1 FROM technicians WHERE id = $1 AND hub_id = $2`, [d.issued_to, card.hub_id]);
      if (!t.rowCount) {
        return res.status(400).json({ error: 'That technician does not work at this hub.' });
      }
    }

    const r = await pool.query(
      `INSERT INTO job_card_parts
         (job_card_id, part_id, estimate_item_id, part_name, part_number,
          quantity, unit, source, issued_by, issued_to, old_part_shown, note)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'nos'),COALESCE($8,'store'),$9,$10,$11,$12)
       RETURNING id`,
      [id, d.part_id ?? null, d.estimate_item_id ?? null, name, d.part_number ?? null,
       d.quantity, d.unit ?? null, d.source ?? null, req.user?.id ?? null,
       d.issued_to ?? null, d.old_part_shown ?? null, d.note ?? null]
    );

    await logJc(pool, id, req.user?.id, 'part:issued', {
      newValue: `${d.quantity} × ${name}`,
      note: d.estimate_item_id ? null : 'Not linked to an estimate line.',
    });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'JOB_CARD_PART_ISSUED', entityType: 'job_card', entityId: id,
      details: { part: name, quantity: d.quantity, billed: !!d.estimate_item_id },
    });

    const full = await pool.query(`${PARTS_SELECT} WHERE p.id = $1`, [r.rows[0].id]);
    return res.status(201).json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/job-cards/:id/parts/:rowId
// ─────────────────────────────────────────────────────────────────────────────
const partPatchSchema = z.object({
  estimate_item_id: z.coerce.number().int().positive().nullable().optional(),
  part_name:        z.string().trim().min(1).max(200).optional(),
  part_number:      z.string().trim().max(100).nullable().optional(),
  quantity:         z.coerce.number().positive().max(99999).optional(),
  unit:             z.string().trim().min(1).max(20).optional(),
  source:           z.enum(['store', 'purchased', 'customer']).optional(),
  issued_to:        z.coerce.number().int().positive().nullable().optional(),
  old_part_shown:   z.boolean().nullable().optional(),
  note:             z.string().trim().max(500).nullable().optional(),
});

function updatePart(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const rowId = rowParam.parse(req.params.rowId);
    const d     = partPatchSchema.parse(req.body);
    const card  = await loadCard(req, id);

    const existing = await pool.query(
      `SELECT * FROM job_card_parts WHERE id = $1 AND job_card_id = $2`, [rowId, id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'That part row is not on this job card.' });
    const before = existing.rows[0];

    if (d.estimate_item_id !== undefined) {
      await requireLine(pool, d.estimate_item_id ?? null, card.appointment_id);
    }

    /* Reducing the quantity below what has already come back is not an edit,
       it is a contradiction. Caught here so the person gets the numbers rather
       than a constraint name. */
    if (d.quantity !== undefined && Number(d.quantity) < Number(before.returned_quantity)) {
      return res.status(409).json({
        error: `${before.returned_quantity} of this part has already been returned — the issued quantity cannot be less than that.`,
        code: 'QUANTITY_BELOW_RETURNED',
      });
    }

    const sets = [], vals = [];
    let n = 1;
    for (const k of ['estimate_item_id', 'part_name', 'part_number', 'quantity',
                     'unit', 'source', 'issued_to', 'old_part_shown', 'note']) {
      if (d[k] !== undefined) { sets.push(`${k} = $${n++}`); vals.push(d[k] ?? null); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    sets.push('updated_at = NOW()');
    vals.push(rowId, id);

    await pool.query(
      `UPDATE job_card_parts SET ${sets.join(', ')} WHERE id = $${n++} AND job_card_id = $${n}`, vals);

    /* Linking a part to a line is the moment it stops being a leak, so it gets
       its own timeline entry rather than a generic "edited". */
    if (d.estimate_item_id !== undefined && !before.estimate_item_id && d.estimate_item_id) {
      await logJc(pool, id, req.user?.id, 'part:billed', { newValue: before.part_name });
    }

    const full = await pool.query(`${PARTS_SELECT} WHERE p.id = $1`, [rowId]);
    return res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/parts/:rowId/return
// ─────────────────────────────────────────────────────────────────────────────
const returnSchema = z.object({
  quantity: z.coerce.number().positive().max(99999),
  note:     z.string().trim().max(500).nullable().optional(),
});

function returnPart(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const rowId = rowParam.parse(req.params.rowId);
    const d     = returnSchema.parse(req.body);
    await loadCard(req, id);

    const existing = await pool.query(
      `SELECT * FROM job_card_parts WHERE id = $1 AND job_card_id = $2`, [rowId, id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'That part row is not on this job card.' });
    const row = existing.rows[0];

    const already   = Number(row.returned_quantity);
    const issued    = Number(row.quantity);
    const remaining = issued - already;
    if (d.quantity > remaining) {
      return res.status(409).json({
        error: remaining <= 0
          ? `All ${issued} of "${row.part_name}" has already come back.`
          : `Only ${remaining} of "${row.part_name}" is still out — ${already} has already been returned.`,
        code: 'RETURN_EXCEEDS_ISSUED',
        issued, already_returned: already, remaining,
      });
    }

    const r = await pool.query(
      `UPDATE job_card_parts
          SET returned_quantity = returned_quantity + $1,
              returned_at       = NOW(),
              return_note       = COALESCE($2, return_note),
              updated_at        = NOW()
        WHERE id = $3 AND job_card_id = $4
        RETURNING returned_quantity`,
      [d.quantity, d.note ?? null, rowId, id]
    );

    await logJc(pool, id, req.user?.id, 'part:returned', {
      newValue: `${d.quantity} × ${row.part_name}`,
      note: d.note ?? null,
    });

    const full = await pool.query(`${PARTS_SELECT} WHERE p.id = $1`, [rowId]);
    return res.json({ item: full.rows[0], returned_quantity: r.rows[0].returned_quantity });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/job-cards/:id/parts/:rowId
// ─────────────────────────────────────────────────────────────────────────────
function deletePart(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const rowId = rowParam.parse(req.params.rowId);
    await loadCard(req, id);

    const r = await pool.query(
      `DELETE FROM job_card_parts WHERE id = $1 AND job_card_id = $2 RETURNING part_name, quantity`,
      [rowId, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'That part row is not on this job card.' });

    await logJc(pool, id, req.user?.id, 'part:removed', {
      oldValue: `${r.rows[0].quantity} × ${r.rows[0].part_name}`,
    });
    return res.status(204).end();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// LABOUR
// ═════════════════════════════════════════════════════════════════════════════

/* Minutes on the wire, hours on the screen. The API accepts `hours` as well
   because a phone keypad is a bad place to type 135, and converts immediately
   so that only one number is ever stored. */
const labourBase = z.object({
  technician_id:    z.coerce.number().int().positive(),
  estimate_item_id: z.coerce.number().int().positive().nullable().optional(),
  task:             z.string().trim().max(300).optional(),
  minutes:          z.coerce.number().int().positive().max(1440).optional(),
  hours:            z.coerce.number().positive().max(24).optional(),
  worked_on:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note:             z.string().trim().max(500).nullable().optional(),
});

/* The refinement lives on a DERIVED schema, not on the base. `.refine()`
   returns a ZodEffects, and ZodEffects has no `.partial()` — writing
   `labourSchema.partial()` in updateLabour throws a TypeError that surfaces as
   a bare 500 on every edit. The base object is what PATCH makes partial; the
   refined one is what POST parses. */
const labourSchema = labourBase.refine(d => d.minutes != null || d.hours != null, {
  message: 'Say how long it took.',
});

function toMinutes(d) {
  if (d.minutes != null) return d.minutes;
  /* Rounded, not floored: 1.51 hours typed by a person means "about an hour
     and a half", and 90 is a better answer than 90.6 truncated to 90 by luck. */
  const m = Math.round(d.hours * 60);
  if (m < 1)    { const e = new Error('That is less than a minute.'); e.status = 400; throw e; }
  if (m > 1440) { const e = new Error('More than 24 hours in one entry — split it by day.'); e.status = 400; throw e; }
  return m;
}

function listLabour(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const card = await loadCard(req, id);
    const [rows, summary, lines] = await Promise.all([
      pool.query(`${LABOUR_SELECT} WHERE l.job_card_id = $1 ORDER BY l.worked_on, l.id`, [id]),
      labourSummary(id),
      billableLines(card.appointment_id),
    ]);
    return res.json({ items: rows.rows, summary, lines });
  });
}

/* Per technician and in total. Computed in SQL so the screen, the gate and any
   future report all read the same number. */
async function labourSummary(jobCardId) {
  const [total, byTech] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(minutes), 0)::int AS minutes,
              COUNT(*)::int                  AS entries,
              COUNT(DISTINCT technician_id)::int AS technicians
         FROM job_card_labour WHERE job_card_id = $1`, [jobCardId]),
    pool.query(
      `SELECT l.technician_id, t.name AS technician_name,
              SUM(l.minutes)::int AS minutes, COUNT(*)::int AS entries
         FROM job_card_labour l JOIN technicians t ON t.id = l.technician_id
        WHERE l.job_card_id = $1
        GROUP BY l.technician_id, t.name
        ORDER BY minutes DESC, t.name`, [jobCardId]),
  ]);
  return { ...total.rows[0], by_technician: byTech.rows };
}

function addLabour(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const d    = labourSchema.parse(req.body);
    const card = await loadCard(req, id);
    const minutes = toMinutes(d);

    const t = await pool.query(
      `SELECT name FROM technicians WHERE id = $1 AND hub_id = $2`, [d.technician_id, card.hub_id]);
    if (!t.rowCount) return res.status(400).json({ error: 'That technician does not work at this hub.' });

    const line = await requireLine(pool, d.estimate_item_id ?? null, card.appointment_id);

    /* The task is snapshot from the line when one was picked and nothing was
       typed, for the reason part_name is snapshot: the estimate can be edited
       afterwards and the time log has to keep saying what the time was spent
       on. */
    const task = d.task || line?.description || 'Work on this job card';

    const r = await pool.query(
      `INSERT INTO job_card_labour
         (job_card_id, technician_id, estimate_item_id, task, minutes, worked_on, note, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date),$7,$8)
       RETURNING id`,
      [id, d.technician_id, d.estimate_item_id ?? null, task, minutes,
       d.worked_on ?? null, d.note ?? null, req.user?.id ?? null]
    );

    await logJc(pool, id, req.user?.id, 'labour:logged', {
      newValue: `${t.rows[0].name} — ${fmtMinutes(minutes)} on ${task}`,
    });

    const full = await pool.query(`${LABOUR_SELECT} WHERE l.id = $1`, [r.rows[0].id]);
    return res.status(201).json({ item: full.rows[0], summary: await labourSummary(id) });
  });
}

function updateLabour(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const rowId = rowParam.parse(req.params.rowId);
    const card  = await loadCard(req, id);
    const d = labourBase.partial().parse(req.body);

    const existing = await pool.query(
      `SELECT * FROM job_card_labour WHERE id = $1 AND job_card_id = $2`, [rowId, id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'That time entry is not on this job card.' });

    if (d.technician_id !== undefined) {
      const t = await pool.query(
        `SELECT 1 FROM technicians WHERE id = $1 AND hub_id = $2`, [d.technician_id, card.hub_id]);
      if (!t.rowCount) return res.status(400).json({ error: 'That technician does not work at this hub.' });
    }
    if (d.estimate_item_id !== undefined) {
      await requireLine(pool, d.estimate_item_id ?? null, card.appointment_id);
    }

    const sets = [], vals = [];
    let n = 1;
    if (d.minutes != null || d.hours != null) { sets.push(`minutes = $${n++}`); vals.push(toMinutes(d)); }
    for (const k of ['technician_id', 'estimate_item_id', 'task', 'note']) {
      if (d[k] !== undefined) { sets.push(`${k} = $${n++}`); vals.push(d[k] ?? null); }
    }
    if (d.worked_on !== undefined) { sets.push(`worked_on = $${n++}::date`); vals.push(d.worked_on); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    sets.push('updated_at = NOW()');
    vals.push(rowId, id);

    await pool.query(
      `UPDATE job_card_labour SET ${sets.join(', ')} WHERE id = $${n++} AND job_card_id = $${n}`, vals);

    const full = await pool.query(`${LABOUR_SELECT} WHERE l.id = $1`, [rowId]);
    return res.json({ item: full.rows[0], summary: await labourSummary(id) });
  });
}

function deleteLabour(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const rowId = rowParam.parse(req.params.rowId);
    await loadCard(req, id);

    const r = await pool.query(
      `DELETE FROM job_card_labour WHERE id = $1 AND job_card_id = $2 RETURNING task, minutes`,
      [rowId, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'That time entry is not on this job card.' });

    await logJc(pool, id, req.user?.id, 'labour:removed', {
      oldValue: `${fmtMinutes(r.rows[0].minutes)} on ${r.rows[0].task}`,
    });
    return res.json({ summary: await labourSummary(id) });
  });
}

/* One place that turns minutes into the string a person reads, so the timeline
   and the screen never disagree about whether 90 is "1.5h" or "1h 30m". */
function fmtMinutes(m) {
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

module.exports = {
  listParts, addPart, updatePart, returnPart, deletePart,
  listLabour, addLabour, updateLabour, deleteLabour,
  /* Shared with job_card_gates.controller.js and job_cards.controller.js —
     one definition of "unbilled" and one of "how long did this take". */
  partsReconciliation, labourSummary, billableLines, fmtMinutes,
  PARTS_SELECT, LABOUR_SELECT,
};
