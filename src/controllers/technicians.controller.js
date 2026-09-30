'use strict';

/**
 * Technicians — hub floor staff.
 *
 * ══ A TECHNICIAN IS NOT A LOGIN ════════════════════════════════════════════
 *
 * Nothing here creates a user, a password or a permission. A technician is a
 * name a hub picks from a dropdown on a job card. See migration 188 for why
 * that is the right shape and why free text is not.
 *
 * ══ WHO SEES WHOSE ═════════════════════════════════════════════════════════
 *
 * A hub login is pinned to its own hub, and the pinning is done in SQL from
 * req.user.hub_id — NEVER from a hub_id in the query string or the body. A
 * client that sends someone else's hub_id gets its own hub's data back, not a
 * 403 and not theirs. Spinoto staff holding MANAGE_MASTER_DATA or MANAGE_HUBS
 * see every hub and may filter by one.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { hubScopeSql, isHubUser, assertHubOwns } = require('../utils/hubScope');

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || 'Invalid request.' });
    }
    /* The partial unique index on (hub_id, employee_code). Reported as the
       business rule it is rather than as a constraint name nobody can read. */
    if (err?.code === '23505' && String(err.constraint || '').includes('technicians_code')) {
      return res.status(409).json({ error: 'That employee code is already used at this hub.' });
    }
    next(err);
  });
}

const techSchema = z.object({
  hub_id:        z.coerce.number().int().positive().optional(),
  name:          z.string().trim().min(1).max(120),
  mobile:        z.string().trim().max(20).nullable().optional(),
  skill:         z.string().trim().max(80).nullable().optional(),
  employee_code: z.string().trim().max(40).nullable().optional(),
  is_active:     z.boolean().optional(),
});

/** The hub a write belongs to: a hub login's own, always; otherwise the body's. */
function resolveHubId(req, body) {
  if (isHubUser(req)) return req.user.hub_id;
  return body.hub_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/technicians?hub_id=&include_inactive=
// ─────────────────────────────────────────────────────────────────────────────
function listTechnicians(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params = [];

    /* FIRST, and it wins: a hub login is pinned here, so the hub_id below is
       simply never reached for them. Ordering matters — read the other way
       round, a hub could widen itself with a query string. */
    const scope = hubScopeSql(req, params, 't.hub_id');
    if (scope) {
      conditions.push(scope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`t.hub_id = $${params.length}`);
    }

    /* Inactive staff are hidden by default: the list's main job is to be the
       source of a dropdown, and somebody who left should not be pickable. */
    if (String(req.query.include_inactive) !== 'true') {
      conditions.push('t.is_active');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT t.*, h.hub_name
         FROM technicians t
         JOIN hubs h ON h.id = t.hub_id
         ${where}
        ORDER BY h.hub_name, t.is_active DESC, t.name`, params
    );
    return res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/technicians
// ─────────────────────────────────────────────────────────────────────────────
function createTechnician(req, res, next) {
  handle(req, res, next, async () => {
    const d = techSchema.parse(req.body);
    const hubId = resolveHubId(req, d);
    if (!hubId) return res.status(400).json({ error: 'hub_id is required.' });

    const hub = await pool.query(`SELECT id FROM hubs WHERE id = $1`, [hubId]);
    if (!hub.rows[0]) return res.status(400).json({ error: 'That hub does not exist.' });

    const r = await pool.query(
      `INSERT INTO technicians (hub_id, name, mobile, skill, employee_code, created_by)
       VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6)
       RETURNING *`,
      [hubId, d.name, d.mobile ?? '', d.skill ?? '', d.employee_code ?? '', req.user?.id ?? null]
    );

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'technician', entityId: r.rows[0].id,
      description: `Technician "${d.name}" added to hub #${hubId}`,
    });
    return res.status(201).json({ item: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/technicians/:id
// ─────────────────────────────────────────────────────────────────────────────
function updateTechnician(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = techSchema.partial().parse(req.body);

    const existing = await pool.query(`SELECT * FROM technicians WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Technician not found' });
    /* Throws 404 rather than 403, so a hub cannot learn that another hub's
       technician id exists by the status code it gets back. */
    assertHubOwns(req, existing.rows[0], 'hub_id', 'Technician');

    /* hub_id is NOT updatable. Moving a technician between hubs would silently
       re-attribute every job card they appear on. A hub that lost someone
       deactivates them; the new hub adds them. */
    const fields = [], params = [];
    for (const k of ['name', 'mobile', 'skill', 'employee_code', 'is_active']) {
      if (d[k] === undefined) continue;
      const v = (k === 'is_active') ? d[k] : (d[k] === '' ? null : d[k]);
      params.push(v);
      fields.push(`${k} = $${params.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(id);
    const r = await pool.query(
      `UPDATE technicians SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`, params
    );
    return res.json({ item: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/technicians/:id
// ─────────────────────────────────────────────────────────────────────────────
function deleteTechnician(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const existing = await pool.query(`SELECT * FROM technicians WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Technician not found' });
    assertHubOwns(req, existing.rows[0], 'hub_id', 'Technician');

    /* The comment that used to live here said phase 3 would make this refuse.
       It does now: job_card_technicians (189) and job_card_labour (194) are
       both ON DELETE RESTRICT, and the time log means almost every technician
       who has done a day's work becomes undeletable.

       Asked BEFORE the delete rather than caught after it, so the answer is a
       count and a sentence rather than a foreign-key constraint name — a 500
       reading "job_card_labour_technician_id_fkey" is not a message for a
       service manager. */
    const used = await pool.query(
      `SELECT (SELECT COUNT(*) FROM job_card_technicians WHERE technician_id = $1)::int AS roster,
              (SELECT COUNT(*) FROM job_card_labour      WHERE technician_id = $1)::int AS labour,
              (SELECT COUNT(*) FROM job_card_inspections WHERE performed_by_technician = $1)::int AS inspections`,
      [id]);
    const { roster, labour, inspections } = used.rows[0];
    if (roster + labour + inspections > 0) {
      const bits = [];
      if (roster)      bits.push(`${roster} job card${roster === 1 ? '' : 's'}`);
      if (labour)      bits.push(`${labour} time entr${labour === 1 ? 'y' : 'ies'}`);
      if (inspections) bits.push(`${inspections} inspection${inspections === 1 ? '' : 's'}`);
      return res.status(409).json({
        error: `${existing.rows[0].name} has work recorded — ${bits.join(', ')}. Deactivate them instead; deleting would take the record of that work with them.`,
        code: 'TECHNICIAN_HAS_WORK',
        roster, labour, inspections,
      });
    }

    await pool.query(`DELETE FROM technicians WHERE id = $1`, [id]);
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'DELETE', entity: 'technician', entityId: id,
      description: `Technician "${existing.rows[0].name}" deleted`,
    });
    return res.json({ ok: true });
  });
}

module.exports = { listTechnicians, createTechnician, updateTechnician, deleteTechnician };
