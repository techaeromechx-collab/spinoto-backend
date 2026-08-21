const { z } = require('zod');
const { fireWhatsAppEvent } = require('../services/whatsappAutomations.service');
const { pool } = require('../config/db');
const {
  fireHighPriorityAlert,
  fireDuplicateLeadAlert,
  fireLeadConversionAlert,
} = require('../services/smartAlerts.service');
const { logActivity }  = require('../services/activityLog.service');
const { sendPush }     = require('../utils/sendPush');
const { isNotificationEnabled } = require('../utils/notificationPrefs');
const { generatePublicToken, resolveTokenToId } = require('../utils/publicToken');

// ---------- validators ----------
const leadSchema = z.object({
  name: z.string().trim().max(160).optional().nullable(),
  mobile: z.string().trim().min(1).max(20),
  status: z.string().trim().max(100).optional().nullable(),
  whatsapp: z.string().trim().max(20).optional().nullable(),
  priority: z.enum(['normal','high','urgent','vip']).optional().default('normal'),
  tags: z.array(z.string().trim().max(50)).optional().default([]),
  state_id: z.coerce.number().int().positive().optional().nullable(),
  city_id: z.coerce.number().int().positive().optional().nullable(),
  area_id: z.coerce.number().int().positive().optional().nullable(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  make_id: z.coerce.number().int().positive().optional().nullable(),
  model_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id: z.coerce.number().int().positive().optional().nullable(),
  segment_ids: z.array(z.number().int()).optional().default([]),
  lead_source: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  assigned_to: z.coerce.number().int().positive().optional().nullable(),
  services: z.array(z.object({
    service_id: z.coerce.number().int().positive(),
    price: z.coerce.number().nonnegative(),
  })).optional().default([]),
  category_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
});

const lookupSchema = z.object({
  service_id:      z.coerce.number().int().positive(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id:    z.coerce.number().int().positive().optional().nullable(),
  segment_id:      z.coerce.number().int().positive().optional().nullable(),
  make_id:         z.coerce.number().int().positive().optional().nullable(),
  model_id:        z.coerce.number().int().positive().optional().nullable(),
  cc_category_id:  z.coerce.number().int().positive().optional().nullable(),
});

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      next(err);
    });
}

// =====================================================================
// LEAD CRUD
// =====================================================================

// Full SELECT fragment reused by list + get
/* ── The shared WhatsApp queue was HERE, and has been removed ────────────────

   An auto-created WhatsApp lead has created_by NULL — no user made it — and,
   until somebody is given it, assigned_to NULL too. Every scope filter below
   keys off exactly those two columns, so such a lead matches nothing and is
   visible only to Super Admin and VIEW_LEAD.

   A clause used to be concatenated into the two lower scopes making every
   unassigned WhatsApp lead visible to EVERY advisor — a shared queue anyone
   could pick from. That was the right design for an install where routing
   assigns automatically and the unassigned pile is a handful of leftovers.

   It is the wrong design here, and the reason is a deliberate operational
   choice rather than a technical one: this workshop does not want automatic
   assignment. Leads are handed out by a manager. So "unassigned" no longer
   means "nobody has got to it yet" — it means "not yet allocated", which is a
   manager's in-tray, not a free-for-all. Twenty advisors seeing and working
   the same untriaged lead is the failure this prevents.

   ── WHAT THIS COSTS, AND WHERE IT SHOWS ───────────────────────────────────

   Nothing assigns these leads on its own now. If nobody is watching, they
   accumulate unseen — invisible to the very people who would have worked them.
   That is the intended trade and it has a single point of failure: somebody
   has to look. Settings → WhatsApp → Routing can still name a fallback owner
   if that ever stops being true.

   The clause is deleted rather than switched off behind a flag. A flag here
   would be a second visibility rule to keep in step across four queries, and
   the one that drifts is always the one nobody tests. */

/* ── The last thing that happened to this lead ────────────────────────────────
   Two sources, because the timeline on the detail page has two: structured
   events in lead_activities (status changed, reassigned, converted) and free
   notes in lead_notes. Reading only the first would show "Status -> Junk" from
   Tuesday on a lead somebody wrote a note on this morning, which is worse than
   showing nothing - it looks current and is not.

   LATERAL with LIMIT 1 on each side: both tables are indexed on
   (lead_id, created_at) by migration 039, so this is two index seeks per row,
   not a scan.

   ── Why these are constants and not written out twice ───────────────────────

   They used to be inline in LEAD_SELECT only, and the list view - which is the
   ONLY place the Recent Activity column is rendered - had its own separate
   SELECT that never got them. So the column was fed by nothing: it appeared for
   a moment after a status change, because the PATCH response comes from
   LEAD_SELECT and the row is merged into the table in the browser, and it went
   blank again on the next refresh.

   Two SELECTs over the same table drifting apart is the kind of thing that is
   invisible in review and obvious to whoever uses the screen. One definition,
   used by both. */
const ACTIVITY_COLS = `
    act.type       AS last_activity_type,
    act.old_value  AS last_activity_old,
    act.new_value  AS last_activity_new,
    act.created_at AS last_activity_at,
    actor.name     AS last_activity_by`;

const ACTIVITY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT * FROM (
      (SELECT a2.type, a2.old_value, a2.new_value, a2.created_at, a2.created_by
         FROM lead_activities a2
        WHERE a2.lead_id = l.id
        ORDER BY a2.created_at DESC
        LIMIT 1)
      UNION ALL
      -- Trimmed here rather than in the browser: the column shows a few words,
      -- and shipping a 2,000-character note to render 40 of them is bandwidth
      -- spent on text nobody sees.
      (SELECT 'note_added', NULL, LEFT(n.note, 80), n.created_at, n.created_by
         FROM lead_notes n
        WHERE n.lead_id = l.id
        ORDER BY n.created_at DESC
        LIMIT 1)
    -- NOT aliased "both". That is a reserved word in Postgres (TRIM(BOTH ...))
    -- and the whole query then fails to parse with a syntax error pointing 3,000
    -- characters away from anything that looks related.
    --
    -- The inner alias is a2, not a: the list query already joins areas AS a, and
    -- reusing the letter inside the LATERAL is legal but reads as though the two
    -- are related.
    --
    -- No backticks in here either: this SQL lives in a JS template literal, and
    -- a backtick in a comment ends the literal several hundred lines early.
    ) recent
    ORDER BY recent.created_at DESC
    LIMIT 1
  ) act ON TRUE
  LEFT JOIN users actor ON actor.id = act.created_by`;

const LEAD_SELECT = `
  SELECT
    l.id, l.public_token, l.name, l.mobile, l.whatsapp, l.status, l.total_price,
    l.priority, l.tags,
    l.lead_source, l.lost_reason, l.notes, l.created_at, l.updated_at,
    s.name  AS state_name,  l.state_id,
    c.name  AS city_name,   l.city_id,
    a.name  AS area_name,   l.area_id,
    vt.name AS vehicle_type_name, l.vehicle_type_id,
    mk.name AS make_name,   l.make_id,
    md.name AS model_name,  l.model_id,
    bt.name AS body_type_name, l.body_type_id,
    l.segment_ids,
    (SELECT COALESCE(array_agg(sg.name ORDER BY sg.name), '{}')
       FROM segments sg WHERE sg.id = ANY(l.segment_ids)) AS segment_names,
    u.id    AS created_by_id,
    u.name  AS created_by_name,
${ACTIVITY_COLS},
    au.id   AS assigned_to_id,
    au.name AS assigned_to_name,
    l.assigned_to,
    EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id) AS is_converted,
    (SELECT le.due_date FROM lead_events le
      WHERE le.lead_id = l.id AND le.is_done = FALSE
      ORDER BY le.due_date ASC, le.due_at ASC NULLS LAST
      LIMIT 1
    ) AS next_follow_up_date,
    (SELECT le.due_at FROM lead_events le
      WHERE le.lead_id = l.id AND le.is_done = FALSE
      ORDER BY le.due_date ASC, le.due_at ASC NULLS LAST
      LIMIT 1
    ) AS next_follow_up_time
  FROM leads l
  LEFT JOIN states        s  ON s.id  = l.state_id
  LEFT JOIN cities        c  ON c.id  = l.city_id
  LEFT JOIN areas         a  ON a.id  = l.area_id
  LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
  LEFT JOIN vehicle_makes mk ON mk.id = l.make_id
  LEFT JOIN vehicle_models md ON md.id = l.model_id
  LEFT JOIN body_types    bt ON bt.id = l.body_type_id
  LEFT JOIN users         u  ON u.id  = l.created_by
  LEFT JOIN users         au ON au.id = l.assigned_to
${ACTIVITY_JOIN}
`;
/* ══ THE LEAD LIST ══════════════════════════════════════════════════════════
 *
 * ── WHY THIS IS PAGINATED ON THE SERVER ─────────────────────────────────────
 *
 * It used to return EVERY lead the caller could see, in one response, and the
 * browser did the filtering, the counting and the paging on the array it was
 * handed. At a few hundred leads that is the simpler design and it was the
 * right call. At four thousand it is six to ten megabytes of JSON on every
 * visit, every refresh, on a phone, for ten visible rows — and each row carries
 * nine joins and six correlated subqueries, so the database does roughly fifty
 * thousand index lookups to build a page nobody reads past.
 *
 * The cost scales exactly with the lead count, which is the number this CRM
 * exists to grow.
 *
 * ── WHAT THAT FORCES ────────────────────────────────────────────────────────
 *
 * Every filter has to move here too. A page of ten filtered in the browser is
 * ten rows filtered out of ten — the other 3,990 are not there to match. So the
 * fifteen filters the frontend was applying (search, status, assignee, creator,
 * dates, location, vehicle, source, and the chips) are all expressed below, and
 * the browser now sends its state rather than its opinion.
 *
 * ── AND THE COUNTS, WHICH ARE THE EASY THING TO GET WRONG ───────────────────
 *
 * The chips show numbers: "Follow-Up 47", "WhatsApp 900", "Unassigned 30".
 * Those come from the whole set, not from the page. Compute them from `items`
 * after paginating and every one of them silently becomes a number out of ten —
 * still rendered, still confident, completely wrong. So they are counted here,
 * in their own aggregates.
 *
 * The three count sets deliberately use DIFFERENT bases, mirroring exactly what
 * the browser used to do:
 *
 *   status    scope + the assignee filter. Picking an agent re-counts the
 *             statuses for that agent — that is the point of the combination.
 *   source    scope only. The source chips are a way IN to a filter; counting
 *             them through the current filter would show zeroes on every chip
 *             you have not already picked.
 *   assignee  scope only, same reasoning.
 *   value     scope + every filter. It describes the result, not the entry
 *             points.
 */

/** Small helper: push a value, get its placeholder. Keeps $n numbering honest
 *  across four queries that share a params array. */
function ph(params, value) {
  params.push(value);
  return `$${params.length}`;
}

/**
 * Who reports to this manager, plus themselves.
 *
 * Read ONCE per request and passed to scopeConditions, which is called four
 * times — once for the page and once per count base. Left inside
 * scopeConditions it was four identical round trips to build one answer that
 * cannot change between them.
 */
async function teamIdsFor(user) {
  const r = await pool.query(`SELECT id FROM users WHERE manager_id = $1`, [user.id]);
  return [...r.rows.map(x => x.id), user.id];
}

/**
 * teamIdsFor, but only when the answer will be used.
 *
 * A super admin and a VIEW_LEAD holder are not scoped at all, and an advisor
 * with VIEW_OWN_LEADS is scoped by their own id — neither needs the lookup, and
 * running it anyway is a query per request for a value that gets discarded.
 */
async function teamIdsIfNeeded(user) {
  if (user.is_super_admin || user.permissions.has('VIEW_LEAD')) return null;
  if (!user.permissions.has('VIEW_TEAM_LEADS')) return null;
  return teamIdsFor(user);
}

/** Which leads this user may see at all. Pushes into `params`. */
function scopeConditions(user, teamIds, params) {
  if (user.is_super_admin || user.permissions.has('VIEW_LEAD')) return [];

  if (teamIds) return [`(l.created_by = ANY(${ph(params, teamIds)}))`];

  // VIEW_OWN_LEADS — created by them OR given to them. The second half is what
  // makes handing somebody a lead work at all.
  const me = ph(params, user.id);
  return [`(l.created_by = ${me} OR l.assigned_to = ${me})`];
}

/* The source chips, as SQL.
   Grouped rather than matched exactly, because lead_source is free text
   (VARCHAR(80), no FK) with years of values in it. 'Manual' is not a stored
   value at all — it is the ABSENCE of a campaign source, which is what a lead
   typed in by an advisor looks like. */
const META_SOURCES   = "'meta ads','meta','facebook','instagram','facebook ads','instagram ads','social media'";
const MANUAL_SOURCES = "'manual','walk-in','walk in','phone call','referral'";
const SRC = "LOWER(TRIM(COALESCE(l.lead_source,'')))";

function sourceChipSql(key) {
  switch (key) {
    case 'whatsapp': return `${SRC} = 'whatsapp'`;
    case 'website':  return `${SRC} = 'website'`;
    case 'meta ads': case 'meta_ads': case 'meta':
      return `${SRC} IN (${META_SOURCES})`;
    // The absence of a source is a manual lead. Written as a real condition so
    // the chip and its count cannot disagree.
    case 'manual':   return `(${SRC} = '' OR ${SRC} IN (${MANUAL_SOURCES}))`;
    // Defined as the complement, so a source nobody thought of still appears
    // SOMEWHERE instead of being invisible in every filter.
    case 'other':    return `(${SRC} <> '' AND ${SRC} NOT IN ('whatsapp','website',${META_SOURCES},${MANUAL_SOURCES}))`;
    default:         return null;
  }
}

/** Everything the user has typed or clicked, as SQL. */
function filterConditions(q, params) {
  const c = [];

  const search = (q.search || '').trim();
  if (search) {
    const s = ph(params, `%${search.toLowerCase()}%`);
    c.push(`(LOWER(COALESCE(l.name,'')) LIKE ${s} OR l.mobile LIKE ${s})`);
  }

  /* Statuses arrive as a comma-separated list because the chips are
     multi-select. '__new__' is not a status — it is the ABSENCE of one, which
     is what "New Lead" means in this schema, so it cannot be matched by name
     and has to be its own branch. */
  const statuses = String(q.status || '').split(',').map(s => s.trim()).filter(Boolean);
  if (statuses.length) {
    const wantsNew = statuses.includes('__new__');
    const named = statuses.filter(s => s !== '__new__');
    const parts = [];
    if (wantsNew) parts.push(`(l.status IS NULL OR TRIM(l.status) = '')`);
    if (named.length) parts.push(`l.status = ANY(${ph(params, named)})`);
    c.push(`(${parts.join(' OR ')})`);
  }

  // Same shape for assignees, and 'unassigned' is the same kind of exception.
  const assignees = String(q.assignee || '').split(',').map(s => s.trim()).filter(Boolean);
  if (assignees.length) {
    const wantsNone = assignees.includes('unassigned');
    const ids = assignees.filter(s => s !== 'unassigned').map(Number).filter(Number.isInteger);
    const parts = [];
    if (wantsNone) parts.push('l.assigned_to IS NULL');
    if (ids.length) parts.push(`l.assigned_to = ANY(${ph(params, ids)})`);
    if (parts.length) c.push(`(${parts.join(' OR ')})`);
  }

  if (q.creator) c.push(`l.created_by = ${ph(params, Number(q.creator))}`);

  /* Dates are compared in the SERVER's timezone via ::date, matching what the
     browser did with new Date(dateFrom + 'T00:00:00') — local midnight, not
     UTC. Comparing a timestamptz against a bare date would shift every
     boundary by the offset and quietly drop the first or last day. */
  if (q.date_from) c.push(`l.created_at::date >= ${ph(params, q.date_from)}::date`);
  if (q.date_to)   c.push(`l.created_at::date <= ${ph(params, q.date_to)}::date`);

  for (const [key, col] of [
    ['state', 'state_id'], ['city', 'city_id'], ['area', 'area_id'],
    ['vehicle_type', 'vehicle_type_id'], ['make', 'make_id'], ['model', 'model_id'],
  ]) {
    if (q[key]) c.push(`l.${col} = ${ph(params, Number(q[key]))}`);
  }

  // The exact-source dropdown, which is separate from the chips above it.
  if (q.source_exact) c.push(`l.lead_source = ${ph(params, q.source_exact)}`);

  const chip = String(q.source || '').trim().toLowerCase();
  if (chip && chip !== 'all') {
    const sql = sourceChipSql(chip);
    // An unrecognised value is treated as an exact source name, so the filter
    // keeps working if one is added to lead_sources without touching this.
    c.push(sql || `${SRC} = ${ph(params, chip)}`);
  }

  /* The owner chips. 'mine' needs the caller's id, which is why this takes the
     user — the browser used to compare against currentUser.id in JavaScript. */
  const owner = String(q.owner || '').trim().toLowerCase();
  if (owner === 'unassigned') c.push('l.assigned_to IS NULL');
  else if (owner === 'mine')  c.push(`l.assigned_to = ${ph(params, q._userId)}`);

  return c;
}

/* Sortable columns, as an allowlist.
   An ORDER BY built from a query parameter is an injection whatever escaping
   is applied around it, because it is an identifier rather than a value. The
   map is the validation. */
const SORTABLE = {
  created_at: 'l.created_at',
  updated_at: 'l.updated_at',
  name:       'l.name',
  status:     'l.status',
  value:      'l.total_price',
};

function listLeads(req, res, next) {
  handle(req, res, next, async () => {
    const user = req.user;
    const q    = { ...req.query, _userId: user.id };

    /* Ten by default, matching the pager's own first option, and capped.
       Uncapped, `?page_size=99999` is the un-paginated endpoint again — with
       the added insult that the browser asked for it. */
    const pageSize = Math.min(Math.max(parseInt(q.page_size, 10) || 10, 1), 200);
    const page     = Math.max(parseInt(q.page, 10) || 1, 1);
    const offset   = (page - 1) * pageSize;

    const sortCol = SORTABLE[String(q.sort || 'created_at')] || SORTABLE.created_at;
    const sortDir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const teamIds = await teamIdsIfNeeded(user);

    // ── The page itself ────────────────────────────────────────────────────
    const params  = [];
    const scope   = scopeConditions(user, teamIds, params);
    const filters = filterConditions(q, params);
    const all     = [...scope, ...filters];
    const where   = all.length ? `WHERE ${all.join(' AND ')}` : '';

    /* Snapshotted BEFORE the limit and offset are pushed, so the count query
       can reuse the identical WHERE with the identical params.
       The alternative — slicing two off the end afterwards — works and breaks
       silently the day somebody adds a third parameter below. */
    const whereParams = [...params];

    // Separate SELECT for list view — adds service/category subqueries in SELECT clause
    const LIST_SELECT = `
      SELECT
        l.id, l.public_token, l.name, l.mobile, l.whatsapp, l.status, l.total_price,
        l.priority, l.tags,
        l.lead_source, l.lost_reason, l.notes, l.created_at, l.updated_at,
        s.name  AS state_name,  l.state_id,
        c.name  AS city_name,   l.city_id,
        a.name  AS area_name,   l.area_id,
        vt.name AS vehicle_type_name, l.vehicle_type_id,
        mk.name AS make_name,   l.make_id,
        md.name AS model_name,  l.model_id,
        bt.name AS body_type_name, l.body_type_id,
        l.segment_ids,
        u.id    AS created_by_id,
        u.name  AS created_by_name,
        au.id   AS assigned_to_id,
        au.name AS assigned_to_name,
        l.assigned_to,
        (SELECT sc.name FROM lead_services ls
          JOIN services sv ON sv.id = ls.service_id
          JOIN service_categories sc ON sc.id = sv.category_id
          WHERE ls.lead_id = l.id ORDER BY ls.id LIMIT 1
        ) AS first_category_name,
        (SELECT sv.name FROM lead_services ls
          JOIN services sv ON sv.id = ls.service_id
          WHERE ls.lead_id = l.id ORDER BY ls.id LIMIT 1
        ) AS first_service_name,
        (SELECT COUNT(*)::int FROM lead_services ls WHERE ls.lead_id = l.id
        ) AS service_count,
        (SELECT sc.name FROM lead_categories lc
          JOIN service_categories sc ON sc.id = lc.category_id
          WHERE lc.lead_id = l.id ORDER BY lc.id LIMIT 1
        ) AS first_cat_interest_name,
        EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id) AS is_converted,
        (SELECT le.due_date FROM lead_events le
          WHERE le.lead_id = l.id AND le.is_done = FALSE
          ORDER BY le.due_date ASC, le.due_at ASC NULLS LAST
          LIMIT 1
        ) AS next_follow_up_date,
        (SELECT le.due_at FROM lead_events le
          WHERE le.lead_id = l.id AND le.is_done = FALSE
          ORDER BY le.due_date ASC, le.due_at ASC NULLS LAST
          LIMIT 1
        ) AS next_follow_up_time,${ACTIVITY_COLS}
      FROM leads l
      LEFT JOIN states        s  ON s.id  = l.state_id
      LEFT JOIN cities        c  ON c.id  = l.city_id
      LEFT JOIN areas         a  ON a.id  = l.area_id
      LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
      LEFT JOIN vehicle_makes mk ON mk.id = l.make_id
      LEFT JOIN vehicle_models md ON md.id = l.model_id
      LEFT JOIN body_types    bt ON bt.id = l.body_type_id
      LEFT JOIN users         u  ON u.id  = l.created_by
      LEFT JOIN users         au ON au.id = l.assigned_to${ACTIVITY_JOIN}
    `;
    /* NULLS LAST on both directions so a lead with no name or no value sinks
       rather than heading the list. Postgres defaults NULLs first on DESC,
       which puts every unnamed lead at the top of a name sort. */
    const items = await pool.query(
      `${LIST_SELECT} ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST, l.id ${sortDir}
        LIMIT ${ph(params, pageSize)} OFFSET ${ph(params, offset)}`,
      params
    );

    /* ── The numbers ───────────────────────────────────────────────────────
       Four aggregates, three different bases — see the header. Run together:
       they are independent, and serialising them would make the page wait for
       the sum of four round trips instead of the slowest one.

       Each rebuilds its own params array. Sharing one would mean four queries
       agreeing on $n ordering, which is the kind of coupling that breaks the
       moment somebody adds a filter to one of them. */
    const cParams    = [];
    const countScope = scopeConditions(user, teamIds, cParams);

    // status: scope + the assignee filter only
    const sParams = [...cParams];
    const sWhere  = [...countScope,
                     ...filterConditions({ assignee: q.assignee, _userId: user.id }, sParams)];

    // owner chips: scope + the source chip only
    const oParams = [];
    const oWhere  = scopeConditions(user, teamIds, oParams);
    {
      const chip = String(q.source || '').trim().toLowerCase();
      if (chip && chip !== 'all') {
        const sql = sourceChipSql(chip);
        oWhere.push(sql || `${SRC} = ${ph(oParams, chip)}`);
      }
    }

    // value: scope + everything
    const vParams = [];
    const vAll    = [...scopeConditions(user, teamIds, vParams), ...filterConditions(q, vParams)];

    const [total, statusCounts, sourceCounts, assigneeCounts, ownerCounts, value] = await Promise.all([
      // No joins: every condition above references l.* only, so counting does
      // not need the nine LEFT JOINs the page itself carries.
      pool.query(`SELECT COUNT(*)::int AS n FROM leads l ${where}`, whereParams),

      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(l.status), ''), '__new__') AS k, COUNT(*)::int AS n
           FROM leads l ${sWhere.length ? `WHERE ${sWhere.join(' AND ')}` : ''}
          GROUP BY 1`, sParams),

      pool.query(
        `SELECT COUNT(*)::int AS all_n,
                COUNT(*) FILTER (WHERE ${sourceChipSql('whatsapp')})::int AS whatsapp,
                COUNT(*) FILTER (WHERE ${sourceChipSql('website')})::int  AS website,
                COUNT(*) FILTER (WHERE ${sourceChipSql('meta ads')})::int AS meta,
                COUNT(*) FILTER (WHERE ${sourceChipSql('manual')})::int   AS manual,
                COUNT(*) FILTER (WHERE ${sourceChipSql('other')})::int    AS other
           FROM leads l ${countScope.length ? `WHERE ${countScope.join(' AND ')}` : ''}`, cParams),

      /* The assignee dropdown's LIST, not just its numbers.
         It used to be derived in the browser from the leads it had — fine when
         that was every lead, useless when it is ten: the dropdown would offer
         whoever happened to appear on page one and hide the rest, so filtering
         by an agent became impossible the moment they had no recent lead.
         Names come from the join because an id is not something to show. */
      pool.query(
        `SELECT COALESCE(l.assigned_to::text, 'unassigned') AS k,
                COUNT(*)::int AS n,
                MAX(u.name) AS name
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
          ${countScope.length ? `WHERE ${countScope.join(' AND ')}` : ''}
          GROUP BY 1`, cParams),

      /* The owner chips, counted THROUGH the source chip.
         Everyone / Mine / Unassigned sit beside the source strip and combine
         with it rather than replacing it — WhatsApp + Unassigned is a real
         view somebody opens at the start of a shift. So the number on
         Unassigned has to be the number you would get if you pressed it, not a
         global total that changes the moment you do.
         Only the source chip is applied, not the rest of the filters: these
         are entry points, same as the source counts above. */
      pool.query(
        `SELECT COUNT(*)::int AS all_n,
                COUNT(*) FILTER (WHERE l.assigned_to IS NULL)::int AS unassigned,
                COUNT(*) FILTER (WHERE l.assigned_to = ${ph(oParams, user.id)})::int AS mine
           FROM leads l ${oWhere.length ? `WHERE ${oWhere.join(' AND ')}` : ''}`, oParams),

      pool.query(
        `SELECT COALESCE(SUM(l.total_price), 0)::float AS v
           FROM leads l ${vAll.length ? `WHERE ${vAll.join(' AND ')}` : ''}`, vParams),
    ]);

    const asMap = (rows) => rows.reduce((acc, r) => { acc[r.k] = r.n; return acc; }, {});
    const sc = sourceCounts.rows[0] || {};

    res.json({
      items: items.rows,
      total: total.rows[0].n,
      page,
      page_size: pageSize,
      // Tell the frontend what scope was applied so it can show the right heading
      scope: user.is_super_admin || user.permissions.has('VIEW_LEAD') ? 'all'
           : user.permissions.has('VIEW_TEAM_LEADS') ? 'team' : 'own',
      /* Everyone who currently holds a lead, with how many — the dropdown's
         options and its counts in one list, so the two cannot disagree. */
      assignees: assigneeCounts.rows
        .filter(r => r.k !== 'unassigned')
        .map(r => ({ id: r.k, name: r.name || `#${r.k}`, count: r.n }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      counts: {
        status:   asMap(statusCounts.rows),
        assignee: asMap(assigneeCounts.rows),
        owner: {
          all:        ownerCounts.rows[0]?.all_n || 0,
          mine:       ownerCounts.rows[0]?.mine || 0,
          unassigned: ownerCounts.rows[0]?.unassigned || 0,
        },
        source: {
          all: sc.all_n || 0, whatsapp: sc.whatsapp || 0, website: sc.website || 0,
          'meta ads': sc.meta || 0, manual: sc.manual || 0, other: sc.other || 0,
        },
      },
      total_value: value.rows[0].v,
    });
  });
}

function getLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const user = req.user;

    // Build the same ownership scope used by listLeads
    let whereClause = 'WHERE l.id = $1';
    const params = [id];

    /* The same helper the list uses, rather than a fourth copy of the rule.
       There were three copies and they had already drifted — one built its team
       array as [self, ...team] and another as [...team, self], which is
       harmless and is exactly how the difference that is NOT harmless gets in
       unnoticed. */
    const scope = scopeConditions(user, await teamIdsIfNeeded(user), params);
    if (scope.length) whereClause += ` AND ${scope.join(' AND ')}`;

    const leadRow = await pool.query(`${LEAD_SELECT} ${whereClause}`, params);
    if (!leadRow.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    // Fetch services for this lead
    const svcRows = await pool.query(
      `SELECT ls.id, ls.service_id, ls.price, sv.name AS service_name, sc.name AS category_name
       FROM lead_services ls
       JOIN services sv ON sv.id = ls.service_id
       JOIN service_categories sc ON sc.id = sv.category_id
       WHERE ls.lead_id = $1
       ORDER BY sc.name, sv.name`,
      [id]
    );

    // Fetch category-level interests for this lead
    const catRows = await pool.query(
      `SELECT lc.id, lc.category_id, sc.name AS category_name
       FROM lead_categories lc
       JOIN service_categories sc ON sc.id = lc.category_id
       WHERE lc.lead_id = $1
       ORDER BY sc.name`,
      [id]
    );

    const lead = leadRow.rows[0];

    // Compute vehicle_in_master (4W) and cc_missing (2W):
    // If the lead has make + model set, check Vehicle Master for completeness.
    // 4W → needs body_type_id on lead (auto-fetched from vehicle_models during import).
    // 2W → needs cc_category_id on the vehicle_models row (not stored on lead, so query live).
    let vehicle_in_master = null;
    let cc_missing = null;

    let engine_cc       = null;
    let cc_category_name = null;

    if (lead.make_id && lead.model_id) {
      const vtName = (lead.vehicle_type_name || '').toLowerCase();
      const is2W   = vtName === '2w' || vtName.includes('two') || vtName.includes('2w') || vtName.includes('2-w');

      if (is2W) {
        // 2W: fetch engine_cc + cc_category name for display, and check completeness
        const vmRow = await pool.query(
          `SELECT vm.engine_cc, vm.cc_category_id, cc.name AS cc_category_name
           FROM vehicle_models vm
           LEFT JOIN cc_categories cc ON cc.id = vm.cc_category_id
           WHERE vm.id = $1`,
          [lead.model_id]
        );
        if (vmRow.rows[0]) {
          engine_cc        = vmRow.rows[0].engine_cc        || null;
          cc_category_name = vmRow.rows[0].cc_category_name || null;
          cc_missing       = vmRow.rows[0].cc_category_id   === null;
        }
        // body_type / vehicle_in_master not relevant for 2W
      } else {
        // 4W (or unknown type): check body_type stored on the lead
        vehicle_in_master = lead.body_type_id !== null;
      }
    }

    res.json({ item: { ...lead, vehicle_in_master, cc_missing, engine_cc, cc_category_name, services: svcRows.rows, categories: catRows.rows } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leads/by-token/:token — resolves a public_token (used in
// shareable /leads/:token URLs) to the underlying numeric id, then
// delegates to the exact same logic as GET /api/leads/:id. Kept as a thin
// wrapper rather than a refactor of getLead's internals, so the existing,
// already-working permission-scoped SELECT logic is untouched.
// ─────────────────────────────────────────────────────────────────────────────
function getLeadByToken(req, res, next) {
  handle(req, res, next, async () => {
    const id = await resolveTokenToId(pool, 'leads', req.params.token);
    if (!id) return res.status(404).json({ error: 'Lead not found' });
    req.params.id = String(id);
    return getLead(req, res, next);
  });
}

function updateLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const updateSchema = z.object({
      status:          z.string().trim().min(1).max(100).optional(),
      lost_reason:     z.string().trim().max(120).optional().nullable(),
      notes:           z.string().trim().optional().nullable(),
      name:            z.string().trim().max(160).optional().nullable(),
      mobile:          z.string().trim().min(1).max(20).optional(),
      whatsapp:        z.string().trim().max(20).optional().nullable(),
      lead_source:     z.string().trim().max(80).optional().nullable(),
      state_id:        z.coerce.number().int().positive().optional().nullable(),
      city_id:         z.coerce.number().int().positive().optional().nullable(),
      area_id:         z.coerce.number().int().positive().optional().nullable(),
      vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
      make_id:         z.coerce.number().int().positive().optional().nullable(),
      model_id:        z.coerce.number().int().positive().optional().nullable(),
      body_type_id:    z.coerce.number().int().positive().optional().nullable(),
      cc_category_id:  z.coerce.number().int().positive().optional().nullable(),
      segment_ids:     z.array(z.number().int()).optional(),
      assigned_to:     z.coerce.number().int().positive().optional().nullable(),
      priority:        z.enum(['normal','high','urgent','vip']).optional(),
      tags:            z.array(z.string().trim().max(50)).optional(),
      services:        z.array(z.object({
        service_id: z.coerce.number().int().positive(),
        price:      z.coerce.number().nonnegative(),
      })).optional(),
      category_ids: z.array(z.coerce.number().int().positive()).optional(),
    });
    const data = updateSchema.parse(req.body);
    // cc_category_id is not a column on the leads table — exclude it
    const { services, cc_category_id: _cc, category_ids, ...coreData } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Capture current status + assigned_to BEFORE update so we can detect changes after commit
      const prevLeadRow = await client.query(
        `SELECT l.assigned_to, l.status, l.name, l.mobile,
                u.name AS assigned_to_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
         WHERE l.id = $1`, [id]
      );
      const prevLead = prevLeadRow.rows[0];

      // Block assigned_to changes once lead is converted to an appointment
      if ('assigned_to' in coreData) {
        const convCheck = await client.query(
          `SELECT 1 FROM appointments WHERE lead_id = $1 LIMIT 1`, [id]
        );
        if (convCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot reassign a lead that has already been converted to an appointment.' });
        }
      }

      /* ── A status that needs a follow-up must arrive with one ─────────────
         needs_follow_up was enforced only in the browser: StatusActionModal
         refuses to confirm without a date. The API never checked, so any other
         caller could move a lead INTO a chase status while the auto-close below
         shut the previous follow-up — leaving the lead in "Attempt 2" with
         nothing scheduled, and invisible, because the Follow-up list is built
         from open lead_events rows. The one place it would eventually surface
         is a compliance report, as a lead nobody ever followed up.

         Only on the TRANSITION. Saving a note on a lead already sitting in
         Attempt 2 must not demand a date it does not have.

         This cannot break the UI: the modal already blocks the same case, so
         every request the frontend sends today carries the date. It also cannot
         break an import — import.controller.js writes leads.status directly and
         never comes through here, which is right: loading history is not the
         same act as working a lead. */
      if (coreData.status && coreData.status !== prevLead?.status && !req.body.follow_up_date) {
        const nf = await client.query(
          `SELECT name FROM lead_statuses
            WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND needs_follow_up = TRUE
            LIMIT 1`,
          [coreData.status]
        );
        if (nf.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: `"${nf.rows[0].name}" needs a follow-up date. Send follow_up_date (YYYY-MM-DD) with the status change.`,
            code: 'FOLLOW_UP_REQUIRED',
            status: nf.rows[0].name,
          });
        }
      }

      // Update core lead fields if any provided
      const fields = [];
      const params = [];
      for (const [key, val] of Object.entries(coreData)) {
        params.push(val);
        fields.push(`${key} = $${params.length}`);
      }

      // Replace services if provided
      let prevServices = [];
      if (services !== undefined) {
        // Capture old services BEFORE deleting so we can log what changed
        const prevSvcRes = await client.query(
          `SELECT s.id, s.name FROM lead_services ls
           JOIN services s ON s.id = ls.service_id
           WHERE ls.lead_id = $1`, [id]
        );
        prevServices = prevSvcRes.rows;

        await client.query('DELETE FROM lead_services WHERE lead_id = $1', [id]);
        for (const s of services) {
          await client.query(
            'INSERT INTO lead_services (lead_id, service_id, price) VALUES ($1, $2, $3)',
            [id, s.service_id, s.price]
          );
        }
        const totalPrice = services.reduce((sum, s) => sum + s.price, 0);
        params.push(totalPrice);
        fields.push(`total_price = $${params.length}`);
      }

      // Replace category-level interests if provided
      if (category_ids !== undefined) {
        await client.query('DELETE FROM lead_categories WHERE lead_id = $1', [id]);
        for (const catId of category_ids) {
          await client.query(
            'INSERT INTO lead_categories (lead_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, catId]
          );
        }
      }

      if (fields.length) {
        params.push(id);
        const r = await client.query(
          `UPDATE leads SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
          params
        );
        if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lead not found' }); }
      }

      // ── Schedule a follow-up event if the frontend provided a date ──────────
      // (The old auto-timing via follow_up_days/follow_up_hours has been replaced
      //  by the manual follow-up modal on the frontend.)
      if (req.body.follow_up_date) {
        /* Close any existing open follow-ups for this lead.
           auto_closed = TRUE: this is the follow-up being REPLACED by the one
           about to be inserted, not one anybody completed. Counting it as
           completed would credit the advisor for a call they are, in this very
           request, rescheduling. */
        await client.query(
          `UPDATE lead_events SET is_done = TRUE, done_at = NOW(), auto_closed = TRUE
           WHERE lead_id = $1 AND is_done = FALSE`,
          [id]
        );

        // Build due_at from the provided date + optional time
        const dateStr = req.body.follow_up_date;                         // 'YYYY-MM-DD'
        const timeStr = req.body.follow_up_time || '09:00';              // 'HH:MM'
        const dueAt   = new Date(`${dateStr}T${timeStr}:00`);

        await client.query(
          `INSERT INTO lead_events (lead_id, status_name, due_date, due_at, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, coreData.status, dateStr, dueAt.toISOString(), req.body.follow_up_note || 'Follow-up scheduled']
        );

        // Notify the lead's creator, assigned agent, and the person who scheduled it.
        // Use client (inside transaction) so we read the already-updated assigned_to.
        const leadRow = await client.query(
          `SELECT created_by, assigned_to, name, mobile FROM leads WHERE id = $1`, [id]
        );
        const leadMeta   = leadRow.rows[0];
        const leadLabel  = leadMeta?.name || leadMeta?.mobile || `Lead #${id}`;
        const notifyUsers = [...new Set(
          [leadMeta?.created_by, leadMeta?.assigned_to, req.user.id].filter(Boolean)
        )];
        for (const uid of notifyUsers) {
          if (await isNotificationEnabled(client, uid, 'follow_up_scheduled')) {
            await client.query(
              `INSERT INTO notifications (user_id, type, title, body, lead_id)
               VALUES ($1, 'follow_up_scheduled', $2, $3, $4)`,
              [uid, `Follow-up scheduled`, `Follow up for "${leadLabel}" on ${dateStr} at ${timeStr}`, id]
            );
          }
          sendPush(uid, 'follow_up_scheduled', `Follow-up Scheduled`, `Follow up for "${leadLabel}" on ${dateStr} at ${timeStr}`, '/leads');
        }
      }

      // ── Auto-close open follow-ups on ANY status change ──────────────────
      // If status changed and no new follow-up was scheduled in the same request,
      // mark all pending events as done automatically.
      if (coreData.status && coreData.status !== prevLead?.status && !req.body.follow_up_date) {
        await client.query(
          `UPDATE lead_events SET is_done = TRUE, done_at = NOW(), auto_closed = TRUE
           WHERE lead_id = $1 AND is_done = FALSE`,
          [id]
        );
      }

      // ── Log status change to activity timeline ─────────────────────────
      if (coreData.status && coreData.status !== prevLead?.status) {
        const actNote = coreData.lost_reason ? `Lost reason: ${coreData.lost_reason}` : null;
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [id, prevLead?.status || null, coreData.status, actNote, req.user.id]
        );

        // ── WhatsApp on lead status change ───────────────────────────────
        //
        // Inside this `if`, so it fires on the TRANSITION only — saving a lead
        // without touching its status must not re-message the customer.
        //
        // Matched on the status NAME, because leads.status stores a name rather
        // than an id. Which template (if any) is configured for which status
        // lives in Settings → WhatsApp, so changing when a customer hears from
        // you needs no deploy.
        //
        // On the caller's transaction: the message and the status change commit
        // together. fireWhatsAppEvent savepoints all of its work and never
        // throws, so nothing here can stop the lead being saved.
        //
        // Since migration 151 the lookup is wa_automations
        // (event 'lead.status_changed', match_value = status name) rather than
        // the deprecated trigger_lead_status column — managed in
        // Settings → WhatsApp → Automations.
        await fireWhatsAppEvent(client, {
          event: 'lead.status_changed',
          matchValue: coreData.status,
          entityId: id,
          // Status in the key, so moving Call No Ans. (Day 1) → (Day 2) →
          // (Day 3) sends once per step rather than being collapsed into one
          // — three separate attempts to reach someone is three events, not a
          // repeat of the same one.
          dedupeKey: `leadstatus:${coreData.status}`,
        });
      }

      // ── Log assignment change ───────────────────────────────────────────
      if ('assigned_to' in coreData && coreData.assigned_to !== (prevLead?.assigned_to ?? null)) {
        let newAssigneeName = null;
        if (coreData.assigned_to) {
          const nr = await client.query(`SELECT name FROM users WHERE id = $1`, [coreData.assigned_to]);
          newAssigneeName = nr.rows[0]?.name || `User #${coreData.assigned_to}`;
        }
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
           VALUES ($1, 'assigned_changed', $2, $3, $4)`,
          [id, prevLead?.assigned_to_name || null, newAssigneeName, req.user.id]
        );
      }

      // ── Log service changes ─────────────────────────────────────────────
      if (services !== undefined) {
        const newServiceIds = new Set(services.map(s => s.service_id));
        const oldServiceIds = new Set(prevServices.map(s => s.id));

        // Removed services
        for (const svc of prevServices) {
          if (!newServiceIds.has(svc.id)) {
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
               VALUES ($1, 'service_removed', $2, NULL, $3)`,
              [id, svc.name, req.user.id]
            );
          }
        }

        // Added services — fetch names for new service ids
        for (const s of services) {
          if (!oldServiceIds.has(s.service_id)) {
            const svcRow = await client.query(`SELECT name FROM services WHERE id = $1`, [s.service_id]);
            const svcName = svcRow.rows[0]?.name || `Service #${s.service_id}`;
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
               VALUES ($1, 'service_added', NULL, $2, $3)`,
              [id, svcName, req.user.id]
            );
          }
        }
      }

      await client.query('COMMIT');

      // ── Notify assignee if assigned_to changed ──────────────────────────
      if ('assigned_to' in coreData && coreData.assigned_to) {
        // prevLead was captured before the update so this comparison is correct
        const isNewAssignment = prevLead?.assigned_to !== coreData.assigned_to;
        if (isNewAssignment) {
          const assignerRow = await pool.query(
            `SELECT name FROM users WHERE id = $1`, [req.user.id]
          );
          const assignerName = assignerRow.rows[0]?.name || 'Someone';
          const parts = [prevLead?.name, prevLead?.mobile].filter(Boolean);
          const leadLabel = parts.join(' • ') || `Lead #${id}`;
          const notifTitle = 'Lead Assigned';
          const notifBody  = `${leadLabel} assigned to you by ${assignerName}`;
          if (await isNotificationEnabled(pool, coreData.assigned_to, 'lead_assigned')) {
            await pool.query(
              `INSERT INTO notifications (user_id, type, title, body, lead_id)
               VALUES ($1, 'lead_assigned', $2, $3, $4)`,
              [coreData.assigned_to, notifTitle, notifBody, id]
            );
          }
          // Push immediately (single assignment — don't wait for summary)
          sendPush(coreData.assigned_to, 'lead_assigned', notifTitle, notifBody, '/leads');
        }
      }

      /* ── Alert #9 Lead Conversion ────────────────────────────────────────
         Asked of the STATUS TABLE, not of a list of names in this file.

         The list used to be ['won', 'converted', 'closed won'] and not one of
         those has ever been a status in this system — the alert read as
         working and had never once fired. A hardcoded name is wrong here twice
         over: it is wrong on the day it is written if nobody checks, and it
         goes wrong later the moment somebody renames a status.

         converts_to_appointment is the flag that MEANS converted: it is the
         one that turns a lead into an appointment. */
      if (coreData.status) {
        const conv = await client.query(
          `SELECT 1 FROM lead_statuses
            WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND converts_to_appointment`,
          [coreData.status]);
        if (conv.rowCount) fireLeadConversionAlert(id, req.user.id).catch(() => {});
      }

      // ── Alert #2 High Priority (on update) ───────────────────────────────
      if (coreData.priority || coreData.tags || (coreData.services !== undefined)) {
        fireHighPriorityAlert(id).catch(() => {});
      }

      const full = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
      res.json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function deleteLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('DELETE FROM leads WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
    logActivity({ userId: req.user?.id, userName: req.user?.name, action: 'DELETE', entity: 'lead', entityId: id, description: `Deleted lead #${id}` });
    res.status(204).end();
  });
}

function createLead(req, res, next) {
  handle(req, res, next, async () => {
    const data = leadSchema.parse(req.body);
    const userId = req.user.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const totalPrice = data.services.reduce((sum, s) => sum + s.price, 0);

      // status = NULL means "New Lead" — no status assigned yet
      // Only use data.status if explicitly passed
      const initialStatus = data.status || null;

      const leadRes = await client.query(
        `INSERT INTO leads (
          name, mobile, whatsapp, state_id, city_id, area_id,
          vehicle_type_id, make_id, model_id, body_type_id, segment_ids,
          lead_source, status, total_price, notes, created_by, assigned_to,
          priority, tags, public_token
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20
        ) RETURNING id`,
        [
          data.name, data.mobile, data.whatsapp || null,
          data.state_id || null, data.city_id || null, data.area_id || null,
          data.vehicle_type_id || null, data.make_id || null, data.model_id || null,
          data.body_type_id || null, data.segment_ids,
          data.lead_source || null, initialStatus, totalPrice, data.notes || null,
          userId, data.assigned_to || null,
          data.priority || 'normal', data.tags || [], generatePublicToken(),
        ]
      );

      const leadId = leadRes.rows[0].id;

      for (const s of data.services) {
        await client.query(
          'INSERT INTO lead_services (lead_id, service_id, price) VALUES ($1, $2, $3)',
          [leadId, s.service_id, s.price]
        );
      }

      // Save category-level interests (leads where only category is known, no specific service)
      for (const catId of (data.category_ids || [])) {
        await client.query(
          'INSERT INTO lead_categories (lead_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [leadId, catId]
        );
      }

      // Follow-up events on lead creation are no longer auto-scheduled by timing config.
      // They are created manually via the follow-up modal when a status with
      // needs_follow_up = true is selected on the lead.

      // ── Log lead creation to activity timeline ──────────────────────────
      await client.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
         VALUES ($1, 'created', NULL, $2, $3)`,
        [leadId, initialStatus || null, req.user.id]
      );

      await client.query('COMMIT');

      // ── Activity log ────────────────────────────────────────────────────
      logActivity({ userId, userName: req.user.name, action: 'CREATE', entity: 'lead', entityId: leadId, description: `Created lead for ${data.name || data.mobile}` });

      // ── Alert #7 Duplicate Lead ─────────────────────────────────────────
      fireDuplicateLeadAlert(leadId, data.mobile, userId).catch(() => {});

      // ── Alert #2 High Priority ──────────────────────────────────────────
      fireHighPriorityAlert(leadId).catch(() => {});

      res.status(201).json({ id: leadId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// =====================================================================
// PRICING LOOKUP
// =====================================================================

function lookupPrice(req, res, next) {
  handle(req, res, next, async () => {
    const {
      service_id, vehicle_type_id, body_type_id, segment_id,
      make_id, model_id, cc_category_id,
    } = lookupSchema.parse(req.body);

    // Shared dimension args (same for both service-level and category-level queries)
    const dims = [
      vehicle_type_id || null,
      body_type_id    || null,
      segment_id      || null,
      make_id         || null,
      model_id        || null,
      cc_category_id  || null,
    ];

    // Specificity scoring: model(64) > make(32) > segment/body_type/cc_category(8) > vehicle_type(4)
    // A NULL dimension on a rule means "match any value" for that dimension.
    const DIM_FILTER = `
         AND (vehicle_type_id IS NULL OR vehicle_type_id = $2)
         AND (body_type_id    IS NULL OR body_type_id    = $3)
         AND (segment_id      IS NULL OR segment_id      = $4)
         AND (make_id         IS NULL OR make_id         = $5)
         AND (model_id        IS NULL OR model_id        = $6)
         AND (cc_category_id  IS NULL OR cc_category_id  = $7)
       ORDER BY
         (CASE WHEN model_id        IS NOT NULL THEN 64 ELSE 0 END +
          CASE WHEN make_id         IS NOT NULL THEN 32 ELSE 0 END +
          CASE WHEN segment_id      IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN body_type_id    IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN cc_category_id  IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN vehicle_type_id IS NOT NULL THEN  4 ELSE 0 END) DESC
       LIMIT 1`;

    // ── Step 1: service-level rules ──────────────────────────────────────────
    const svcResult = await pool.query(
      `SELECT price FROM pricing
       WHERE service_id = $1 AND is_active = TRUE ${DIM_FILTER}`,
      [service_id, ...dims]
    );

    if (svcResult.rowCount > 0) {
      return res.json({ price: Number(svcResult.rows[0].price), source: 'service' });
    }

    // ── Step 2: category-level fallback ──────────────────────────────────────
    // Look up the service's parent category, then search category-level rules.
    const catRow = await pool.query(
      `SELECT category_id FROM services WHERE id = $1`,
      [service_id]
    );
    if (catRow.rowCount === 0) return res.json({ price: null });

    const categoryId = catRow.rows[0].category_id;
    const catResult  = await pool.query(
      `SELECT price FROM pricing
       WHERE category_id = $1 AND is_active = TRUE ${DIM_FILTER}`,
      [categoryId, ...dims]
    );

    if (catResult.rowCount > 0) {
      return res.json({ price: Number(catResult.rows[0].price), source: 'category' });
    }

    res.json({ price: null });
  });
}

// ── Export leads as CSV ───────────────────────────────────────────────────────
function exportLeads(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';
    const user   = req.user;

    const conditions = [];
    const params     = [];

    // Same helper as the list. One rule, one implementation.
    conditions.push(...scopeConditions(user, await teamIdsIfNeeded(user), params));

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(COALESCE(l.name,'')) LIKE $${params.length} OR l.mobile LIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Export SELECT — extends LEAD_SELECT with service/category subqueries
    const EXPORT_SELECT = `
      SELECT
        l.id, l.name, l.mobile, l.whatsapp, l.status, l.total_price,
        l.lead_source, l.notes, l.created_at,
        s.name  AS state_name,
        c.name  AS city_name,
        a.name  AS area_name,
        vt.name AS vehicle_type_name,
        mk.name AS make_name,
        md.name AS model_name,
        bt.name AS body_type_name,
        u.name  AS created_by_name,
        au.name AS assigned_to_name,
        (SELECT STRING_AGG(DISTINCT sc.name, ', ' ORDER BY sc.name)
           FROM lead_services ls
           JOIN services sv ON sv.id = ls.service_id
           JOIN service_categories sc ON sc.id = sv.category_id
           WHERE ls.lead_id = l.id
        ) AS service_categories,
        (SELECT STRING_AGG(DISTINCT sv.name, ', ' ORDER BY sv.name)
           FROM lead_services ls
           JOIN services sv ON sv.id = ls.service_id
           WHERE ls.lead_id = l.id
        ) AS service_names
      FROM leads l
      LEFT JOIN states        s  ON s.id  = l.state_id
      LEFT JOIN cities        c  ON c.id  = l.city_id
      LEFT JOIN areas         a  ON a.id  = l.area_id
      LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
      LEFT JOIN vehicle_makes mk ON mk.id = l.make_id
      LEFT JOIN vehicle_models md ON md.id = l.model_id
      LEFT JOIN body_types    bt ON bt.id = l.body_type_id
      LEFT JOIN users         u  ON u.id  = l.created_by
      LEFT JOIN users         au ON au.id = l.assigned_to`;

    const r = await pool.query(`${EXPORT_SELECT} ${where} ORDER BY l.created_at DESC`, params);

    // Build CSV
    const csvEscape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const headers = [
      'ID', 'Name', 'Mobile', 'WhatsApp', 'Status',
      'State', 'City', 'Area',
      'Vehicle Type', 'Make', 'Model', 'Body Type',
      'Lead Source', 'Total Price',
      'Service Category', 'Service Name', 'Notes',
      'Assigned To', 'Created By', 'Created At',
    ];

    const rows = r.rows.map(l => [
      l.id,
      l.name || '',
      l.mobile || '',
      l.whatsapp || '',
      l.status || 'New Lead',
      l.state_name || '',
      l.city_name || '',
      l.area_name || '',
      l.vehicle_type_name || '',
      l.make_name || '',
      l.model_name || '',
      l.body_type_name || '',
      l.lead_source || '',
      l.total_price || '',
      l.service_categories || '',
      l.service_names || '',
      l.notes ? l.notes.replace(/\r?\n/g, ' ') : '',
      l.assigned_to_name || '',
      l.created_by_name || '',
      l.created_at ? new Date(l.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
    ].map(csvEscape).join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads_${date}.csv"`);
    res.send('﻿' + csv); // BOM for Excel UTF-8 compatibility
  });
}

// ── Stage Conversion Time (Step 4) ───────────────────────────────────────────
// Returns avg seconds each status holds a lead, computed from lead_activities.
async function getStageStats(req, res) {
  try {
    const { rows } = await pool.query(`
      WITH ordered AS (
        SELECT
          lead_id,
          CASE WHEN type = 'created' THEN 'New Lead' ELSE new_value END AS status,
          created_at,
          LEAD(created_at) OVER (PARTITION BY lead_id ORDER BY created_at) AS next_at
        FROM lead_activities
        WHERE type IN ('status_changed', 'created')
      )
      SELECT
        status,
        ROUND(AVG(EXTRACT(EPOCH FROM (next_at - created_at))))::int AS avg_seconds,
        COUNT(*)::int AS sample_count
      FROM ordered
      WHERE next_at IS NOT NULL
      GROUP BY status
      ORDER BY avg_seconds DESC
    `);
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Bulk Assign ──────────────────────────────────────────────────────────────
function bulkAssign(req, res, next) {
  handle(req, res, next, async () => {
    const schema = z.object({
      lead_ids:    z.array(z.coerce.number().int().positive()).min(1),
      assigned_to: z.coerce.number().int().positive(),
    });
    const { lead_ids, assigned_to } = schema.parse(req.body);

    // Exclude leads that have already been converted to an appointment
    const convertedRes = await pool.query(
      `SELECT lead_id FROM appointments WHERE lead_id = ANY($1)`,
      [lead_ids]
    );
    const convertedIds = new Set(convertedRes.rows.map(r => r.lead_id));
    const assignable_ids = lead_ids.filter(id => !convertedIds.has(id));

    if (!assignable_ids.length) {
      return res.status(400).json({ error: 'All selected leads are already converted to appointments and cannot be reassigned.' });
    }

    // Capture old assigned_to names before updating (for activity log)
    const prevAssignedRes = await pool.query(
      `SELECT l.id, u.name AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = ANY($1)`,
      [assignable_ids]
    );
    const prevAssignedMap = Object.fromEntries(prevAssignedRes.rows.map(r => [r.id, r.assigned_to_name]));

    await pool.query(
      `UPDATE leads SET assigned_to = $1, updated_at = NOW() WHERE id = ANY($2)`,
      [assigned_to, assignable_ids]
    );

    // Notify the assigned user for each lead
    const assignerRow = await pool.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
    const assignerName = assignerRow.rows[0]?.name || 'Someone';

    // Get new assignee name for activity log
    const newAssigneeRow = await pool.query(`SELECT name FROM users WHERE id = $1`, [assigned_to]);
    const newAssigneeName = newAssigneeRow.rows[0]?.name || `User #${assigned_to}`;

    const bulkAssignNotifEnabled = await isNotificationEnabled(pool, assigned_to, 'lead_assigned');
    for (const leadId of assignable_ids) {
      if (bulkAssignNotifEnabled) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, lead_id)
           VALUES ($1, 'lead_assigned', $2, $3, $4)`,
          [assigned_to, `Lead Assigned`, `Lead #${leadId} assigned to you by ${assignerName}`, leadId]
        );
      }
      // Log assignment change to activity timeline
      await pool.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
         VALUES ($1, 'assigned_changed', $2, $3, $4)`,
        [leadId, prevAssignedMap[leadId] || null, newAssigneeName, req.user.id]
      );
    }

    // One summary push for all assigned leads
    const count = assignable_ids.length;
    const bulkTitle = count === 1 ? 'Lead Assigned' : `${count} Leads Assigned`;
    const bulkBody  = count === 1
      ? `Lead #${assignable_ids[0]} assigned to you by ${assignerName}`
      : `Assigned to you by ${assignerName}`;
    sendPush(assigned_to, 'lead_assigned', bulkTitle, bulkBody, '/leads');

    res.json({ updated: assignable_ids.length, skipped_converted: convertedIds.size });
  });
}

// ── Bulk Status ───────────────────────────────────────────────────────────────
//
// Set one status on many leads at once, from the selection bar on the Leads page.
//
// ── Why this is not a loop over PATCH /api/leads/:id ────────────────────────
//
// It very nearly is, and on purpose: a bulk change must leave the same trail a
// hand-made one does, or the timeline lies about how a lead got where it is.
// So each lead here gets its own activity row, its own follow-up close, and its
// own WhatsApp automation event — exactly what updateLead does.
//
// What it does NOT reuse is updateLead itself. That function reads req.params,
// writes a response, and opens its own transaction; calling it fifty times over
// would mean fifty transactions that can half-fail, and one HTTP response per
// lead. This is one transaction: either the whole selection moves or none of it
// does, which is the only outcome somebody who ticked fifty boxes can reason
// about.
//
// ── What it refuses, and why ────────────────────────────────────────────────
//
// Three kinds of lead are skipped rather than changed, and the count of each
// comes back so the frontend can say so instead of silently doing less than it
// was asked:
//
//   already converted   An appointment exists. Its status is the appointment's
//                       business now, not the lead list's.
//   locked status       is_locked means "this is where the lead ended". The
//                       single-lead dropdown renders those as a dead badge; the
//                       same rule has to hold here or bulk becomes the way to
//                       get around it.
//   already there       Nothing to do. Counted separately from a skip, because
//                       "8 changed, 2 already Contacted" is not a failure.
//
// A status flagged NEEDS_FOLLOW_UP may carry one follow-up for the whole
// selection — one date, one time, one note, written to every lead that moved.
// That is the honest shape of the thing: "chase all of these on Tuesday" is a
// single decision, unlike a call outcome, which describes one conversation and
// cannot describe twenty. So this endpoint takes a follow-up and does not take
// a call log.
//
// And one status is refused outright for the whole request: a status flagged
// converts_to_appointment. Applying it opens an appointment form per lead —
// vehicle, service, date, bay — which is per-lead data nobody can supply from a
// checkbox. Rejecting it is honest; applying the name without the appointment
// would leave leads marked converted with nothing to show for it.
function bulkStatus(req, res, next) {
  handle(req, res, next, async () => {
    const schema = z.object({
      lead_ids:    z.array(z.coerce.number().int().positive()).min(1).max(500),
      status:      z.string().trim().min(1).max(100),
      lost_reason: z.string().trim().max(120).optional().nullable(),

      /* ── One follow-up for the whole selection ─────────────────────────
         A status flagged needs_follow_up asks for a date when it is set on
         one lead, and used to ask for nothing at all in bulk — which meant
         the flag was quietly ignored on exactly the batches where a chased
         list matters most.

         The date is regexed here rather than parsed as a Date: 'YYYY-MM-DD'
         is what <input type="date"> emits and what lead_events.due_date
         stores, and accepting anything Date() will swallow would let
         '2026' through as 1 January.

         Optional at the SCHEMA level, then required below for a status
         flagged needs_follow_up. It has to be in two places: zod cannot see
         lead_statuses, so which statuses demand a date is a database fact,
         not a shape. A script moving leads to a plain status still needs no
         date; one moving them into a chase status does, because this handler
         closes the existing follow-up either way. */
      follow_up_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/,
        'The follow-up date must look like 2026-08-25.').optional().nullable(),
      follow_up_time: z.string().trim().regex(/^\d{2}:\d{2}$/,
        'The follow-up time must look like 09:00.').optional().nullable(),
      follow_up_note: z.string().trim().max(500).optional().nullable(),
    });
    const { lead_ids, status, lost_reason,
            follow_up_date, follow_up_time, follow_up_note } = schema.parse(req.body);

    // The status must exist. Matched case-insensitively because leads.status
    // stores the NAME, and a rename in Settings should not be able to strand a
    // request that was in flight.
    const stRes = await pool.query(
      `SELECT name, is_locked, converts_to_appointment, needs_follow_up
         FROM lead_statuses
        WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
        LIMIT 1`,
      [status]
    );
    const target = stRes.rows[0];
    if (!target) {
      return res.status(400).json({ error: `There is no status called "${status}".` });
    }
    if (target.converts_to_appointment) {
      return res.status(400).json({
        error: `"${target.name}" creates an appointment, which needs details for each lead. Open the leads one at a time to use it.`,
      });
    }
    /* Same rule as the single-lead update, and it matters MORE here.
       This handler closes the open follow-up on every selected lead before
       inserting the new one. Without a date there is no new one — so a bulk
       move of 200 leads into "Attempt 2" would silently strip 200 follow-ups
       and schedule nothing, which is the largest version of this mistake
       anybody can make in one click.

       The comment on follow_up_date in the schema above says the API does not
       insist, which was true and is now true only for statuses that do not
       carry the flag. A script moving leads to a plain status still needs no
       date; a script moving them into a chase status does. */
    if (target.needs_follow_up && !follow_up_date) {
      return res.status(422).json({
        error: `"${target.name}" needs a follow-up date. Send follow_up_date (YYYY-MM-DD) with the bulk status change.`,
        code: 'FOLLOW_UP_REQUIRED',
        status: target.name,
      });
    }

    // Canonical spelling from the table, not whatever the client sent — so the
    // string written to leads.status always matches lead_statuses.name exactly
    // and the colour lookup on the list keeps working.
    const statusName = target.name;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // One read decides everything: current status, whether that status is
      // locked, and whether an appointment already exists. FOR UPDATE so two
      // people bulk-changing overlapping selections queue rather than race.
      const rows = (await client.query(
        `SELECT l.id,
                l.status                                   AS cur,
                l.created_by,
                l.assigned_to,
                COALESCE(ls.is_locked, FALSE)              AS cur_locked,
                EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id) AS converted
           FROM leads l
           LEFT JOIN lead_statuses ls ON LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status))
          WHERE l.id = ANY($1)
          ORDER BY l.id
          FOR UPDATE OF l`,
        [lead_ids]
      )).rows;

      const skippedConverted = rows.filter(r => r.converted).length;
      const skippedLocked    = rows.filter(r => !r.converted && r.cur_locked).length;
      const unchanged        = rows.filter(r =>
        !r.converted && !r.cur_locked &&
        String(r.cur || '').trim().toLowerCase() === statusName.trim().toLowerCase()).length;

      const changeable = rows.filter(r =>
        !r.converted && !r.cur_locked &&
        String(r.cur || '').trim().toLowerCase() !== statusName.trim().toLowerCase());

      if (!changeable.length) {
        await client.query('ROLLBACK');
        // Nothing moved, so nothing is scheduled either — a follow-up belongs
        // to a status change, and there was no status change.
        return res.json({
          updated: 0,
          skipped_converted: skippedConverted,
          skipped_locked: skippedLocked,
          unchanged,
          status: statusName,
          follow_ups: 0,
          follow_up_date: null,
        });
      }

      const ids = changeable.map(r => r.id);

      await client.query(
        `UPDATE leads
            SET status = $1,
                ${lost_reason ? 'lost_reason = $3,' : ''}
                updated_at = NOW()
          WHERE id = ANY($2)`,
        lost_reason ? [statusName, ids, lost_reason] : [statusName, ids]
      );

      // Any status change closes the open follow-ups — the same rule
      // updateLead applies. A follow-up scheduled against the status you just
      // left is not a reminder any more, it is noise.
      //
      // This runs whether or not a new follow-up is being scheduled, and it
      // runs FIRST. Inserting before closing would mark the new one done in
      // the same breath, which is the version of this bug that looks like
      // "bulk follow-ups silently do nothing".
      await client.query(
        `UPDATE lead_events SET is_done = TRUE, done_at = NOW(), auto_closed = TRUE
          WHERE lead_id = ANY($1) AND is_done = FALSE`,
        [ids]
      );

      /* ── The new follow-up, one row per lead ────────────────────────────
         Same shape updateLead writes, so the Today / Tomorrow / This week
         tabs and the overdue alerts read these without knowing they came
         from a bulk action.

         due_at is built from the date and time as LOCAL time — `new
         Date('2026-08-25T09:00:00')` with no Z — because 9am means 9am at
         the workshop. Appending a Z would file a morning follow-up at 2:30pm
         IST and every one of them would look late.

         Written for the leads that actually MOVED. A lead the loop above
         skipped as locked or already converted keeps its status, so giving
         it a follow-up for a status it is not in would be a reminder about
         something that never happened. */
      let followUpCount = 0;
      if (follow_up_date) {
        const timeStr = follow_up_time || '09:00';
        const dueAt   = new Date(`${follow_up_date}T${timeStr}:00`);
        if (isNaN(dueAt)) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: 'That follow-up date and time is not a real moment.' });
        }
        const note = follow_up_note || 'Follow-up scheduled';

        // One statement, not one per lead: unnest expands the id array into
        // rows, so 500 leads cost a single round trip inside the transaction
        // rather than 500.
        await client.query(
          `INSERT INTO lead_events (lead_id, status_name, due_date, due_at, note)
           SELECT id, $2, $3, $4, $5 FROM unnest($1::int[]) AS t(id)`,
          [ids, statusName, follow_up_date, dueAt.toISOString(), note]
        );
        followUpCount = ids.length;
      }

      // One activity row per lead, carrying the status it came FROM — which is
      // why the previous values were read above rather than thrown away.
      const actNote = lost_reason ? `Lost reason: ${lost_reason}` : null;
      for (const r of changeable) {
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [r.id, r.cur || null, statusName, actNote, req.user.id]
        );
      }

      // The customer-facing half. Same event and the same dedupe key
      // updateLead uses, so a lead moved in bulk and a lead moved by hand
      // cannot both send the same message twice.
      //
      // On this transaction: the messages and the status commit together.
      // fireWhatsAppEvent savepoints its own work and never throws, so a
      // provider outage cannot stop the statuses being saved.
      for (const r of changeable) {
        await fireWhatsAppEvent(client, {
          event: 'lead.status_changed',
          matchValue: statusName,
          entityId: r.id,
          dedupeKey: `leadstatus:${statusName}`,
        });
      }

      await client.query('COMMIT');

      logActivity({
        userId:      req.user?.id,
        userName:    req.user?.name,
        action:      'UPDATE',
        entity:      'lead',
        description: `Bulk set status "${statusName}" on ${ids.length} lead(s): IDs ${ids.join(', ')}`,
      });

      /* ── Telling people, ONCE ───────────────────────────────────────────
         updateLead notifies the creator, the assignee and the actor for one
         follow-up. Repeating that per lead here would mean up to three
         notifications and three pushes times fifty leads — a phone buzzing
         a hundred and fifty times for a single click, which is how people
         learn to turn notifications off entirely.

         So one summary each, and each person is told THEIR number, not the
         total. An agent who owns three of the fifty is told about three;
         "50 follow-ups scheduled" would send them looking for forty-seven
         that are not theirs. The person who pressed the button gets the
         total, because that is the number they are responsible for.

         A person counted once per lead even if they are both its creator
         and its assignee — the Set inside the loop is what makes that true. */
      if (followUpCount) {
        const perUser = new Map();
        for (const r of changeable) {
          for (const uid of new Set([r.created_by, r.assigned_to].filter(Boolean))) {
            perUser.set(uid, (perUser.get(uid) || 0) + 1);
          }
        }
        if (req.user?.id) perUser.set(req.user.id, followUpCount);

        const timeStr = follow_up_time || '09:00';
        const when    = `${follow_up_date} at ${timeStr}`;

        for (const [uid, count] of perUser) {
          const body = `${count} follow-up${count === 1 ? '' : 's'} scheduled for ${when} `
                     + `(status set to ${statusName})`;
          try {
            // pool, not client — the transaction is committed and its client
            // released. A notification must never be able to reopen it.
            if (await isNotificationEnabled(pool, uid, 'follow_up_scheduled')) {
              await pool.query(
                `INSERT INTO notifications (user_id, type, title, body, lead_id)
                 VALUES ($1, 'follow_up_scheduled', $2, $3, NULL)`,
                [uid, 'Follow-ups scheduled', body]
              );
            }
            // lead_id NULL on purpose: this row is about a batch, and pointing
            // it at one arbitrary lead of fifty would open the wrong one.
            sendPush(uid, 'follow_up_scheduled', 'Follow-ups Scheduled', body, '/leads');
          } catch (err) {
            // The statuses and the follow-ups are already committed. A failure
            // to announce them must not turn into a 500 that makes the caller
            // believe none of it happened.
            console.error('[bulkStatus] follow-up notice failed for user', uid, '—', err.message);
          }
        }
      }

      // After the commit, never inside it: these fan out to push services and
      // must not be able to hold a transaction open or roll one back.
      // Same flag the single-lead path above uses. `target` was read from
      // lead_statuses at the top of this handler, so the answer is already
      // here and costs no query.
      if (target.converts_to_appointment) {
        for (const id of ids) fireLeadConversionAlert(id, req.user.id).catch(() => {});
      }

      res.json({
        updated: ids.length,
        skipped_converted: skippedConverted,
        skipped_locked: skippedLocked,
        unchanged,
        status: statusName,
        // How many follow-ups were actually written, so the toast can say so
        // rather than the frontend assuming its request took effect.
        follow_ups: followUpCount,
        follow_up_date: followUpCount ? follow_up_date : null,
        ids,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ── Bulk Delete ───────────────────────────────────────────────────────────────
function bulkDelete(req, res, next) {
  handle(req, res, next, async () => {
    const schema = z.object({
      lead_ids: z.array(z.coerce.number().int().positive()).min(1),
    });
    const { lead_ids } = schema.parse(req.body);

    const r = await pool.query(
      `DELETE FROM leads WHERE id = ANY($1)`,
      [lead_ids]
    );

    logActivity({
      userId:      req.user?.id,
      userName:    req.user?.name,
      action:      'DELETE',
      entity:      'lead',
      description: `Bulk deleted ${r.rowCount} lead(s): IDs ${lead_ids.join(', ')}`,
    });

    res.json({ deleted: r.rowCount });
  });
}

// ── GET /api/leads/check-mobile?mobile=xxx&exclude_id=yyy ─────────────────────
/**
 * Is this number already in the pipeline?
 *
 * ── THIS QUERY IS DELIBERATELY UNSCOPED. IT IS THE ONLY ONE. ────────────────
 *
 * Every other lead read filters by created_by / assigned_to. This one searches
 * every lead in the database, on purpose, and the reason is the whole point of
 * the warning: an advisor who cannot SEE a colleague's lead is exactly the
 * advisor about to create a second one for the same customer. Scope it and the
 * check becomes silent precisely when it is needed — the customer then gets
 * called twice by two people who each believe they own the conversation.
 *
 * ── SO WHAT IT RETURNS IS RATIONED ─────────────────────────────────────────
 *
 * The advisor is told the number is taken and WHO TO ASK. Not the customer's
 * name, not who created the record, not its history:
 *
 *   assigned_to_name   the person to go and talk to. This replaced
 *                      created_by_name, which answered a question nobody was
 *                      asking — the advisor needs whoever OWNS the customer
 *                      now, not whoever typed the row in months ago.
 *   can_view           whether this caller may actually open the lead.
 *
 * `can_view` exists because the screen used to offer a "View Lead →" button to
 * everybody, and for anyone outside the lead's scope it went nowhere: getLead
 * applies the normal filter and answers 404. Being told a record exists, being
 * offered a link to it, and having the link fail is worse than not being
 * offered the link — it reads as a broken CRM rather than a deliberate
 * boundary. The button is now shown only when it will work.
 *
 * The scope expression below MUST mirror listLeads and getLead. It is written
 * as a SELECT-list boolean rather than a WHERE clause because this query
 * returns rows the caller cannot see — that is its job — and must merely label
 * them.
 */
async function checkMobile(req, res, next) {
  try {
    const mobile     = (req.query.mobile || '').trim();
    const excludeId  = parseInt(req.query.exclude_id, 10) || 0;
    if (!mobile) return res.json({ duplicates: [] });

    const user = req.user;
    const full = Boolean(user.is_super_admin || user.permissions.has('VIEW_LEAD'));

    /* Same team resolution as everywhere else.
       This handler cannot use scopeConditions itself: it needs the predicate as
       an expression in the SELECT list with hand-computed placeholder numbers,
       not appended to a params array. The team LOOKUP is shared even so —
       that was the part that had drifted between copies. */
    const teamIds = await teamIdsIfNeeded(user);

    // Only return leads that are still OPEN (not yet converted to an appointment,
    // not lost, not cancelled). Leads that already have an appointment linked are
    // excluded — they are done; showing them as duplicates is misleading.
    // Built here so the $n numbering stays in step with the params array below.
    // `full` short-circuits to TRUE — a caller who sees everything needs no
    // comparison, and writing one would put their own id in the query for no
    // reason.
    const scopeParams = [];
    let canViewSql;
    if (full) {
      canViewSql = 'TRUE';
    } else if (teamIds) {
      scopeParams.push(teamIds);
      canViewSql = `(l.created_by = ANY($${1 + (excludeId ? 2 : 1)}))`;
    } else {
      scopeParams.push(user.id);
      canViewSql = `(l.created_by = $${1 + (excludeId ? 2 : 1)} `
                 + `OR l.assigned_to = $${1 + (excludeId ? 2 : 1)})`;
    }

    // ── COALESCE, and it is not decoration ──────────────────────────────────
    //
    // These same predicates live in listLeads and getLead as WHERE clauses,
    // where SQL's three-valued logic is harmless: a row evaluating to NULL is
    // not returned, which is the right answer. In a SELECT list it is not
    // harmless. `assigned_to = 1` against a NULL assigned_to is NULL, not
    // false, and `false OR NULL OR false` is NULL — so an unassigned lead
    // belonging to nobody came back with can_view: null.
    //
    // JavaScript treats null as falsy, so the screen would have behaved
    // correctly by accident. It would stop the day anyone wrote
    // `can_view === false`. Found by the test, not by reading.
    canViewSql = `COALESCE(${canViewSql}, FALSE)`;

    const r = await pool.query(
      `SELECT l.id, l.name, l.mobile, l.status, l.created_at,
              -- Who owns the customer NOW. NULL when nobody does, which the
              -- screen renders as "not assigned to anyone yet" — a different
              -- and more actionable sentence than naming a person.
              au.name AS assigned_to_name,
              -- Whether this caller may open it. See the header: the button is
              -- hidden rather than offered and broken.
              ${canViewSql} AS can_view
         FROM leads l
         LEFT JOIN users          au  ON au.id = l.assigned_to
         LEFT JOIN lead_statuses  ls  ON LOWER(ls.name) = LOWER(l.status)
        -- Matched on the last TEN DIGITS, not on the stored string.
        --
        -- This used to be a plain l.mobile = $1 compare, and leads.mobile is
        -- free text with no normalisation anywhere — so the same person saved as
        -- '+91 97241 90308' did not warn against a typed '9724190308'. The
        -- warning existed and quietly did nothing for every number that was not
        -- typed identically twice.
        --
        -- Since migration 155 that also breaks a NEW case: leads created by the
        -- inbound WhatsApp webhook are stored in E.164 ('+919111100001'), so an
        -- advisor typing '9111100001' would see no warning and open a second
        -- lead for someone already in the pipeline and already talking to them.
        --
        -- Same expression as waInboundLead.service.js and the index migration
        -- 155 added (idx_leads_mobile_national), so this is an index scan rather
        -- than a full table scan, and the two definitions of "same number"
        -- cannot disagree.
        WHERE RIGHT(regexp_replace(COALESCE(l.mobile, ''), '\\D', '', 'g'), 10)
              = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)
          ${excludeId ? 'AND l.id != $2' : ''}
          -- Exclude leads that already have an appointment created from them
          AND NOT EXISTS (
            SELECT 1 FROM appointments a WHERE a.lead_id = l.id
          )
          -- Exclude leads whose status is non-pipeline (converted / lost / cancelled)
          AND COALESCE(ls.is_pipeline, TRUE) = TRUE
          AND COALESCE(ls.converts_to_appointment, FALSE) = FALSE
        ORDER BY l.created_at DESC LIMIT 5`,
      excludeId ? [mobile, excludeId, ...scopeParams] : [mobile, ...scopeParams]
    );
    res.json({ duplicates: r.rows });
  } catch (err) { next(err); }
}

module.exports = {
  listLeads, getLead, getLeadByToken, createLead, updateLead, deleteLead, lookupPrice, exportLeads, getStageStats, bulkAssign, bulkStatus, bulkDelete, checkMobile,
};
