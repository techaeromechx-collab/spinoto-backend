'use strict';

/**
 * Checklist master — the editable inspection templates.
 *
 * ══ THESE ARE QUESTIONS, NOT ANSWERS ═══════════════════════════════════════
 *
 * Everything here is a template. The results of running one live on the job
 * card (phase 4) and COPY the labels rather than referencing them, so editing
 * a template cannot rewrite an inspection somebody already signed. Nothing in
 * this file should ever be read while rendering a completed inspection.
 *
 * ══ OPTIONS RIDE WITH THE POINT ════════════════════════════════════════════
 *
 * A point's three outcome labels are edited as part of the point, not through
 * three more endpoints. `options: { ok, attention, critical }` — a string sets
 * that label, and null or an omitted key REMOVES it, which is how the "–" on
 * the printed sheet is expressed. One call, one transaction, and the shape on
 * the wire matches the row the user is looking at.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { isHubUser } = require('../utils/hubScope');

const idParam = z.coerce.number().int().positive();
const OUTCOMES = ['ok', 'attention', 'critical'];

/* Hub logins never reach this. Checklist templates are Spinoto master data —
   a hub fills checklists in, it does not design them — and the routes gate on
   MANAGE_MASTER_DATA, which no hub role holds. Checked again here in case the
   route is ever copied to a permission set that does. */
function denyHub(req, res) {
  if (isHubUser(req)) {
    res.status(403).json({ error: 'Checklist templates are managed by Spinoto.' });
    return true;
  }
  return false;
}

/** Wraps a handler the way the rest of the codebase does. */
function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || 'Invalid request.' });
    }
    next(err);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/checklists — every template, with counts
// ─────────────────────────────────────────────────────────────────────────────
function listTemplates(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const r = await pool.query(
      `SELECT t.*,
              vt.name AS vehicle_type_name,
              /* Counted over ACTIVE rows only: the number on the card should
                 say how long the sheet a mechanic sees is, not how many rows
                 the table happens to hold. */
              (SELECT COUNT(*) FROM checklist_groups g
                WHERE g.template_id = t.id AND g.is_active)::int AS group_count,
              (SELECT COUNT(*) FROM checklist_points p
                 JOIN checklist_groups g ON g.id = p.group_id
                WHERE g.template_id = t.id AND g.is_active AND p.is_active)::int AS point_count
         FROM checklist_templates t
         LEFT JOIN vehicle_types vt ON vt.id = t.vehicle_type_id
        ORDER BY t.kind, t.name`
    );
    return res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/checklists/:id — one template, whole tree
// ─────────────────────────────────────────────────────────────────────────────
function getTemplate(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const id = idParam.parse(req.params.id);

    const t = await pool.query(
      `SELECT t.*, vt.name AS vehicle_type_name
         FROM checklist_templates t
         LEFT JOIN vehicle_types vt ON vt.id = t.vehicle_type_id
        WHERE t.id = $1`, [id]
    );
    if (!t.rows[0]) return res.status(404).json({ error: 'Checklist not found' });

    /* One query for the whole tree rather than a query per group. A 44-point
       sheet is 10 groups; per-group fetching is 11 round trips for a screen
       that always wants all of it. */
    const rows = await pool.query(
      `SELECT g.id AS group_id, g.name AS group_name, g.sort_order AS group_sort, g.is_active AS group_active,
              p.id AS point_id, p.label AS point_label, p.sort_order AS point_sort, p.is_active AS point_active,
              o.id AS option_id, o.outcome, o.label AS option_label
         FROM checklist_groups g
         LEFT JOIN checklist_points p ON p.group_id = g.id
         LEFT JOIN checklist_point_options o ON o.point_id = p.id
        WHERE g.template_id = $1
        ORDER BY g.sort_order, g.id, p.sort_order, p.id`, [id]
    );

    const groups = [];
    const gIdx = new Map();
    const pIdx = new Map();
    for (const r of rows.rows) {
      if (!gIdx.has(r.group_id)) {
        const g = { id: r.group_id, name: r.group_name, sort_order: r.group_sort,
                    is_active: r.group_active, points: [] };
        gIdx.set(r.group_id, g);
        groups.push(g);
      }
      if (r.point_id && !pIdx.has(r.point_id)) {
        const p = { id: r.point_id, label: r.point_label, sort_order: r.point_sort,
                    is_active: r.point_active,
                    /* Always all three keys, null where the sheet prints "–".
                       The screen then renders three columns without having to
                       decide what an absent key means. */
                    options: { ok: null, attention: null, critical: null } };
        pIdx.set(r.point_id, p);
        gIdx.get(r.group_id).points.push(p);
      }
      if (r.option_id) pIdx.get(r.point_id).options[r.outcome] = r.option_label;
    }

    return res.json({ item: { ...t.rows[0], groups } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates — create / update / delete / duplicate
// ─────────────────────────────────────────────────────────────────────────────
const templateSchema = z.object({
  name:            z.string().trim().min(1).max(120),
  kind:            z.enum(['intake', 'pre_delivery']),
  vehicle_type_id: z.coerce.number().int().positive().nullable().optional(),
  label_ok:        z.string().trim().min(1).max(40).optional(),
  label_attention: z.string().trim().min(1).max(40).optional(),
  label_critical:  z.string().trim().min(1).max(40).optional(),
  is_active:       z.boolean().optional(),
});

function createTemplate(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const d = templateSchema.parse(req.body);
    /* Derived, not asked for: `code` exists so the seed and any future
       migration can find a template without depending on its name, which
       people rename. Suffixed on collision rather than refused — a second
       "4W Monsoon Check" is a reasonable thing to want. */
    const base = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
                 || 'checklist';
    let code = base;
    for (let n = 2; ; n++) {
      const clash = await pool.query(`SELECT 1 FROM checklist_templates WHERE code = $1`, [code]);
      if (!clash.rows[0]) break;
      code = `${base}_${n}`;
    }

    const r = await pool.query(
      `INSERT INTO checklist_templates
         (code, name, kind, vehicle_type_id, label_ok, label_attention, label_critical, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'OK'), COALESCE($6, 'Needs attention'),
               COALESCE($7, 'Critical'), $8)
       RETURNING *`,
      [code, d.name, d.kind, d.vehicle_type_id ?? null,
       d.label_ok ?? null, d.label_attention ?? null, d.label_critical ?? null, req.user?.id ?? null]
    );

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'checklist_template', entityId: r.rows[0].id,
      description: `Checklist template "${d.name}" created (${d.kind})`,
    });
    return res.status(201).json({ item: r.rows[0] });
  });
}

function updateTemplate(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const id = idParam.parse(req.params.id);
    const d = templateSchema.partial().parse(req.body);

    const fields = [];
    const params = [];
    for (const k of ['name', 'kind', 'vehicle_type_id', 'label_ok',
                     'label_attention', 'label_critical', 'is_active']) {
      if (d[k] !== undefined) { params.push(d[k]); fields.push(`${k} = $${params.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(id);
    const r = await pool.query(
      `UPDATE checklist_templates SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`, params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Checklist not found' });
    return res.json({ item: r.rows[0] });
  });
}

function deleteTemplate(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const id = idParam.parse(req.params.id);
    const r = await pool.query(`DELETE FROM checklist_templates WHERE id = $1 RETURNING name`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Checklist not found' });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'DELETE', entity: 'checklist_template', entityId: id,
      description: `Checklist template "${r.rows[0].name}" deleted`,
    });
    return res.json({ ok: true });
  });
}

/* Copy a whole template. This is how the two empty seeded templates get
   filled: duplicate the 4W intake, rename it, delete the rows that do not
   belong on a delivery sheet. Far less work than typing 44 points again. */
function duplicateTemplate(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const id = idParam.parse(req.params.id);
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const src = await client.query(`SELECT * FROM checklist_templates WHERE id = $1`, [id]);
      if (!src.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Checklist not found' }); }
      const s = src.rows[0];

      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'checklist';
      let code = base;
      for (let n = 2; ; n++) {
        const clash = await client.query(`SELECT 1 FROM checklist_templates WHERE code = $1`, [code]);
        if (!clash.rows[0]) break;
        code = `${base}_${n}`;
      }

      const t = await client.query(
        `INSERT INTO checklist_templates
           (code, name, kind, vehicle_type_id, label_ok, label_attention, label_critical, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [code, name, s.kind, s.vehicle_type_id, s.label_ok, s.label_attention, s.label_critical, req.user?.id ?? null]
      );
      const newId = t.rows[0].id;

      /* Copied ROW BY ROW, each new id captured from its own INSERT.
         `INSERT ... SELECT ... ORDER BY ... RETURNING id` is the obvious way
         to write this and it is WRONG: Postgres does not promise RETURNING
         comes back in the source SELECT's order, so pairing the two result
         sets by index can silently hang a group's points off a different
         group. It would work almost every time and corrupt a copy eventually.

         One statement per row is more round trips for a 44-point sheet, and
         duplicating a template is a once-in-a-while action on a screen where
         nobody is waiting on a stopwatch. Correctness wins that trade. */
      const srcGroups = await client.query(
        `SELECT id, name, sort_order, is_active FROM checklist_groups
          WHERE template_id = $1 ORDER BY sort_order, id`, [id]
      );
      for (const g of srcGroups.rows) {
        const ng = await client.query(
          `INSERT INTO checklist_groups (template_id, name, sort_order, is_active)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [newId, g.name, g.sort_order, g.is_active]
        );
        const newG = ng.rows[0].id;

        const srcPoints = await client.query(
          `SELECT id, label, sort_order, is_active FROM checklist_points
            WHERE group_id = $1 ORDER BY sort_order, id`, [g.id]
        );
        for (const pt of srcPoints.rows) {
          const np = await client.query(
            `INSERT INTO checklist_points (group_id, label, sort_order, is_active)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [newG, pt.label, pt.sort_order, pt.is_active]
          );
          /* Options carry no ordering of their own — one row per outcome — so
             this one can stay a set-based copy. */
          await client.query(
            `INSERT INTO checklist_point_options (point_id, outcome, label, is_active)
             SELECT $1, outcome, label, is_active FROM checklist_point_options WHERE point_id = $2`,
            [np.rows[0].id, pt.id]
          );
        }
      }

      await client.query('COMMIT');
      logActivity({
        userId: req.user?.id, userName: req.user?.name,
        action: 'CREATE', entity: 'checklist_template', entityId: newId,
        description: `Checklist template "${name}" duplicated from "${s.name}"`,
      });
      return res.status(201).json({ item: t.rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    } finally { client.release(); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────
const groupSchema = z.object({
  name:       z.string().trim().min(1).max(120),
  sort_order: z.coerce.number().int().optional(),
  is_active:  z.boolean().optional(),
});

function createGroup(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const templateId = idParam.parse(req.params.id);
    const d = groupSchema.parse(req.body);
    const t = await pool.query(`SELECT 1 FROM checklist_templates WHERE id = $1`, [templateId]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Checklist not found' });

    /* Appended, not inserted at a position: a new group goes at the bottom and
       the user drags it where they want. COALESCE covers the first group. */
    const r = await pool.query(
      `INSERT INTO checklist_groups (template_id, name, sort_order)
       VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 1
                                       FROM checklist_groups WHERE template_id = $1)))
       RETURNING *`, [templateId, d.name, d.sort_order ?? null]
    );
    return res.status(201).json({ item: r.rows[0] });
  });
}

function updateGroup(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const groupId = idParam.parse(req.params.groupId);
    const d = groupSchema.partial().parse(req.body);
    const fields = [], params = [];
    for (const k of ['name', 'sort_order', 'is_active']) {
      if (d[k] !== undefined) { params.push(d[k]); fields.push(`${k} = $${params.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
    params.push(groupId);
    const r = await pool.query(
      `UPDATE checklist_groups SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Group not found' });
    return res.json({ item: r.rows[0] });
  });
}

function deleteGroup(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const groupId = idParam.parse(req.params.groupId);
    const r = await pool.query(`DELETE FROM checklist_groups WHERE id = $1 RETURNING id`, [groupId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Group not found' });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Points — label and its three option labels, together
// ─────────────────────────────────────────────────────────────────────────────
const optionsSchema = z.object({
  ok:        z.string().trim().max(60).nullable().optional(),
  attention: z.string().trim().max(60).nullable().optional(),
  critical:  z.string().trim().max(60).nullable().optional(),
});
const pointSchema = z.object({
  label:      z.string().trim().min(1).max(200),
  sort_order: z.coerce.number().int().optional(),
  is_active:  z.boolean().optional(),
  options:    optionsSchema.optional(),
});

/* Writes the three option rows for one point. An empty string is treated as
   null — a user clearing the box means "this column does not apply", which is
   the "–" on the sheet, not a blank label nobody can click. */
async function _writeOptions(db, pointId, options) {
  if (!options) return;
  for (const outcome of OUTCOMES) {
    if (!(outcome in options)) continue;
    const raw = options[outcome];
    const label = raw == null ? null : String(raw).trim();
    if (!label) {
      await db.query(`DELETE FROM checklist_point_options WHERE point_id = $1 AND outcome = $2`,
                     [pointId, outcome]);
    } else {
      await db.query(
        `INSERT INTO checklist_point_options (point_id, outcome, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (point_id, outcome) DO UPDATE SET label = EXCLUDED.label`,
        [pointId, outcome, label]
      );
    }
  }
}

function createPoint(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const groupId = idParam.parse(req.params.groupId);
    const d = pointSchema.parse(req.body);
    const g = await pool.query(`SELECT 1 FROM checklist_groups WHERE id = $1`, [groupId]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Group not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO checklist_points (group_id, label, sort_order)
         VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 1
                                         FROM checklist_points WHERE group_id = $1)))
         RETURNING *`, [groupId, d.label, d.sort_order ?? null]
      );
      await _writeOptions(client, r.rows[0].id, d.options);
      await client.query('COMMIT');
      return res.status(201).json({ item: r.rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    } finally { client.release(); }
  });
}

function updatePoint(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const pointId = idParam.parse(req.params.pointId);
    const d = pointSchema.partial().parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fields = [], params = [];
      for (const k of ['label', 'sort_order', 'is_active']) {
        if (d[k] !== undefined) { params.push(d[k]); fields.push(`${k} = $${params.length}`); }
      }
      let row;
      if (fields.length) {
        params.push(pointId);
        const r = await client.query(
          `UPDATE checklist_points SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params
        );
        row = r.rows[0];
      } else {
        const r = await client.query(`SELECT * FROM checklist_points WHERE id = $1`, [pointId]);
        row = r.rows[0];
      }
      if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Point not found' }); }
      await _writeOptions(client, pointId, d.options);
      await client.query('COMMIT');
      return res.json({ item: row });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    } finally { client.release(); }
  });
}

function deletePoint(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const pointId = idParam.parse(req.params.pointId);
    const r = await pool.query(`DELETE FROM checklist_points WHERE id = $1 RETURNING id`, [pointId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Point not found' });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/checklists/:id/reorder — one call for a whole drag
// ─────────────────────────────────────────────────────────────────────────────
const reorderSchema = z.object({
  groups: z.array(z.object({
    id: idParam,
    sort_order: z.coerce.number().int(),
  })).max(200).optional(),
  points: z.array(z.object({
    id: idParam,
    group_id: idParam.optional(),
    sort_order: z.coerce.number().int(),
  })).max(2000).optional(),
});

/* One transaction for the whole drag. Reordering by a PATCH per row would
   leave the sheet half-sorted if the network dropped in the middle, and a
   half-sorted checklist is one a mechanic reads in the wrong order.
   `group_id` on a point is optional so the same call covers dragging a point
   between groups, which is the same gesture to the user. */
function reorder(req, res, next) {
  handle(req, res, next, async () => {
    if (denyHub(req, res)) return;
    const templateId = idParam.parse(req.params.id);
    const d = reorderSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const g of d.groups || []) {
        /* Scoped to the template in the WHERE clause, so an id from another
           template cannot be reordered through this route. */
        await client.query(
          `UPDATE checklist_groups SET sort_order = $1 WHERE id = $2 AND template_id = $3`,
          [g.sort_order, g.id, templateId]
        );
      }
      for (const p of d.points || []) {
        if (p.group_id !== undefined) {
          await client.query(
            `UPDATE checklist_points SET sort_order = $1, group_id = $2
              WHERE id = $3
                AND EXISTS (SELECT 1 FROM checklist_groups WHERE id = $2 AND template_id = $4)
                AND group_id IN (SELECT id FROM checklist_groups WHERE template_id = $4)`,
            [p.sort_order, p.group_id, p.id, templateId]
          );
        } else {
          await client.query(
            `UPDATE checklist_points SET sort_order = $1
              WHERE id = $2
                AND group_id IN (SELECT id FROM checklist_groups WHERE template_id = $3)`,
            [p.sort_order, p.id, templateId]
          );
        }
      }
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    } finally { client.release(); }
  });
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, duplicateTemplate,
  createGroup, updateGroup, deleteGroup,
  createPoint, updatePoint, deletePoint,
  reorder,
};
