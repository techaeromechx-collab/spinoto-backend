'use strict';

/**
 * Job cards — the working document for one vehicle visit.
 *
 * ══ THIS FILE IS THE SINGLE WRITER OF THE WORKSHOP-FLOOR STATUS ════════════
 *
 * appointments.status already describes this same journey and three things
 * already write it: a user picking by hand, the estimate's auto-advance, and
 * the pickup endpoints. Adding a fourth independent ladder would give two
 * records that can disagree — the card saying Quality Check while the
 * appointment says Work In Progress, with nobody able to say which is true.
 *
 * So the job card status is the one that moves, and the appointment status
 * MIRRORS it through STATUS_MAP below. One direction only. This file never
 * reads the appointment status back and never decides anything from it.
 *
 * advanceAppointmentStatus is the same helper estimates, invoices and warranty
 * claims already call, so the WhatsApp automations an admin configured against
 * "Work Completed" keep firing exactly as they do today — the job card changes
 * who moves the status, not what happens when it moves.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════════
 *
 * No compliance gates. Nothing yet refuses to move to `ready` because the
 * complaints are unanswered or the QC is unsigned — that is phase 5, and
 * bolting half of it on now would give a check that can be relied on in some
 * places and not others, which is worse than no check. Phase 4 adds the
 * inspection sheet; phase 7 adds parts and per-technician time.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { hubScopeSql, isHubUser, assertHubOwns } = require('../utils/hubScope');
const { generateJobCardCode } = require('../utils/jobCardCode');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { readDeclinedWork } = require('../services/declinedWork.service');

const idParam = z.coerce.number().int().positive();

/* ── The mapping ──────────────────────────────────────────────────────────────
   Job card status → the appointment status slug it writes. Slugs, not names:
   names are editable by an admin in Settings, slugs are not (migration 036).

   Two pairs collapse on purpose:
     open / inspection    → both are "the vehicle is here and nothing is priced"
     ready / delivered    → the customer-facing state is the same; who has the
                            keys is a job card detail, not an appointment one.

   `closed` maps to 'closed', which customer_invoices.controller.js also writes
   when an invoice is fully paid. That is not a conflict: both mean the same
   thing and advanceAppointmentStatus is a no-op when the status already matches.

   A status with no entry here (currently only `cancelled`, which the
   appointment's own cancel flow already owns) leaves the appointment alone. */
const STATUS_MAP = Object.freeze({
  open:               'at-workshop',
  inspection:         'at-workshop',
  awaiting_estimate:  'estimate-created',
  awaiting_approval:  'estimate-submitted',
  in_progress:        'work-in-progress',
  on_hold:            'waiting-for-parts',
  work_done:          'work-completed',
  qc:                 'quality-check',
  ready:              'ready-for-delivery',
  delivered:          'ready-for-delivery',
  closed:             'closed',
});

const STATUSES = Object.freeze([
  'open', 'inspection', 'awaiting_estimate', 'awaiting_approval',
  'in_progress', 'on_hold', 'work_done', 'qc', 'ready',
  'delivered', 'closed', 'cancelled',
]);

/* ── What is in the vehicle ───────────────────────────────────────────────────
   Seeded on open so the intake check is a set of answers rather than a blank
   box somebody has to remember to fill. Two lists because a bike has no jack
   and a car has no helmet — offering the wrong one trains people to tick 'na'
   without reading, which is the failure this section exists to prevent.

   A constant for now. When a hub asks for its own list this becomes a table
   beside the checklist templates; the shape here (label + sort_order) is
   already the shape that table would have, so nothing stored has to move. */
const DEFAULT_ITEMS_4W = [
  'Stepney / spare wheel', 'Jack & tools', 'Tool kit', 'Wheel caps',
  'Floor mats', 'Music system / stereo', 'Speakers', 'Mirror (LH/RH)',
  'Fog lamps', 'Wiper blades', 'Documents in car', 'First aid kit',
  'Fire extinguisher', 'Battery', 'Antenna', 'Personal belongings',
];
const DEFAULT_ITEMS_2W = [
  'Tool kit', 'Mirror (LH/RH)', 'Seat cover', 'Number plate (front/rear)',
  'Helmet', 'Documents', 'Fuel tank cap', 'Side stand', 'Battery',
  'Personal belongings',
];

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || 'Invalid request.' });
    }
    /* appointment_id is UNIQUE. Two people pressing "Open job card" on the same
       appointment at the same moment is the ordinary way to reach this, and the
       right answer is the business rule, not a constraint name. */
    if (err?.code === '23505' && String(err.constraint || '').includes('job_cards_appointment_id')) {
      return res.status(409).json({ error: 'This appointment already has a job card.' });
    }
    /* technician_id is ON DELETE RESTRICT on both the roster (migration 189)
       and the time log (migration 194). Deleting somebody who left must never
       take the record of their work — and the time log is the bigger half of
       that record, so it has to produce the same sentence. */
    if (err?.code === '23503' && /job_card_technicians|job_card_labour/.test(String(err.constraint || ''))) {
      return res.status(409).json({ error: 'That technician has work recorded on a job card. Deactivate them instead.' });
    }
    /* A CHECK, not a constraint we can pre-empt everywhere: the return endpoint
       catches the ordinary case with a sentence of its own, and this is the
       backstop for any other path that could push a return past what went out. */
    if (err?.code === '23514' && String(err.constraint || '').includes('job_card_parts_return_within_issue')) {
      return res.status(409).json({ error: 'More of that part has been returned than was ever issued.' });
    }
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

/* Writes one row of the timeline. Called on every change that a person would
   later want to account for, which on this record is nearly all of them —
   the job card is the document produced in a dispute, and a signature with no
   trail behind it proves very little. */
async function logJc(client, jobCardId, userId, type, { oldValue, newValue, note } = {}) {
  await client.query(
    `INSERT INTO job_card_activities (job_card_id, type, old_value, new_value, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobCardId, type, oldValue ?? null, newValue ?? null, note ?? null, userId ?? null]
  );
}

/* Loads the card and refuses it to a hub that does not own it — 404, not 403,
   so an id cannot be confirmed by the status code alone. Every :id route below
   starts here; none of them trusts an id straight from the URL. */
async function loadCard(req, id, client = pool) {
  const r = await client.query(`SELECT * FROM job_cards WHERE id = $1`, [id]);
  const card = r.rows[0];
  if (!card) {
    const err = new Error('Job card not found');
    err.status = 404;
    throw err;
  }
  assertHubOwns(req, card, 'hub_id', 'Job card');
  return card;
}

const JC_SELECT = `
  SELECT
    jc.*,
    h.hub_name, h.hub_code,
    a.appointment_code,
    a.public_token AS appointment_token,
    a.customer_name,
    a.mobile,
    a.vehicle_number,
    TO_CHAR(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
    a.scheduled_time,
    vt.name AS vehicle_type_name,
    mk.name AS make_name,
    md.name AS model_name,
    /* The IDs as well as the names, so the card can ask /api/pricing/lookup
       for a rate exactly as the estimate form does. Resolving a price any other
       way here would be a second pricing implementation, and the two would
       drift — which is the one thing step 3 was ordered to avoid. Segment, body
       type and cc category come off the MODEL, which is where the pricing rules
       read them from. */
    a.vehicle_type_id,
    a.make_id,
    a.model_id,
    md.segment_id,
    md.body_type_id,
    md.cc_category_id,
    ast.name     AS appointment_status_name,
    ast.color    AS appointment_status_color,
    ast.bg_color AS appointment_status_bg,
    ou.name AS opened_by_name,
    (SELECT COUNT(*) FROM job_card_complaints  c WHERE c.job_card_id = jc.id) AS complaint_count,
    (SELECT COUNT(*) FROM job_card_media       m WHERE m.job_card_id = jc.id) AS media_count,
    (SELECT COUNT(*) FROM job_card_technicians t WHERE t.job_card_id = jc.id) AS technician_count,
    -- For the Activity badge. Cheap: idx_jc_activities (job_card_id, created_at)
    -- from migration 189 covers it, so this is an index-only count per row.
    (SELECT COUNT(*) FROM job_card_activities ja WHERE ja.job_card_id = jc.id)::int AS activity_count,
    (SELECT e.id FROM estimates e WHERE e.appointment_id = jc.appointment_id
      ORDER BY e.id DESC LIMIT 1) AS estimate_id
  FROM job_cards jc
  JOIN hubs h         ON h.id  = jc.hub_id
  JOIN appointments a ON a.id  = jc.appointment_id
  LEFT JOIN vehicle_types      vt  ON vt.id  = a.vehicle_type_id
  LEFT JOIN vehicle_makes      mk  ON mk.id  = a.make_id
  LEFT JOIN vehicle_models     md  ON md.id  = a.model_id
  LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
  LEFT JOIN users ou  ON ou.id = jc.opened_by
`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/counts?hub_id=&search=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * How many cards sit at each status, under the SAME hub scope and search the
 * list is using.
 *
 * ══ WHY A SEPARATE ENDPOINT, NOT A FIELD ON THE LIST ═══════════════════════
 *
 * The list is paginated and filtered BY status. Counting inside it would count
 * the page, not the workshop, and filtering to "in progress" would report
 * every other status as zero — a tab bar that empties itself the moment you
 * use it.
 *
 * ══ WHY IT IGNORES `status` DELIBERATELY ═══════════════════════════════════
 *
 * `status` is the one filter this must NOT honour, for the reason above. Hub
 * scope and search are honoured, so searching a vehicle number re-counts the
 * tabs against that search, which is what a person expects.
 */
function listJobCardCounts(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params = [];

    /* Same order as the list: scope first and it wins, so a hub cannot widen
       its own counts with a query string. */
    const scope = hubScopeSql(req, params, 'jc.hub_id');
    if (scope) {
      conditions.push(scope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`jc.hub_id = $${params.length}`);
    }

    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      const p = `$${params.length}`;
      conditions.push(`(jc.job_card_no ILIKE ${p} OR a.appointment_code ILIKE ${p}
                        OR a.vehicle_number ILIKE ${p} OR a.customer_name ILIKE ${p}
                        OR a.mobile ILIKE ${p})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT jc.status, COUNT(*)::int AS n
         FROM job_cards jc JOIN appointments a ON a.id = jc.appointment_id
         ${where} GROUP BY jc.status`, params);

    /* Every status is present, zero included. A tab that disappears when it
       empties makes the bar jump about, and "On hold: 0" is information — it
       is the answer to "is anything stuck". */
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const row of r.rows) counts[row.status] = row.n;

    return res.json({
      counts,
      total: r.rows.reduce((s, row) => s + row.n, 0),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards?hub_id=&status=&search=&page=&limit=
// ─────────────────────────────────────────────────────────────────────────────
function listJobCards(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params = [];

    /* FIRST, and it wins. Read the other way round a hub could widen itself
       with a query string — same ordering rule as technicians and estimates. */
    const scope = hubScopeSql(req, params, 'jc.hub_id');
    if (scope) {
      conditions.push(scope);
    } else if (req.query.hub_id) {
      params.push(Number(req.query.hub_id));
      conditions.push(`jc.hub_id = $${params.length}`);
    }

    /* Multi-select, the same shape the appointments list now uses: a workshop
       screen wants "in progress OR on hold OR waiting QC" in one view. */
    const statusList = String(req.query.status || '').split(',')
      .map(s => s.trim()).filter(s => STATUSES.includes(s));
    if (statusList.length) {
      params.push(statusList);
      conditions.push(`jc.status = ANY($${params.length}::text[])`);
    }

    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      const p = `$${params.length}`;
      conditions.push(`(jc.job_card_no ILIKE ${p} OR a.appointment_code ILIKE ${p}
                        OR a.vehicle_number ILIKE ${p} OR a.customer_name ILIKE ${p}
                        OR a.mobile ILIKE ${p})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(Number(req.query.limit) || 50, 200);
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      pool.query(
        `${JC_SELECT} ${where} ORDER BY jc.opened_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM job_cards jc
           JOIN appointments a ON a.id = jc.appointment_id ${where}`,
        params
      ),
    ]);

    return res.json({ items: rows.rows, total: count.rows[0].n, page, limit });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/settings — which sections are switched on
// ─────────────────────────────────────────────────────────────────────────────
/* The global row merged with this hub's override, so the caller gets one
   object and never has to know two rows existed. Spread order matters: the
   hub's keys win, and a hub that overrides one toggle does not silently lose
   the other seven. */
async function readSettings(hubId) {
  const r = await pool.query(
    `SELECT hub_id, sections FROM job_card_settings
      WHERE hub_id IS NULL OR hub_id = $1`, [hubId ?? null]
  );
  const global = r.rows.find(x => x.hub_id === null)?.sections || {};
  const own    = hubId ? (r.rows.find(x => Number(x.hub_id) === Number(hubId))?.sections || {}) : {};
  return { ...global, ...own };
}

function getSettings(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = isHubUser(req) ? req.user.hub_id : (req.query.hub_id ? Number(req.query.hub_id) : null);
    return res.json({ sections: await readSettings(hubId), hub_id: hubId });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/job-cards/settings
// ─────────────────────────────────────────────────────────────────────────────
function updateSettings(req, res, next) {
  handle(req, res, next, async () => {
    const body = z.object({
      hub_id:   z.coerce.number().int().positive().nullable().optional(),
      sections: z.record(z.boolean()),
    }).parse(req.body);

    /* A hub login can only ever write its own row, whatever it sent. Staff
       writing with no hub_id are editing the global default. */
    const hubId = isHubUser(req) ? req.user.hub_id : (body.hub_id ?? null);

    const r = hubId === null
      ? await pool.query(
          `UPDATE job_card_settings SET sections = $1::jsonb, updated_at = NOW()
            WHERE hub_id IS NULL RETURNING sections`, [JSON.stringify(body.sections)])
      : await pool.query(
          `INSERT INTO job_card_settings (hub_id, sections)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (hub_id) DO UPDATE
             SET sections = EXCLUDED.sections, updated_at = NOW()
           RETURNING sections`, [hubId, JSON.stringify(body.sections)]);

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'UPDATE', entity: 'job_card_settings', entityId: hubId ?? 0,
      description: hubId ? `Job card sections changed for hub #${hubId}` : 'Job card sections changed (global default)',
    });
    return res.json({ sections: r.rows[0]?.sections || body.sections });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/by-appointment/:appointmentId
// ─────────────────────────────────────────────────────────────────────────────
/* Returns 200 with item:null rather than 404 when no card exists. The caller is
   an appointment screen asking "is there one?", and a missing card is an
   ordinary answer to that question, not an error worth a red toast. */
function getByAppointment(req, res, next) {
  handle(req, res, next, async () => {
    const apptId = idParam.parse(req.params.appointmentId);
    const r = await pool.query(`${JC_SELECT} WHERE jc.appointment_id = $1`, [apptId]);
    const card = r.rows[0];
    if (!card) return res.json({ item: null });
    assertHubOwns(req, card, 'hub_id', 'Job card');
    return res.json({ item: await hydrate(card, req) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/:id
// ─────────────────────────────────────────────────────────────────────────────
function getJobCard(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    await loadCard(req, id);                      // ownership, before anything else
    const r = await pool.query(`${JC_SELECT} WHERE jc.id = $1`, [id]);
    return res.json({ item: await hydrate(r.rows[0], req) });
  });
}

/* Everything hanging off the card, in one round trip's worth of parallel
   queries. Five small selects beat one join that multiplies rows together and
   has to be unpicked in JavaScript afterwards. */
async function hydrate(card, req) {
  const [complaints, techs, items, media, sections,
         inspections, signatures, damage, gatePass, estimates,
         parts, labour, booked, lines, declinedBefore, readings] = await Promise.all([
    pool.query(`SELECT * FROM job_card_complaints WHERE job_card_id = $1 ORDER BY sort_order, id`, [card.id]),
    pool.query(
      `SELECT jt.*, t.name AS technician_name, t.skill, t.employee_code
         FROM job_card_technicians jt
         JOIN technicians t ON t.id = jt.technician_id
        WHERE jt.job_card_id = $1 ORDER BY jt.id`, [card.id]),
    pool.query(`SELECT * FROM job_card_items WHERE job_card_id = $1 ORDER BY sort_order, id`, [card.id]),
    pool.query(`SELECT * FROM job_card_media WHERE job_card_id = $1 ORDER BY created_at`, [card.id]),
    readSettings(card.hub_id),

    /* Inspections arrive as SUMMARIES, not with their 44 answers each. The
       card screen shows "intake — completed, 3 need attention"; the answers
       are fetched only when somebody opens that sheet. Otherwise loading a
       job card with two completed inspections drags 88 rows nobody is
       looking at. */
    pool.query(
      `SELECT i.id, i.kind, i.status, i.template_name, i.template_code,
              i.label_ok, i.label_attention, i.label_critical,
              i.started_at, i.completed_at, i.notes,
              u.name AS performed_by_name,
              t.name AS technician_name,
              COUNT(r.id)::int                                            AS point_count,
              COUNT(r.id) FILTER (WHERE r.outcome IS NOT NULL)::int       AS answered_count,
              COUNT(r.id) FILTER (WHERE r.outcome = 'attention')::int     AS attention_count,
              COUNT(r.id) FILTER (WHERE r.outcome = 'critical')::int      AS critical_count
         FROM job_card_inspections i
         LEFT JOIN users       u ON u.id = i.performed_by
         LEFT JOIN technicians t ON t.id = i.performed_by_technician
         LEFT JOIN job_card_inspection_results r ON r.inspection_id = i.id
        WHERE i.job_card_id = $1
        GROUP BY i.id, u.name, t.name
        ORDER BY i.id DESC`, [card.id]),

    pool.query(
      `SELECT s.*, u.name AS signed_by_user_name, t.name AS signed_by_technician_name
         FROM job_card_signatures s
         LEFT JOIN users       u ON u.id = s.signed_by_user
         LEFT JOIN technicians t ON t.id = s.signed_by_technician
        WHERE s.job_card_id = $1 ORDER BY s.id`, [card.id]),

    pool.query(
      `SELECT * FROM job_card_damage_marks WHERE job_card_id = $1 ORDER BY id`, [card.id]),

    pool.query(
      `SELECT gp.*, u.name AS issued_by_name FROM job_card_gate_passes gp
         LEFT JOIN users u ON u.id = gp.issued_by
        WHERE gp.job_card_id = $1`, [card.id]),

    /* Every estimate for this VISIT — the original and any supplementary
       (migration 193) — keyed off the appointment rather than job_card_id,
       because an estimate raised before the card was opened has a NULL
       job_card_id and still belongs to the same visit. Ordered original first,
       which is the order a person reads them in.

       Each carries whether it has been invoiced, since that is the question
       the billing gate answers and the screen should not have to ask twice. */
    pool.query(
      `SELECT e.id, e.public_token, e.status, e.grand_total,
              e.parent_estimate_id, e.created_at,
              EXISTS (SELECT 1 FROM customer_invoices ci
                       WHERE ci.estimate_id = e.id AND ci.status <> 'cancelled') AS invoiced
         FROM estimates e
        WHERE e.appointment_id = $1
        ORDER BY (e.parent_estimate_id IS NOT NULL), e.id`, [card.appointment_id]),

    /* Parts issued from the store and the time log (migration 194). Both are
       small — a handful of rows per card — so they come with the card rather
       than behind another request, unlike inspection answers. */
    pool.query(
      `SELECT p.*, u.name AS issued_by_name, t.name AS issued_to_name,
              ei.description AS line_description,
              (p.quantity - p.returned_quantity) AS net_quantity
         FROM job_card_parts p
         LEFT JOIN users          u  ON u.id  = p.issued_by
         LEFT JOIN technicians    t  ON t.id  = p.issued_to
         LEFT JOIN estimate_items ei ON ei.id = p.estimate_item_id
        WHERE p.job_card_id = $1 ORDER BY p.id`, [card.id]),

    pool.query(
      `SELECT l.*, t.name AS technician_name, t.skill AS technician_skill,
              u.name AS created_by_name, ei.description AS line_description
         FROM job_card_labour l
         JOIN technicians     t  ON t.id  = l.technician_id
         LEFT JOIN users      u  ON u.id  = l.created_by
         LEFT JOIN estimate_items ei ON ei.id = l.estimate_item_id
        WHERE l.job_card_id = $1 ORDER BY l.worked_on, l.id`, [card.id]),

    /* ── What the customer actually booked ──────────────────────────────────
       The advisor picked these services when the customer rang, and
       appointment_services has held them ever since. Until now nothing on the
       job card read that table, so the one list the customer had actually
       agreed to was the one list the workshop could not see.

       `on_estimate` is an INDICATOR, not a link. It answers "does some
       estimate for this visit have a line for this service", matched on
       service_id, because there is no foreign key between a booking row and an
       estimate line and inventing one would be a guess. Two lines of the same
       service, or a service billed under a different one, will therefore read
       as covered. It is here to surface the common and expensive case — a
       service the customer booked that nobody put on the estimate at all — not
       to reconcile line by line. The parts gate does that job for parts.

       Cancelled estimates do not count as coverage: a service that was quoted
       and then had its estimate cancelled is exactly as unbilled as one that
       was never quoted. */
    pool.query(
      `SELECT aps.id, aps.service_id, aps.price AS booked_price,
              s.name AS service_name, s.gst_percent, s.sac_code,
              sc.name AS category_name,
              EXISTS (
                SELECT 1
                  FROM estimate_items ei
                  JOIN estimates e ON e.id = ei.estimate_id
                 WHERE e.appointment_id = $1
                   AND e.status <> 'cancelled'
                   AND ei.item_type = 'service'
                   AND ei.service_id = aps.service_id
              ) AS on_estimate
         FROM appointment_services aps
         JOIN services s ON s.id = aps.service_id
         LEFT JOIN service_categories sc ON sc.id = aps.category_id
        WHERE aps.appointment_id = $1
        ORDER BY aps.id`, [card.appointment_id]),

    /* ── Every quoted line for this visit, and where the customer stands on it ──
       The card has always listed the ESTIMATES. It has never shown the lines
       inside them, so "the customer said no to the brake pads" was a fact that
       existed only on another screen, and the card went on showing the full
       ₹5,600 as though all of it were agreed.

       Shipped inline rather than behind another request, like parts and labour
       and unlike inspection answers: a visit has a handful of lines, not the 44
       answers per sheet that drove the history out of this payload in phase 9.

       Cancelled estimates are excluded for the same reason they are excluded
       from the booking panel — a cancelled document authorises nothing.

       customer_approved is a TRISTATE and the difference matters: TRUE agreed,
       FALSE refused, NULL not yet asked. Collapsing NULL into FALSE would show
       a customer who has not answered as one who declined. */
    pool.query(
      `SELECT ei.id, ei.estimate_id, ei.item_type, ei.description,
              ei.quantity, ei.customer_rate, ei.gst_percent, ei.total_inc_gst,
              ei.customer_approved, ei.work_status,
              ei.is_from_appointment, ei.booked_price,
              e.status             AS estimate_status,
              e.parent_estimate_id AS estimate_parent_id
         FROM estimate_items ei
         JOIN estimates e ON e.id = ei.estimate_id
        WHERE e.appointment_id = $1
          AND e.status <> 'cancelled'
        ORDER BY (e.parent_estimate_id IS NOT NULL), e.id, ei.id`,
      [card.appointment_id]),

    /* ── What this car was quoted before, and the customer said no to ────────
       Declined work has always been kept — applyItemApprovals writes FALSE and
       leaves the row alone, and the Authorisation panel above says so. What
       never happened is anyone being told about it on the NEXT visit. The car
       comes back, the same pads are still worn, and the advisor standing at
       this card has no idea it was offered at ₹2,000 in March.

       readDeclinedWork is the one definition of "declined and not since done",
       shared with the estimate form and the vehicle history — see that service
       for why it is not three queries.

       THIS visit is excluded. Its own declines are already on this screen, in
       the Authorisation panel, with buttons; showing them again under History
       would read as a second refusal. */
    readDeclinedWork(pool, {
      mobile: card.mobile,
      vehicleNumber: card.vehicle_number,
      excludeAppointmentId: card.appointment_id,
      // A hub sees only what was refused AT THIS HUB. What a customer turned
      // down somewhere else is not this hub's to read.
      hubId: isHubUser(req) ? (req.user?.hub_id ?? null) : null,
    }),

    /* ── Every reading taken on this card (migration 196) ────────────────────
       The four columns say the car did 18 km somewhere between arrival and
       handover. They cannot say when, or under whose name — and those are the
       two things asked when a customer rings about mileage they did not expect.

       Inline rather than behind another request, like parts and labour: a visit
       has a handful of transitions, not the 44 answers per inspection sheet
       that drove the history out of this payload in phase 9. */
    pool.query(
      `SELECT r.id, r.status_from, r.status_to, r.odometer, r.fuel, r.note,
              r.source, r.recorded_at,
              u.name AS recorded_by_name
         FROM job_card_readings r
         LEFT JOIN users u ON u.id = r.recorded_by
        WHERE r.job_card_id = $1
        ORDER BY r.recorded_at, r.id`, [card.id]),
  ]);

  /* ── What has actually been billed, and what is still owed ──────────────────
     The card could say whether an estimate had been invoiced. It could not say
     for how much, nor whether anybody had paid — so "can this car go out" ended
     at the gate checks and stopped short of the money.

     readInvoiceBalance is the ONE function that decides what an invoice has been
     paid: allocations rather than raw payments, minus processed refunds, minus
     issued credit notes. A second implementation here is how an invoice comes to
     read PAID on one screen and PARTIALLY PAID on another, so this calls it
     rather than adding up anything itself.

     Found by appointment OR by estimate: customer_invoices carries its own
     appointment_id, but rows created through the from-estimate path do not
     always have it, and a visit whose invoice is reachable only through the
     estimate is still that visit's invoice. */
  const { readInvoiceBalance } = require('../services/invoiceBalance.service');
  const ciIds = await pool.query(
    `SELECT DISTINCT ci.id
       FROM customer_invoices ci
       LEFT JOIN estimates e ON e.id = ci.estimate_id
      WHERE (ci.appointment_id = $1 OR e.appointment_id = $1)
        AND ci.status <> 'cancelled'
      ORDER BY ci.id`, [card.appointment_id]);

  const invoices = (await Promise.all(
    ciIds.rows.map(r => readInvoiceBalance(pool, r.id))
  )).filter(Boolean);

  /* Rounded on the way out, not accumulated raw: three invoices each a
     half-paisa off add up to a figure that does not match any of them. */
  const r2 = n => Number(Number(n || 0).toFixed(2));
  const billing = {
    invoice_count: invoices.length,
    billed:  r2(invoices.reduce((s, i) => s + Number(i.grand_total || 0), 0)),
    credited: r2(invoices.reduce((s, i) => s + Number(i.credited || 0), 0)),
    payable: r2(invoices.reduce((s, i) => s + Number(i.payable || 0), 0)),
    paid:    r2(invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0)),
    /* Summed from each invoice's own balance rather than payable − paid across
       the set: an overpayment on one invoice must not silently cancel out
       money still owed on another. */
    due:     r2(invoices.reduce((s, i) => s + Math.max(0, Number(i.balance || 0)), 0)),
  };

  /* ── Quoted, approved, declined, still waiting ───────────────────────────────
     Computed here rather than as four more subqueries: the rows are already
     loaded, and a FILTER aggregate that disagrees with the list printed beside
     it is a bug nobody can see. One source, one pass.

     Money is inc-GST throughout, because that is what a customer is quoted and
     what an invoice says. Mixing an ex-GST working figure into a panel labelled
     "Approved" would understate it by the GST rate and look like a discount. */
  const sum = rows => rows.reduce((s, l) => s + Number(l.total_inc_gst || 0), 0);
  const approvedLines = lines.rows.filter(l => l.customer_approved === true);
  const declinedLines = lines.rows.filter(l => l.customer_approved === false);
  const pendingLines  = lines.rows.filter(l => l.customer_approved === null);
  const money = {
    quoted:          sum(lines.rows),
    approved:        sum(approvedLines),
    declined:        sum(declinedLines),
    pending:         sum(pendingLines),
    line_count:      lines.rows.length,
    approved_count:  approvedLines.length,
    declined_count:  declinedLines.length,
    pending_count:   pendingLines.length,
  };

  /* Computed AFTER the rest, because the gates read some of the same tables
     and there is nothing to gain from racing them — and lazily required for
     the same cycle reason as setStatus. */
  const { computeGates } = require('./job_card_gates.controller');
  const gates = await computeGates(card, sections);

  /* Lazily required for the same cycle reason: job_card_parts.controller
     imports loadCard/handle from this file. */
  const { labourSummary } = require('./job_card_parts.controller');

  return {
    ...card,
    complaints:  complaints.rows,
    technicians: techs.rows,
    items:       items.rows,
    media:       media.rows,
    /* No `activities` array. The history moved off the card and into a paged
       drawer (GET /:id/activities) the moment it stopped being a section —
       shipping 200 rows with every load, to fill a panel most people never
       opened, was the largest thing in this payload. `activity_count` rides
       along on JC_SELECT for the badge, which is all the screen needs. */
    inspections: inspections.rows,
    signatures:  signatures.rows,
    damage:      damage.rows,
    gates,
    gate_pass:   gatePass.rows[0] || null,
    estimates:   estimates.rows,
    parts:       parts.rows,
    labour:      labour.rows,
    labour_summary: await labourSummary(card.id),
    /* What the customer agreed to on the phone. Read-only on the card: the job
       card is not where lines get priced or billed, and this panel exists so
       that the list the customer agreed to and the list being worked on can be
       compared by eye without opening the estimate. */
    /* The quoted lines for this visit and where the customer stands on each,
       so the authorisation decision can be taken on the card instead of on a
       different screen. */
    lines: lines.rows,
    money,
    /* The bill and what is left on it, read-only. Billing happens on the
       invoice screen; this is so the question does not have to be asked
       somewhere else. */
    invoices_billing: invoices.map(i => ({
      id: i.id, public_token: i.public_token, status: i.status,
      grand_total: Number(i.grand_total || 0),
      credited: Number(i.credited || 0),
      payable: Number(i.payable || 0),
      amount_paid: Number(i.amount_paid || 0),
      balance: Number(i.balance || 0),
    })),
    billing,
    /* Offered on an earlier visit and refused, and still not done. Kept as its
       own list rather than folded into `lines`: these belong to other visits,
       and a screen that mixed them with this visit's lines would invite someone
       to approve one — which would write a decision onto a closed estimate. */
    declined_before: declinedBefore,
    declined_before_total: declinedBefore.reduce((s, d) => s + Number(d.quoted_at || 0), 0),

    /* Each reading with the distance since the one before it, computed here so
       the screen does not have to hold the previous row while it renders — and
       so the card and any later report cannot disagree about a subtraction.

       `moved` is null for the first reading and for any reading with no
       odometer: a fuel-only reading is a real reading and its distance is not
       zero, it is unknown. `below_previous` marks a reading lower than the one
       before it — almost always a typo, never a reason to have refused the
       status change that carried it. */
    readings: (() => {
      let lastOdo = null;
      return readings.rows.map(r => {
        const odo = r.odometer === null || r.odometer === undefined ? null : Number(r.odometer);
        const moved = odo !== null && lastOdo !== null ? odo - lastOdo : null;
        if (odo !== null) lastOdo = odo;
        return { ...r, moved, below_previous: moved !== null && moved < 0 };
      });
    })(),
    booked_services: booked.rows,
    booked_summary: {
      count:       booked.rows.length,
      not_on_estimate: booked.rows.filter(b => !b.on_estimate).length,
      /* Inc-GST, because appointment_services.price is what the customer was
         quoted rather than an ex-GST working figure. */
      total:       booked.rows.reduce((s, b) => s + Number(b.booked_price || 0), 0),
    },
    sections,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards — open a card
// ─────────────────────────────────────────────────────────────────────────────
const openSchema = z.object({
  appointment_id:  z.coerce.number().int().positive(),
  odometer_in:     z.coerce.number().int().min(0).max(9999999).nullable().optional(),
  fuel_in:         z.coerce.number().int().min(0).max(4).nullable().optional(),
  service_package: z.string().trim().max(160).nullable().optional(),
  complaints:      z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
});

function openJobCard(req, res, next) {
  handle(req, res, next, async () => {
    const d = openSchema.parse(req.body);

    /* ── NOTHING THAT NEEDS A SECOND CONNECTION RUNS INSIDE THIS BLOCK ───────
       The pool is 10 wide with no acquire timeout (config/db.js), so a handler
       that holds a client and then awaits pool.query() for something else is
       not slow — it is a deadlock. Ten simultaneous opens take all ten clients,
       each then waits for an eleventh that can never exist, and the whole
       backend stops answering until it is restarted.

       So this block does the transaction and NOTHING else. The client is
       released before the status mirror, the activity log and the read-back —
       all of which want their own connection. Found by firing 23 opens at once
       against a real pool; it hung, exactly as production would have. */
    let card, appt, jobCardNo;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const apptRes = await client.query(
        `SELECT a.id, a.hub_id, a.odometer_km, a.appointment_code, a.vehicle_number,
                h.hub_code, vt.name AS vehicle_type_name
           FROM appointments a
           LEFT JOIN hubs h ON h.id = a.hub_id
           LEFT JOIN vehicle_types vt ON vt.id = a.vehicle_type_id
          WHERE a.id = $1`, [d.appointment_id]);
      appt = apptRes.rows[0];
      if (!appt) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Appointment not found' }); }
      assertHubOwns(req, appt, 'hub_id', 'Appointment');

      /* No hub, no number. The code is built from the hub code and frozen, so
         opening a card before the appointment is assigned would either invent a
         number under the wrong hub or leave a card that can never be numbered.
         Refusing is the only honest answer. */
      if (!appt.hub_id || !appt.hub_code) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Assign this appointment to a hub before opening a job card.' });
      }

      jobCardNo = await generateJobCardCode(client, { hubId: appt.hub_id, hubCode: appt.hub_code });

      /* odometer_in falls back to the reading already captured on the
         appointment (migration 088). Retyping a number the system has is how
         two different odometer readings for one visit come to exist. */
      const odoIn = d.odometer_in ?? appt.odometer_km ?? null;

      const ins = await client.query(
        `INSERT INTO job_cards
           (appointment_id, hub_id, job_card_no, status, odometer_in, fuel_in,
            service_package, opened_by)
         VALUES ($1, $2, $3, 'open', $4, $5, NULLIF($6,''), $7)
         RETURNING *`,
        [d.appointment_id, appt.hub_id, jobCardNo, odoIn, d.fuel_in ?? null,
         d.service_package ?? '', req.user?.id ?? null]
      );
      card = ins.rows[0];

      if (d.complaints?.length) {
        for (const [i, text] of d.complaints.entries()) {
          await client.query(
            `INSERT INTO job_card_complaints (job_card_id, complaint, sort_order)
             VALUES ($1, $2, $3)`, [card.id, text, i]);
        }
      }

      /* Which list depends on the vehicle. Matching on the type NAME because
         that is what the appointment carries; anything unrecognised gets the
         4W list, which is the superset — a wrong extra line marked 'na' is a
         smaller failure than a missing line nobody was asked about. */
      const isTwoWheeler = /2\s*w|two\s*wheel|bike|motor\s*cycle|scooter/i.test(appt.vehicle_type_name || '');
      const defaults = isTwoWheeler ? DEFAULT_ITEMS_2W : DEFAULT_ITEMS_4W;
      for (const [i, label] of defaults.entries()) {
        await client.query(
          `INSERT INTO job_card_items (job_card_id, label, state, sort_order)
           VALUES ($1, $2, 'na', $3)`, [card.id, label, i]);
      }

      await logJc(client, card.id, req.user?.id, 'opened', {
        newValue: 'open', note: `Job card ${jobCardNo} opened`,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();          // ← before anything below asks for a client
    }

    /* After the COMMIT and after the release, never inside either.
       advanceAppointmentStatus owns its own connection and fires WhatsApp
       automations; running it inside the transaction would send a message for
       a card that can still roll back, and running it before the release would
       be the deadlock described above. */
    await advanceAppointmentStatus(d.appointment_id, STATUS_MAP.open);

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'job_card', entityId: card.id,
      description: `Job card ${jobCardNo} opened for ${appt.appointment_code || `appointment #${appt.id}`} (${appt.vehicle_number || '—'})`,
    });

    const full = await pool.query(`${JC_SELECT} WHERE jc.id = $1`, [card.id]);
    return res.status(201).json({ item: await hydrate(full.rows[0], req) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/job-cards/:id — the header fields
// ─────────────────────────────────────────────────────────────────────────────
/* Status is NOT here. It has its own endpoint because changing it has
   consequences beyond this row — the appointment moves and a customer may get a
   message — and burying that inside a general "save the form" PATCH is how it
   ends up firing from an autosave nobody meant to trigger. */
const patchSchema = z.object({
  odometer_in:     z.coerce.number().int().min(0).max(9999999).nullable().optional(),
  odometer_out:    z.coerce.number().int().min(0).max(9999999).nullable().optional(),
  fuel_in:         z.coerce.number().int().min(0).max(4).nullable().optional(),
  fuel_out:        z.coerce.number().int().min(0).max(4).nullable().optional(),
  service_package: z.string().trim().max(160).nullable().optional(),
});

function updateJobCard(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = patchSchema.parse(req.body);
    const card = await loadCard(req, id);

    const fields = [], params = [];
    for (const k of ['odometer_in', 'odometer_out', 'fuel_in', 'fuel_out', 'service_package']) {
      if (d[k] === undefined) continue;
      params.push(d[k] === '' ? null : d[k]);
      fields.push(`${k} = $${params.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(id);
    const r = await pool.query(
      `UPDATE job_cards SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`, params);

    /* ── A hand-edited reading joins the trail too (migration 196) ───────────
       Otherwise the trail is complete only for cards nobody corrected, which is
       the opposite of what a trail is for: a figure somebody typed over is
       exactly the one that gets queried later.

       Marked `correction`, not `status_change` — it belongs to no transition,
       and dressing it as one would put a reading against a move that did not
       happen. One row per save rather than per field, because a person setting
       odometer and fuel together took ONE reading. */
    const odoKey  = d.odometer_out !== undefined ? 'odometer_out' : 'odometer_in';
    const fuelKey = d.fuel_out     !== undefined ? 'fuel_out'     : 'fuel_in';
    const newOdo  = d[odoKey]  === undefined || d[odoKey]  === '' ? null : d[odoKey];
    const newFuel = d[fuelKey] === undefined || d[fuelKey] === '' ? null : d[fuelKey];
    const odoMoved  = newOdo  !== null && String(card[odoKey]  ?? '') !== String(newOdo);
    const fuelMoved = newFuel !== null && String(card[fuelKey] ?? '') !== String(newFuel);
    if (odoMoved || fuelMoved) {
      await pool.query(
        `INSERT INTO job_card_readings
           (job_card_id, status_from, status_to, odometer, fuel, note,
            source, recorded_by)
         VALUES ($1, NULL, NULL, $2, $3, $4, 'correction', $5)`,
        [id, odoMoved ? newOdo : null, fuelMoved ? newFuel : null,
         `Entered by hand on the card (${[odoMoved && odoKey, fuelMoved && fuelKey]
           .filter(Boolean).join(', ')})`,
         req.user?.id ?? null]);
    }

    /* One timeline row per field that actually changed, not one per save. A
       save that changed nothing is not an event; and "odometer 41,200 → 41,380"
       is the line that settles whether the test drive happened. */
    for (const k of Object.keys(d)) {
      if (d[k] === undefined) continue;
      const before = card[k], after = r.rows[0][k];
      if (String(before ?? '') === String(after ?? '')) continue;
      await logJc(pool, id, req.user?.id, `field:${k}`, {
        oldValue: before === null || before === undefined ? null : String(before),
        newValue: after  === null || after  === undefined ? null : String(after),
      });
    }

    return res.json({ item: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/job-cards/:id/status
// ─────────────────────────────────────────────────────────────────────────────
const statusSchema = z.object({
  status:      z.enum(STATUSES),
  hold_reason: z.string().trim().max(500).nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
  /* Only a super admin can use this, and only to push past a red compliance
     gate. It is a separate field from `note` on purpose: a note is commentary,
     this is the record of a rule being set aside. */
  override_reason: z.string().trim().max(500).nullable().optional(),
  /* ── The reading taken as the car moves (migration 196) ───────────────────
     OPTIONAL, and that is the design, not a shortcut. The floor puts a card on
     hold at four in the afternoon with a customer waiting; a status change that
     refuses to happen until somebody walks out to the car and reads a dial is a
     status change that stops being recorded at all, and then the card lies
     about where the job is. A missing reading is a gap in the trail. A missing
     status change is a gap in the truth.

     Same units and the same bounds as the columns on job_cards. */
  odometer: z.coerce.number().int().min(0).max(9999999).nullable().optional(),
  fuel:     z.coerce.number().int().min(0).max(4).nullable().optional(),
});

function setStatus(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = statusSchema.parse(req.body);
    const card = await loadCard(req, id);

    if (card.status === d.status) return res.json({ item: card, changed: false });

    /* A hold with no reason is the state nobody can act on three days later.
       This is the one rule enforced in phase 3 because it costs nothing and
       the missing reason is unrecoverable — you cannot ask the floor in
       hindsight what the car was waiting for. */
    if (d.status === 'on_hold' && !(d.hold_reason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required to put a job card on hold.' });
    }

    /* ── THE COMPLIANCE GATES ────────────────────────────────────────────────
       Only `ready` and `delivered` are gated; everything else moves as freely
       as it did in phase 3, because the floor still has to put a card on hold
       at four in the afternoon without arguing with a checklist.

       Required lazily, not at the top of the file. job_card_gates imports
       loadCard and logJc from HERE, so a top-level require would be a cycle
       and one of the two modules would see a half-built exports object. */
    if (d.status === 'ready' || d.status === 'delivered') {
      const { checkTransition, readSections } = require('./job_card_gates.controller');
      const sections = await readSections(card.hub_id);
      const { ok, blockers } = await checkTransition(card, d.status, sections);

      if (!ok) {
        /* A super admin may push through, but only deliberately and only with
           a reason — a hub should not be left unpaid because one checklist row
           is stuck, and the person who decided that has to be findable
           afterwards. The reason goes on the timeline below. */
        const forcing = req.user?.is_super_admin && (d.override_reason || '').trim();
        if (!forcing) {
          return res.status(409).json({
            error: `This job card is not ready to move to ${d.status === 'ready' ? 'Ready' : 'Delivered'}.`,
            code: req.user?.is_super_admin ? 'GATES_BLOCKED_OVERRIDABLE' : 'GATES_BLOCKED',
            blockers,
          });
        }
        await logJc(pool, id, req.user?.id, 'gate:force', {
          newValue: d.status,
          note: `${d.override_reason.trim()} — forced past: ${blockers.map(b => b.label).join(', ')}`,
        });
        logActivity({
          userId: req.user?.id, userName: req.user?.name,
          action: 'UPDATE', entity: 'job_card', entityId: id,
          description: `${card.job_card_no} forced to ${d.status} past ${blockers.length} gate(s): ${d.override_reason.trim()}`,
        });
      }
    }

    const closing = d.status === 'closed' || d.status === 'cancelled';

    /* ── The status, the reading and the timeline commit together ────────────
       One transaction, because a reading that survives a failed status change
       is a reading against a transition that never happened — and the trail is
       only worth keeping if every row in it corresponds to something real.

       Pool discipline, as set out in config/db.js: NOTHING that needs a second
       connection runs between connect() and release(). advanceAppointmentStatus
       and logActivity both go to the pool, so both happen AFTER the release —
       the `released` flag shape from advances.service.js :: refundAdvance. */
    const hasReading = d.odometer !== undefined && d.odometer !== null
                    || d.fuel     !== undefined && d.fuel     !== null;
    /* Only at the end of the job. A mid-job reading writing odometer_out would
       let the gate pass default to it (`d.odometer_out ?? card.odometer_out`),
       and the pass demanding a FRESH reading at handover is an existing check
       this must not weaken. */
    const endOfJob = ['ready', 'delivered', 'closed'].includes(d.status);

    let row, reading = null, released = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const upd = await client.query(
        `UPDATE job_cards
            SET status      = $1,
                hold_reason = CASE WHEN $1 = 'on_hold' THEN $2 ELSE NULL END,
                closed_at   = CASE WHEN $3 THEN COALESCE(closed_at, NOW()) ELSE NULL END,
                /* The first reading fills IN if nothing has; a reading on the
                   way out of the workshop refreshes OUT. COALESCE on the
                   existing value either way, so a transition carrying no
                   reading changes neither. */
                odometer_in  = COALESCE(odometer_in,  $5),
                fuel_in      = COALESCE(fuel_in,      $6),
                odometer_out = CASE WHEN $7 THEN COALESCE($5, odometer_out) ELSE odometer_out END,
                fuel_out     = CASE WHEN $7 THEN COALESCE($6, fuel_out)     ELSE fuel_out     END,
                updated_at  = NOW()
          WHERE id = $4
          RETURNING *`,
        [d.status, d.hold_reason ?? null, closing, id,
         d.odometer ?? null, d.fuel ?? null, endOfJob]
      );
      row = upd.rows[0];

      if (hasReading) {
        const ins = await client.query(
          `INSERT INTO job_card_readings
             (job_card_id, status_from, status_to, odometer, fuel, note,
              source, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,'status_change',$7)
           RETURNING *`,
          [id, card.status, d.status, d.odometer ?? null, d.fuel ?? null,
           d.note || null, req.user?.id ?? null]);
        reading = ins.rows[0];
      }

      await logJc(client, id, req.user?.id, 'status', {
        oldValue: card.status, newValue: d.status,
        note: d.status === 'on_hold' ? (d.hold_reason || null) : (d.note || null),
      });

      await client.query('COMMIT');
      client.release(); released = true;
    } catch (err) {
      if (!released) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (!released) client.release();
    }

    const r = { rows: [row] };

    /* The mirror. Unmapped statuses (cancelled) leave the appointment alone —
       its own cancel flow owns that, and two writers for one transition is
       exactly what this whole design exists to avoid. */
    const slug = STATUS_MAP[d.status];
    if (slug) await advanceAppointmentStatus(card.appointment_id, slug);

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'UPDATE', entity: 'job_card', entityId: id,
      description: `Job card ${card.job_card_no} ${card.status} → ${d.status}`
        + (reading ? ` (odometer ${reading.odometer ?? '—'})` : ''),
    });

    return res.json({ item: r.rows[0], changed: true, reading });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Complaints and findings
// ─────────────────────────────────────────────────────────────────────────────
const complaintSchema = z.object({
  complaint:  z.string().trim().min(1).max(2000),
  finding:    z.string().trim().max(2000).nullable().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

function addComplaint(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = complaintSchema.parse(req.body);
    await loadCard(req, id);

    const next_ = await pool.query(
      `SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM job_card_complaints WHERE job_card_id = $1`, [id]);
    const r = await pool.query(
      `INSERT INTO job_card_complaints (job_card_id, complaint, finding, sort_order)
       VALUES ($1, $2, NULLIF($3,''), $4) RETURNING *`,
      [id, d.complaint, d.finding ?? '', d.sort_order ?? next_.rows[0].n]);

    await logJc(pool, id, req.user?.id, 'complaint:add', { newValue: d.complaint });
    return res.status(201).json({ item: r.rows[0] });
  });
}

function updateComplaint(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const cid = idParam.parse(req.params.complaintId);
    const d   = complaintSchema.partial().parse(req.body);
    await loadCard(req, id);

    const fields = [], params = [];
    for (const k of ['complaint', 'finding', 'sort_order']) {
      if (d[k] === undefined) continue;
      params.push(d[k] === '' ? null : d[k]);
      fields.push(`${k} = $${params.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    /* job_card_id in the WHERE, not just the id. Without it a complaint id from
       another card could be edited through a card this user does own. */
    params.push(cid, id);
    const r = await pool.query(
      `UPDATE job_card_complaints SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND job_card_id = $${params.length}
        RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Complaint not found' });

    if (d.finding !== undefined) {
      await logJc(pool, id, req.user?.id, 'finding', { newValue: d.finding || null, note: r.rows[0].complaint });
    }
    return res.json({ item: r.rows[0] });
  });
}

function deleteComplaint(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const cid = idParam.parse(req.params.complaintId);
    await loadCard(req, id);
    const r = await pool.query(
      `DELETE FROM job_card_complaints WHERE id = $1 AND job_card_id = $2 RETURNING complaint`, [cid, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    await logJc(pool, id, req.user?.id, 'complaint:remove', { oldValue: r.rows[0].complaint });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Technicians on the card
// ─────────────────────────────────────────────────────────────────────────────
const techSchema = z.object({
  technician_id: z.coerce.number().int().positive(),
  role:          z.string().trim().max(80).nullable().optional(),
  started_at:    z.coerce.date().nullable().optional(),
  ended_at:      z.coerce.date().nullable().optional(),
});

function addTechnician(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = techSchema.parse(req.body);
    const card = await loadCard(req, id);

    /* The technician must belong to the SAME hub as the card. Nothing in the
       schema enforces it — job_card_technicians references technicians(id) with
       no hub in sight — so it is enforced here, once, at the only door in. */
    const t = await pool.query(`SELECT id, name, hub_id FROM technicians WHERE id = $1`, [d.technician_id]);
    if (!t.rows[0] || Number(t.rows[0].hub_id) !== Number(card.hub_id)) {
      return res.status(400).json({ error: 'That technician does not work at this hub.' });
    }

    const r = await pool.query(
      `INSERT INTO job_card_technicians (job_card_id, technician_id, role, started_at, ended_at)
       VALUES ($1, $2, NULLIF($3,''), $4, $5) RETURNING *`,
      [id, d.technician_id, d.role ?? '', d.started_at ?? null, d.ended_at ?? null]);

    await logJc(pool, id, req.user?.id, 'technician:add', { newValue: t.rows[0].name, note: d.role || null });
    return res.status(201).json({ item: { ...r.rows[0], technician_name: t.rows[0].name } });
  });
}

function updateTechnicianRow(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const rid = idParam.parse(req.params.rowId);
    const d   = techSchema.partial().omit({ technician_id: true }).parse(req.body);
    await loadCard(req, id);

    const fields = [], params = [];
    for (const k of ['role', 'started_at', 'ended_at']) {
      if (d[k] === undefined) continue;
      params.push(d[k] === '' ? null : d[k]);
      fields.push(`${k} = $${params.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(rid, id);
    const r = await pool.query(
      `UPDATE job_card_technicians SET ${fields.join(', ')}
        WHERE id = $${params.length - 1} AND job_card_id = $${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    return res.json({ item: r.rows[0] });
  });
}

function removeTechnician(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const rid = idParam.parse(req.params.rowId);
    await loadCard(req, id);
    const r = await pool.query(
      `DELETE FROM job_card_technicians WHERE id = $1 AND job_card_id = $2
       RETURNING (SELECT name FROM technicians t WHERE t.id = technician_id) AS name`, [rid, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logJc(pool, id, req.user?.id, 'technician:remove', { oldValue: r.rows[0].name });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/job-cards/:id/items — the items-in-vehicle checklist
// ─────────────────────────────────────────────────────────────────────────────
/* A whole-list PUT rather than a PATCH per row. The floor ticks fifteen boxes
   in one pass on one screen; fifteen requests would give fifteen chances for
   half the answers to land. */
const itemsSchema = z.object({
  items: z.array(z.object({
    id:         z.coerce.number().int().positive().optional(),
    label:      z.string().trim().min(1).max(160),
    state:      z.enum(['present', 'absent', 'na']),
    note:       z.string().trim().max(500).nullable().optional(),
    sort_order: z.coerce.number().int().min(0).optional(),
  })).max(100),
});

function replaceItems(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = itemsSchema.parse(req.body);
    await loadCard(req, id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query(
        `SELECT label, state FROM job_card_items WHERE job_card_id = $1`, [id]);
      const wasAbsent = new Set(before.rows.filter(x => x.state === 'absent').map(x => x.label));

      await client.query(`DELETE FROM job_card_items WHERE job_card_id = $1`, [id]);
      for (const [i, it] of d.items.entries()) {
        await client.query(
          `INSERT INTO job_card_items (job_card_id, label, state, note, sort_order)
           VALUES ($1, $2, $3, NULLIF($4,''), $5)`,
          [id, it.label, it.state, it.note ?? '', it.sort_order ?? i]);
      }

      /* Only the absences go on the timeline. "Spare wheel marked absent" is
         the line that matters in a dispute; sixteen rows saying 'na' are not
         an event, they are a form being filled in. */
      const nowAbsent = d.items.filter(x => x.state === 'absent').map(x => x.label);
      for (const label of nowAbsent) {
        if (wasAbsent.has(label)) continue;
        await client.query(
          `INSERT INTO job_card_activities (job_card_id, type, new_value, created_by)
           VALUES ($1, 'item:absent', $2, $3)`, [id, label, req.user?.id ?? null]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const r = await pool.query(
      `SELECT * FROM job_card_items WHERE job_card_id = $1 ORDER BY sort_order, id`, [id]);
    return res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Media
// ─────────────────────────────────────────────────────────────────────────────
/* URLs only. Uploading goes through the ImageKit path the hub documents and
   workshop photos already use — a second upload mechanism for the same kind of
   file is a second set of credentials, limits and failure modes to maintain. */
const mediaSchema = z.object({
  url:       z.string().trim().url().max(1000),
  thumb_url: z.string().trim().url().max(1000).nullable().optional(),
  kind:      z.enum(['photo', 'video']).optional(),
  stage:     z.enum(['intake', 'during', 'delivery']).optional(),
  caption:   z.string().trim().max(300).nullable().optional(),
  /* Optional. When set, the photo hangs off one checklist point as well as
     off the card — "here is the worn pad" beside the line that says the pad
     is worn. It still appears in the card's photo list; the link is an extra
     place it shows, not a different place it lives. */
  inspection_result_id: z.coerce.number().int().positive().nullable().optional(),
});

function addMedia(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = mediaSchema.parse(req.body);
    await loadCard(req, id);

    /* The result must belong to THIS card. Without the join a result id from
       another hub's job card would attach a photo across the boundary — the
       same hole the complaint endpoints close with job_card_id in the WHERE. */
    if (d.inspection_result_id) {
      const owns = await pool.query(
        `SELECT 1 FROM job_card_inspection_results r
           JOIN job_card_inspections i ON i.id = r.inspection_id
          WHERE r.id = $1 AND i.job_card_id = $2`, [d.inspection_result_id, id]);
      if (!owns.rowCount) return res.status(404).json({ error: 'Checklist point not found on this job card.' });
    }

    const r = await pool.query(
      `INSERT INTO job_card_media
         (job_card_id, url, thumb_url, kind, stage, caption, uploaded_by, inspection_result_id)
       VALUES ($1, $2, NULLIF($3,''), $4, $5, NULLIF($6,''), $7, $8) RETURNING *`,
      [id, d.url, d.thumb_url ?? '', d.kind || 'photo', d.stage || 'intake',
       d.caption ?? '', req.user?.id ?? null, d.inspection_result_id ?? null]);
    await logJc(pool, id, req.user?.id, 'media:add', { newValue: d.stage || 'intake' });
    return res.status(201).json({ item: r.rows[0] });
  });
}

function deleteMedia(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const mid = idParam.parse(req.params.mediaId);
    await loadCard(req, id);
    const r = await pool.query(
      `DELETE FROM job_card_media WHERE id = $1 AND job_card_id = $2 RETURNING stage`, [mid, id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logJc(pool, id, req.user?.id, 'media:remove', { oldValue: r.rows[0].stage });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/:id/activities?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The card's history, a page at a time.
 *
 * ══ WHY IT LEFT THE CARD PAYLOAD ═══════════════════════════════════════════
 *
 * `hydrate` used to ship the newest 200 rows with every load of the card, to
 * fill a History panel sitting permanently in the right-hand column. On a card
 * that has been worked for a week that is the largest thing in the response,
 * fetched on every save, for a panel most people never look at.
 *
 * It is a drawer now, opened from one icon, so the rows are fetched when
 * somebody actually asks for them — and being paged, page 2 exists, which it
 * never did behind the old hard LIMIT 200. A card with 300 events used to lose
 * the oldest hundred silently, including the ones that say how it started.
 *
 * ══ NEWEST FIRST ═══════════════════════════════════════════════════════════
 *
 * Unchanged from the panel it replaces. Somebody opening the history wants to
 * know what just happened; the beginning is a page away and deliberately so.
 */
function listActivities(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    await loadCard(req, id);        // the one hub-ownership check, as everywhere

    const limit  = Math.min(Number(req.query.limit) || 25, 200);
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT ja.*, u.name AS created_by_name
           FROM job_card_activities ja
           LEFT JOIN users u ON u.id = ja.created_by
          WHERE ja.job_card_id = $1
          ORDER BY ja.created_at DESC, ja.id DESC
          LIMIT $2 OFFSET $3`, [id, limit, offset]),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_activities WHERE job_card_id = $1`, [id]),
    ]);

    return res.json({ items: rows.rows, total: count.rows[0].n, page, limit });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/notes — a free note on the timeline
// ─────────────────────────────────────────────────────────────────────────────
function addNote(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    await loadCard(req, id);
    await logJc(pool, id, req.user?.id, 'note', { note });
    const r = await pool.query(
      `SELECT ja.*, u.name AS created_by_name FROM job_card_activities ja
         LEFT JOIN users u ON u.id = ja.created_by
        WHERE ja.job_card_id = $1 ORDER BY ja.id DESC LIMIT 1`, [id]);
    return res.status(201).json({ item: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/job-cards/:id
// ─────────────────────────────────────────────────────────────────────────────
/* Deliberately narrow. A card that has been worked is the record of that work;
   deleting it deletes the only proof of what condition the vehicle arrived in.
   Only a card still sitting at `open` can go, which covers the real case —
   somebody opened one on the wrong appointment thirty seconds ago. Everything
   else is cancelled, not deleted, and stays readable. */
function deleteJobCard(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const card = await loadCard(req, id);
    if (card.status !== 'open') {
      return res.status(409).json({
        error: 'Only a job card still at Open can be deleted. Cancel this one instead.',
      });
    }
    await pool.query(`DELETE FROM job_cards WHERE id = $1`, [id]);
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'DELETE', entity: 'job_card', entityId: id,
      description: `Job card ${card.job_card_no} deleted (was still Open)`,
    });
    return res.json({ ok: true });
  });
}

module.exports = {
  STATUS_MAP, STATUSES,
  /* Shared with job_card_inspections.controller.js. Exported rather than
     copied: `loadCard` is the ONLY hub-ownership check on this whole module,
     and a second copy of it is a second place for that check to drift. */
  loadCard, logJc, handle, idParam,
  listJobCards, listJobCardCounts, getJobCard, getByAppointment, openJobCard, updateJobCard,
  setStatus, deleteJobCard,
  addComplaint, updateComplaint, deleteComplaint,
  addTechnician, updateTechnicianRow, removeTechnician,
  replaceItems, addMedia, deleteMedia, addNote, listActivities,
  getSettings, updateSettings,
};
