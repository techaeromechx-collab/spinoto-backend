'use strict';

/**
 * Inspections, signatures and the body diagram.
 *
 * ══ A SEPARATE FILE, ON PURPOSE ════════════════════════════════════════════
 *
 * These endpoints all hang off a job card and all begin by loading it, so they
 * could have gone in job_cards.controller.js. They are here because that file
 * is already the card, its status ladder, its complaints, its technicians, its
 * items and its media — and an inspection is a document of its own with its own
 * lifecycle. What it shares with the card is the ownership check, and that is
 * IMPORTED (`loadCard`) rather than re-implemented, so there remains exactly
 * one place in this module that decides whether a hub may touch a card.
 *
 * ══ THE SNAPSHOT IS TAKEN ONCE, AT THE START ═══════════════════════════════
 *
 * `startInspection` copies the entire template — group names, point labels and
 * all three option labels — into job_card_inspection_results in one transaction.
 * After that the live template is never read again for this run. Editing a
 * checklist in Master Data changes the NEXT inspection and nothing that has
 * already begun. See migration 190's header for why that is not negotiable.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { loadCard, logJc, handle, idParam } = require('./job_cards.controller');
/* For the cross-card queue below. Every other handler in this file reaches a
   hub through loadCard; the queue has no single card to load, so it scopes in
   SQL the way the list endpoints do. */
const { hubScopeSql } = require('../utils/hubScope');

// ─────────────────────────────────────────────────────────────────────────────
// Which sheet fits this vehicle
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Candidate templates for a card, best first.
 *
 * A template with this vehicle type beats one that applies to everything
 * (vehicle_type_id IS NULL), and an EMPTY template is ranked last rather than
 * hidden: a hub that has not filled its sheet in needs to be told that, not
 * quietly given somebody else's sheet.
 */
async function candidateTemplates(vehicleTypeId, kind) {
  const r = await pool.query(
    `SELECT t.id, t.code, t.name, t.kind, t.vehicle_type_id,
            t.label_ok, t.label_attention, t.label_critical,
            COUNT(p.id)::int AS point_count
       FROM checklist_templates t
       LEFT JOIN checklist_groups g ON g.template_id = t.id AND g.is_active
       LEFT JOIN checklist_points p ON p.group_id = g.id AND p.is_active
      WHERE t.is_active
        AND t.kind = $1
        AND (t.vehicle_type_id = $2 OR t.vehicle_type_id IS NULL)
      GROUP BY t.id
      ORDER BY (t.vehicle_type_id = $2) DESC NULLS LAST,
               COUNT(p.id) DESC,
               t.id`,
    [kind, vehicleTypeId ?? null]
  );
  return r.rows;
}

// GET /api/job-cards/:id/inspection-templates?kind=intake
function listTemplatesForCard(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const kind = z.enum(['intake', 'pre_delivery']).parse(req.query.kind || 'intake');
    const card = await loadCard(req, id);

    const vt = await pool.query(
      `SELECT vehicle_type_id FROM appointments WHERE id = $1`, [card.appointment_id]);
    const items = await candidateTemplates(vt.rows[0]?.vehicle_type_id, kind);
    return res.json({ items, vehicle_type_id: vt.rows[0]?.vehicle_type_id ?? null });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/inspections — start a run
// ─────────────────────────────────────────────────────────────────────────────
const startSchema = z.object({
  kind:        z.enum(['intake', 'pre_delivery']),
  template_id: z.coerce.number().int().positive().optional(),
  performed_by_technician: z.coerce.number().int().positive().nullable().optional(),
});

function startInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = startSchema.parse(req.body);
    const card = await loadCard(req, id);

    const vt = await pool.query(
      `SELECT vehicle_type_id FROM appointments WHERE id = $1`, [card.appointment_id]);
    const vehicleTypeId = vt.rows[0]?.vehicle_type_id ?? null;

    let tpl;
    if (d.template_id) {
      const r = await pool.query(
        `SELECT t.*, COUNT(p.id)::int AS point_count
           FROM checklist_templates t
           LEFT JOIN checklist_groups g ON g.template_id = t.id AND g.is_active
           LEFT JOIN checklist_points p ON p.group_id = g.id AND p.is_active
          WHERE t.id = $1 GROUP BY t.id`, [d.template_id]);
      tpl = r.rows[0];
      if (!tpl) return res.status(404).json({ error: 'Checklist not found.' });
      if (tpl.kind !== d.kind) {
        return res.status(400).json({ error: `That checklist is a ${tpl.kind.replace('_', '-')} sheet.` });
      }
    } else {
      [tpl] = await candidateTemplates(vehicleTypeId, d.kind);
    }

    if (!tpl) {
      return res.status(400).json({
        error: 'No checklist is set up for this vehicle type yet. Add one under Master data → Checklists.',
      });
    }
    /* An empty sheet produces an inspection with nothing to answer and a
       signature under it — which is exactly the "assertion with no evidence"
       this phase exists to remove. Refusing, with the name of the sheet, is
       the only useful answer. */
    if (!tpl.point_count) {
      return res.status(400).json({
        error: `"${tpl.name}" has no points in it yet. Fill it in under Master data → Checklists first.`,
      });
    }

    /* The technician who did the work. Must be from this hub — the same rule
       as adding one to the card, enforced here because nothing in the schema
       ties job_card_inspections to a hub. */
    if (d.performed_by_technician) {
      const t = await pool.query(`SELECT hub_id FROM technicians WHERE id = $1`, [d.performed_by_technician]);
      if (!t.rows[0] || Number(t.rows[0].hub_id) !== Number(card.hub_id)) {
        return res.status(400).json({ error: 'That technician does not work at this hub.' });
      }
    }

    const client = await pool.connect();
    let inspectionId;
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO job_card_inspections
           (job_card_id, kind, template_id, template_code, template_name,
            label_ok, label_attention, label_critical,
            performed_by, performed_by_technician)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [id, d.kind, tpl.id, tpl.code, tpl.name,
         tpl.label_ok, tpl.label_attention, tpl.label_critical,
         req.user?.id ?? null, d.performed_by_technician ?? null]
      );
      inspectionId = ins.rows[0].id;

      /* THE SNAPSHOT. One INSERT ... SELECT rather than a loop: the rows are
         independent, nothing here depends on the order they land in, and the
         ordering that matters is carried in group_sort/sort_order as DATA.
         (The duplicate-template bug in phase 1 came from relying on RETURNING
         order instead — that mistake is not repeated here because no id from
         this insert is used for anything.) */
      await client.query(
        `INSERT INTO job_card_inspection_results
           (inspection_id, source_point_id, group_name, point_label,
            group_sort, sort_order, opt_ok, opt_attention, opt_critical)
         SELECT $1, p.id, g.name, p.label, g.sort_order, p.sort_order,
                MAX(o.label) FILTER (WHERE o.outcome = 'ok'),
                MAX(o.label) FILTER (WHERE o.outcome = 'attention'),
                MAX(o.label) FILTER (WHERE o.outcome = 'critical')
           FROM checklist_groups g
           JOIN checklist_points p ON p.group_id = g.id AND p.is_active
           LEFT JOIN checklist_point_options o ON o.point_id = p.id AND o.is_active
          WHERE g.template_id = $2 AND g.is_active
          GROUP BY p.id, g.name, p.label, g.sort_order, p.sort_order`,
        [inspectionId, tpl.id]
      );

      await logJc(client, id, req.user?.id, 'inspection:start', {
        newValue: d.kind, note: tpl.name,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      /* Released before the read-back below asks the pool for a client. Same
         rule as openJobCard — the pool is 10 wide with no acquire timeout, so
         holding one while waiting for another is a deadlock, not a delay. */
      client.release();
    }

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'job_card_inspection', entityId: inspectionId,
      description: `${d.kind === 'intake' ? 'Intake' : 'Pre-delivery'} inspection started on ${card.job_card_no} using "${tpl.name}"`,
    });

    return res.status(201).json({ item: await readInspection(inspectionId) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading one run
// ─────────────────────────────────────────────────────────────────────────────
async function readInspection(inspectionId) {
  const [head, results, photos, sigs] = await Promise.all([
    pool.query(
      `SELECT i.*, u.name AS performed_by_name, t.name AS technician_name,
              jc.job_card_no, jc.hub_id
         FROM job_card_inspections i
         JOIN job_cards jc ON jc.id = i.job_card_id
         LEFT JOIN users u  ON u.id = i.performed_by
         LEFT JOIN technicians t ON t.id = i.performed_by_technician
        WHERE i.id = $1`, [inspectionId]),
    pool.query(
      `SELECT * FROM job_card_inspection_results
        WHERE inspection_id = $1 ORDER BY group_sort, sort_order, id`, [inspectionId]),
    pool.query(
      `SELECT m.* FROM job_card_media m
         JOIN job_card_inspection_results r ON r.id = m.inspection_result_id
        WHERE r.inspection_id = $1 ORDER BY m.id`, [inspectionId]),
    pool.query(
      `SELECT s.*, u.name AS signed_by_user_name, t.name AS signed_by_technician_name
         FROM job_card_signatures s
         LEFT JOIN users u  ON u.id = s.signed_by_user
         LEFT JOIN technicians t ON t.id = s.signed_by_technician
        WHERE s.inspection_id = $1 ORDER BY s.id`, [inspectionId]),
  ]);
  if (!head.rows[0]) return null;

  /* Photos attached to their point, so the runner does not have to match them
     up in the browser and cannot get it wrong. */
  const byResult = new Map();
  for (const p of photos.rows) {
    if (!byResult.has(p.inspection_result_id)) byResult.set(p.inspection_result_id, []);
    byResult.get(p.inspection_result_id).push(p);
  }

  /* Grouped exactly as the paper is, and in the paper's order — group_sort
     then sort_order, both carried in the snapshot. */
  const groups = [];
  for (const r of results.rows) {
    let g = groups[groups.length - 1];
    if (!g || g.name !== r.group_name) {
      g = { name: r.group_name, sort_order: r.group_sort, points: [] };
      groups.push(g);
    }
    g.points.push({ ...r, photos: byResult.get(r.id) || [] });
  }

  const answered = results.rows.filter(r => r.outcome !== null);
  return {
    ...head.rows[0],
    groups,
    signatures:      sigs.rows,
    point_count:     results.rows.length,
    answered_count:  answered.length,
    attention_count: results.rows.filter(r => r.outcome === 'attention').length,
    critical_count:  results.rows.filter(r => r.outcome === 'critical').length,
  };
}

// GET /api/job-cards/:id/inspections/:inspectionId
function getInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    await loadCard(req, id);
    const item = await readInspection(iid);
    /* job_card_id checked against the card in the URL, not trusted from the
       inspection id — otherwise a run belonging to another hub's card could be
       read through a card this user does own. */
    if (!item || Number(item.job_card_id) !== Number(id)) {
      return res.status(404).json({ error: 'Inspection not found' });
    }
    return res.json({ item });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inspections?hub_id=&status=&kind=&search=&page=&limit=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Every inspection across every job card — the queue, not one card's history.
 *
 * ══ WHY THIS EXISTS AS ITS OWN SCREEN ══════════════════════════════════════
 *
 * `listInspections` below answers "what has been done to THIS car". Nobody
 * opens that to find out what is half-finished across the floor at four in the
 * afternoon, and until this endpoint existed there was no way to ask: an
 * inspection started and abandoned was invisible unless somebody happened to
 * open the card it was on.
 *
 * ══ DEFAULT ORDER ══════════════════════════════════════════════════════════
 *
 * Unfinished first, oldest unfinished at the top. A completed inspection is a
 * record; an unfinished one is a job, and the one that has been sitting
 * longest is the one most likely to have been forgotten. Sorting by date alone
 * would bury it under this morning's completions.
 */
function listAllInspections(req, res, next) {
  handle(req, res, next, async () => {
    /* TWO condition lists off ONE params array.
       `base` is everything except the status filter; `conditions` is base plus
       it. The counts query uses `base` so the tab bar keeps reporting both
       numbers while one tab is selected, and because both share the same
       params array the placeholder numbering cannot drift between them —
       which it would the moment anybody tried to strip a clause out of a
       finished WHERE string. */
    const base = [];
    const params = [];

    /* Scope first, and it wins — same rule as every other list in this module.
       Scoped on the CARD's hub, not the inspection's: an inspection has no hub
       of its own, and joining through the card is what makes it impossible for
       a hub to widen itself with a query string. */
    const scope = hubScopeSql(req, params, 'jc.hub_id');
    if (scope) {
      base.push(scope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      base.push(`jc.hub_id = $${params.length}`);
    }

    const kindList = String(req.query.kind || '').split(',')
      .map(s => s.trim()).filter(Boolean);
    if (kindList.length) {
      params.push(kindList);
      base.push(`i.kind = ANY($${params.length}::text[])`);
    }

    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      const p = `$${params.length}`;
      base.push(`(jc.job_card_no ILIKE ${p} OR a.vehicle_number ILIKE ${p}
                  OR a.customer_name ILIKE ${p} OR i.template_name ILIKE ${p})`);
    }

    /* Snapshot BEFORE the status placeholder is pushed. pg refuses a query
       given more parameters than it references, so the counts query — which
       leaves the status clause out — has to be given the shorter array, not
       the same one. */
    const baseParams = [...params];

    const conditions = [...base];
    const statusList = String(req.query.status || '').split(',')
      .map(s => s.trim()).filter(s => ['draft', 'completed'].includes(s));
    if (statusList.length) {
      params.push(statusList);
      conditions.push(`i.status = ANY($${params.length}::text[])`);
    }

    const JOINS = `FROM job_card_inspections i
                   JOIN job_cards    jc ON jc.id = i.job_card_id
                   JOIN appointments a  ON a.id  = jc.appointment_id`;
    const where     = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const whereBase = base.length       ? `WHERE ${base.join(' AND ')}`       : '';
    const limit  = Math.min(Number(req.query.limit) || 50, 200);
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const [rows, count, counts] = await Promise.all([
      pool.query(
        `SELECT i.id, i.kind, i.status, i.template_name, i.template_code,
                i.started_at, i.completed_at,
                jc.id AS job_card_id, jc.job_card_no, jc.status AS job_card_status,
                jc.appointment_id, jc.hub_id,
                h.hub_name, h.hub_code,
                a.appointment_code, a.customer_name, a.mobile, a.vehicle_number,
                u.name AS performed_by_name,
                t.name AS technician_name,
                COUNT(r.id)::int                                        AS point_count,
                COUNT(r.id) FILTER (WHERE r.outcome IS NOT NULL)::int   AS answered_count,
                COUNT(r.id) FILTER (WHERE r.outcome = 'attention')::int AS attention_count,
                COUNT(r.id) FILTER (WHERE r.outcome = 'critical')::int  AS critical_count
           ${JOINS}
           LEFT JOIN hubs        h ON h.id = jc.hub_id
           LEFT JOIN users       u ON u.id = i.performed_by
           LEFT JOIN technicians t ON t.id = i.performed_by_technician
           LEFT JOIN job_card_inspection_results r ON r.inspection_id = i.id
           ${where}
          GROUP BY i.id, jc.id, a.id, h.hub_name, h.hub_code, u.name, t.name
          ORDER BY (i.status = 'completed'), i.started_at ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),

      pool.query(`SELECT COUNT(*)::int AS n ${JOINS} ${where}`, params),

      /* `whereBase` — everything EXCEPT the status filter, for the reason the
         job card tabs give: a bar that empties itself when you use it is not a
         bar. `baseParams`, not `params`, because this query never references
         the status placeholder and pg rejects a bind with more parameters than
         the statement uses. */
      pool.query(`SELECT i.status, COUNT(*)::int AS n ${JOINS} ${whereBase}
                   GROUP BY i.status`, baseParams),
    ]);

    /* 'draft' is what migration 190 calls a sheet that is started and not
       finished. The screen labels it "Unfinished", because that is what it is
       to the person looking for it, but the key stays the schema's word. */
    const byStatus = { draft: 0, completed: 0 };
    for (const row of counts.rows) byStatus[row.status] = row.n;

    return res.json({
      items: rows.rows, total: count.rows[0].n, page, limit, counts: byStatus,
    });
  });
}

// GET /api/job-cards/:id/inspections
function listInspections(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    await loadCard(req, id);
    const r = await pool.query(
      `SELECT i.id, i.kind, i.status, i.template_name, i.started_at, i.completed_at,
              COUNT(r.id)::int                                        AS point_count,
              COUNT(r.id) FILTER (WHERE r.outcome IS NOT NULL)::int   AS answered_count
         FROM job_card_inspections i
         LEFT JOIN job_card_inspection_results r ON r.inspection_id = i.id
        WHERE i.job_card_id = $1 GROUP BY i.id ORDER BY i.id DESC`, [id]);
    return res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/job-cards/:id/inspections/:inspectionId/results — save answers
// ─────────────────────────────────────────────────────────────────────────────
/* A bulk save of the answers that CHANGED, not the whole sheet and not one
   request per tap. One request per tap on a 44-point sheet over a hub's phone
   connection is 44 chances to lose an answer; the whole sheet every time would
   let a stale tab overwrite a colleague's work on a point it never touched. */
const resultsSchema = z.object({
  results: z.array(z.object({
    id:      z.coerce.number().int().positive(),
    outcome: z.enum(['ok', 'attention', 'critical', 'na']).nullable().optional(),
    remarks: z.string().trim().max(1000).nullable().optional(),
  })).min(1).max(300),
});

function saveResults(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    const d   = resultsSchema.parse(req.body);
    await loadCard(req, id);

    const insp = await pool.query(
      `SELECT * FROM job_card_inspections WHERE id = $1 AND job_card_id = $2`, [iid, id]);
    if (!insp.rows[0]) return res.status(404).json({ error: 'Inspection not found' });

    /* A completed inspection is a signed document. Reopening it is a deliberate
       act with its own endpoint and its own timeline entry, not something a
       stray autosave can do. */
    if (insp.rows[0].status === 'completed') {
      return res.status(409).json({ error: 'This inspection is completed. Reopen it to change an answer.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of d.results) {
        const sets = [], params = [];
        if (row.outcome !== undefined) {
          params.push(row.outcome);
          sets.push(`outcome = $${params.length}`);
          /* option_label is DERIVED from the outcome and the snapshot's own
             three labels — never taken from the request. A client that sent
             its own text could write an answer the sheet never offered. */
          sets.push(`option_label = CASE $${params.length}
                       WHEN 'ok'        THEN opt_ok
                       WHEN 'attention' THEN opt_attention
                       WHEN 'critical'  THEN opt_critical
                       ELSE NULL END`);
          sets.push(`answered_at = ${row.outcome === null ? 'NULL' : 'NOW()'}`);
        }
        if (row.remarks !== undefined) {
          params.push(row.remarks === '' ? null : row.remarks);
          sets.push(`remarks = $${params.length}`);
        }
        if (!sets.length) continue;

        /* inspection_id in the WHERE: a result id from another run cannot be
           written through this one. */
        params.push(row.id, iid);
        await client.query(
          `UPDATE job_card_inspection_results SET ${sets.join(', ')}
            WHERE id = $${params.length - 1} AND inspection_id = $${params.length}`, params);
      }
      await client.query(
        `UPDATE job_card_inspections SET updated_at = NOW() WHERE id = $1`, [iid]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json({ item: await readInspection(iid) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/job-cards/:id/inspections/:inspectionId — notes and technician
// ─────────────────────────────────────────────────────────────────────────────
function updateInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    const d   = z.object({
      notes: z.string().trim().max(2000).nullable().optional(),
      performed_by_technician: z.coerce.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const card = await loadCard(req, id);

    if (d.performed_by_technician) {
      const t = await pool.query(`SELECT hub_id FROM technicians WHERE id = $1`, [d.performed_by_technician]);
      if (!t.rows[0] || Number(t.rows[0].hub_id) !== Number(card.hub_id)) {
        return res.status(400).json({ error: 'That technician does not work at this hub.' });
      }
    }

    const sets = [], params = [];
    for (const k of ['notes', 'performed_by_technician']) {
      if (d[k] === undefined) continue;
      params.push(d[k] === '' ? null : d[k]);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(iid, id);
    const r = await pool.query(
      `UPDATE job_card_inspections SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND job_card_id = $${params.length} RETURNING id`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Inspection not found' });

    return res.json({ item: await readInspection(iid) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/inspections/:inspectionId/complete
// ─────────────────────────────────────────────────────────────────────────────
function completeInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    const card = await loadCard(req, id);

    const insp = await pool.query(
      `SELECT * FROM job_card_inspections WHERE id = $1 AND job_card_id = $2`, [iid, id]);
    if (!insp.rows[0]) return res.status(404).json({ error: 'Inspection not found' });
    if (insp.rows[0].status === 'completed') return res.json({ item: await readInspection(iid), changed: false });

    /* EVERY POINT ANSWERED, AND THIS IS NOT A GATE THAT CAN TRAP ANYONE.
       'Not applicable' is always offered as a fourth answer on every point —
       even the ones whose sheet prints "–" in a column — so there is always a
       way to finish honestly. A half-filled sheet with a signature under it is
       the thing this phase exists to stop. */
    const blank = await pool.query(
      `SELECT group_name, point_label FROM job_card_inspection_results
        WHERE inspection_id = $1 AND outcome IS NULL
        ORDER BY group_sort, sort_order LIMIT 5`, [iid]);
    if (blank.rowCount) {
      const total = await pool.query(
        `SELECT COUNT(*)::int n FROM job_card_inspection_results
          WHERE inspection_id = $1 AND outcome IS NULL`, [iid]);
      return res.status(400).json({
        error: `${total.rows[0].n} point${total.rows[0].n === 1 ? ' is' : 's are'} still unanswered.`,
        unanswered: blank.rows,
        unanswered_count: total.rows[0].n,
      });
    }

    const r = await pool.query(
      `UPDATE job_card_inspections
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`, [iid]);

    const counts = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE outcome = 'attention')::int AS a,
              COUNT(*) FILTER (WHERE outcome = 'critical')::int  AS c
         FROM job_card_inspection_results WHERE inspection_id = $1`, [iid]);

    await logJc(pool, id, req.user?.id, 'inspection:complete', {
      newValue: r.rows[0].kind,
      note: `${r.rows[0].template_name} — ${counts.rows[0].a} ${r.rows[0].label_attention.toLowerCase()}, ${counts.rows[0].c} ${r.rows[0].label_critical.toLowerCase()}`,
    });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'UPDATE', entity: 'job_card_inspection', entityId: iid,
      description: `Inspection completed on ${card.job_card_no}: ${counts.rows[0].a} rectified/attention, ${counts.rows[0].c} critical`,
    });

    return res.json({ item: await readInspection(iid), changed: true });
  });
}

// POST /api/job-cards/:id/inspections/:inspectionId/reopen
function reopenInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    await loadCard(req, id);

    const r = await pool.query(
      `UPDATE job_card_inspections SET status = 'draft', completed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND job_card_id = $2 AND status = 'completed' RETURNING kind`, [iid, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No completed inspection to reopen.' });

    /* A reason is required and it goes on the timeline. Reopening a signed
       sheet is the one action here that can make an existing signature mean
       something different, so it leaves a mark. */
    await logJc(pool, id, req.user?.id, 'inspection:reopen', {
      oldValue: 'completed', newValue: 'draft', note: reason,
    });
    return res.json({ item: await readInspection(iid) });
  });
}

// DELETE /api/job-cards/:id/inspections/:inspectionId
function deleteInspection(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const iid = idParam.parse(req.params.inspectionId);
    await loadCard(req, id);

    const insp = await pool.query(
      `SELECT status, kind FROM job_card_inspections WHERE id = $1 AND job_card_id = $2`, [iid, id]);
    if (!insp.rows[0]) return res.status(404).json({ error: 'Inspection not found' });
    /* Same reasoning as deleting a job card: a completed inspection is the
       record. Reopen it, or run a new one — the failed run is often the one
       that matters most. */
    if (insp.rows[0].status === 'completed') {
      return res.status(409).json({ error: 'A completed inspection cannot be deleted. Reopen it instead.' });
    }
    const sig = await pool.query(
      `SELECT COUNT(*)::int n FROM job_card_signatures WHERE inspection_id = $1`, [iid]);
    if (sig.rows[0].n) {
      return res.status(409).json({ error: 'This inspection has been signed and cannot be deleted.' });
    }

    await pool.query(`DELETE FROM job_card_inspections WHERE id = $1`, [iid]);
    await logJc(pool, id, req.user?.id, 'inspection:delete', { oldValue: insp.rows[0].kind });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signatures
// ─────────────────────────────────────────────────────────────────────────────
const sigSchema = z.object({
  role:          z.enum(['customer', 'technician', 'qc', 'advisor']),
  stage:         z.enum(['intake', 'qc', 'delivery']).optional(),
  /* ALWAYS required. The drawn mark is the better evidence, but a phone that
     will not take a finger must never stop a car being handed over — and a
     signature nobody can read is not a signature. */
  signer_name:   z.string().trim().min(1).max(160),
  image_url:     z.string().trim().max(200000).nullable().optional(),
  inspection_id: z.coerce.number().int().positive().nullable().optional(),
  signed_by_technician: z.coerce.number().int().positive().nullable().optional(),
  override_reason: z.string().trim().max(500).nullable().optional(),
});

function addSignature(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = sigSchema.parse(req.body);
    const card = await loadCard(req, id);

    /* Either an http(s) URL or an inline data: image. Both are real: the
       drawing is produced in the browser as a data URL, and an ImageKit link
       is what it becomes once uploading is wired up. Anything else — a
       javascript: URL, a path on somebody's disk — is refused here rather
       than rendered into an <img> later. */
    if (d.image_url && !/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/i.test(d.image_url)) {
      return res.status(400).json({ error: 'A signature image must be an https link or an inline PNG.' });
    }

    if (d.inspection_id) {
      const owns = await pool.query(
        `SELECT 1 FROM job_card_inspections WHERE id = $1 AND job_card_id = $2`, [d.inspection_id, id]);
      if (!owns.rowCount) return res.status(404).json({ error: 'Inspection not found on this job card.' });
    }
    if (d.signed_by_technician) {
      const t = await pool.query(`SELECT hub_id, name FROM technicians WHERE id = $1`, [d.signed_by_technician]);
      if (!t.rows[0] || Number(t.rows[0].hub_id) !== Number(card.hub_id)) {
        return res.status(400).json({ error: 'That technician does not work at this hub.' });
      }
    }

    /* ── THE QC SIGNER RULE ────────────────────────────────────────────────
       A quality check signed by the person who did the work is not a quality
       check. So a 'qc' signature naming a technician is refused when that
       technician also worked on this card — whether as the inspection's
       performer or as a row on the card.

       It is NOT a dead end, and that matters: a one-mechanic hub still has to
       be able to deliver a car. A super admin may override with a reason, and
       the override is written to the job card's timeline where anybody
       reviewing the card will see it. */
    if (d.role === 'qc' && d.signed_by_technician) {
      const clash = await pool.query(
        `SELECT 1 FROM job_card_technicians
          WHERE job_card_id = $1 AND technician_id = $2
          UNION ALL
         SELECT 1 FROM job_card_inspections
          WHERE job_card_id = $1 AND performed_by_technician = $2
          LIMIT 1`, [id, d.signed_by_technician]);

      if (clash.rowCount) {
        if (!req.user?.is_super_admin) {
          return res.status(409).json({
            error: 'The quality check cannot be signed by someone who worked on this vehicle. Pick another technician, or ask a super admin to override.',
            code: 'QC_SIGNER_IS_WORKER',
          });
        }
        if (!(d.override_reason || '').trim()) {
          return res.status(400).json({
            error: 'Overriding this needs a reason — it goes on the job card timeline.',
            code: 'OVERRIDE_REASON_REQUIRED',
          });
        }
      }
    }

    const r = await pool.query(
      `INSERT INTO job_card_signatures
         (job_card_id, inspection_id, role, stage, signer_name, image_url,
          signed_by_user, signed_by_technician, override_reason)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,NULLIF($9,''))
       RETURNING *`,
      [id, d.inspection_id ?? null, d.role, d.stage || 'intake', d.signer_name,
       d.image_url ?? '', req.user?.id ?? null, d.signed_by_technician ?? null,
       d.override_reason ?? '']);

    await logJc(pool, id, req.user?.id, 'signature', {
      newValue: `${d.role}:${d.stage || 'intake'}`,
      note: d.signer_name + (d.image_url ? ' (drawn)' : ' (typed)'),
    });
    if (r.rows[0].override_reason) {
      await logJc(pool, id, req.user?.id, 'qc:override', {
        newValue: d.signer_name, note: r.rows[0].override_reason,
      });
      logActivity({
        userId: req.user?.id, userName: req.user?.name,
        action: 'UPDATE', entity: 'job_card', entityId: id,
        description: `QC signer rule overridden on ${card.job_card_no}: ${r.rows[0].override_reason}`,
      });
    }

    return res.status(201).json({ item: r.rows[0] });
  });
}

function deleteSignature(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const sid = idParam.parse(req.params.signatureId);
    await loadCard(req, id);
    /* Super admin only. Anyone who can remove a signature can remove the proof
       that they were the one who signed. */
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Only a super admin can remove a signature.' });
    }
    const r = await pool.query(
      `DELETE FROM job_card_signatures WHERE id = $1 AND job_card_id = $2
       RETURNING role, signer_name`, [sid, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Signature not found' });
    await logJc(pool, id, req.user?.id, 'signature:remove', {
      oldValue: `${r.rows[0].role}: ${r.rows[0].signer_name}`,
    });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/job-cards/:id/damage — the body diagram
// ─────────────────────────────────────────────────────────────────────────────
/* A whole-set replace PER STAGE. The intake marks and the delivery marks are
   two separate pictures and must never overwrite each other — comparing them
   is the entire point. */
const damageSchema = z.object({
  stage: z.enum(['intake', 'delivery']),
  marks: z.array(z.object({
    view:  z.string().trim().max(30).optional(),
    x_pct: z.coerce.number().min(0).max(100),
    y_pct: z.coerce.number().min(0).max(100),
    kind:  z.enum(['scratch', 'dent', 'crack', 'chip', 'rust', 'missing', 'other']),
    note:  z.string().trim().max(300).nullable().optional(),
  })).max(200),
});

function replaceDamage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = damageSchema.parse(req.body);
    await loadCard(req, id);

    const client = await pool.connect();
    let before;
    try {
      await client.query('BEGIN');
      const prev = await client.query(
        `SELECT COUNT(*)::int n FROM job_card_damage_marks
          WHERE job_card_id = $1 AND stage = $2`, [id, d.stage]);
      before = prev.rows[0].n;

      await client.query(
        `DELETE FROM job_card_damage_marks WHERE job_card_id = $1 AND stage = $2`, [id, d.stage]);
      for (const m of d.marks) {
        await client.query(
          `INSERT INTO job_card_damage_marks
             (job_card_id, view, x_pct, y_pct, kind, note, stage, created_by)
           VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8)`,
          [id, m.view || 'main', m.x_pct, m.y_pct, m.kind, m.note ?? '', d.stage, req.user?.id ?? null]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    /* One line when the count changes, not one per pin. Somebody adjusting
       where a scratch sits should not produce twelve timeline entries. */
    if (before !== d.marks.length) {
      await logJc(pool, id, req.user?.id, 'damage', {
        oldValue: String(before), newValue: String(d.marks.length), note: d.stage,
      });
    }

    const r = await pool.query(
      `SELECT * FROM job_card_damage_marks WHERE job_card_id = $1 ORDER BY id`, [id]);
    return res.json({ items: r.rows });
  });
}

module.exports = {
  listTemplatesForCard, startInspection, listInspections, listAllInspections, getInspection,
  saveResults, updateInspection, completeInspection, reopenInspection, deleteInspection,
  addSignature, deleteSignature, replaceDamage,
};
