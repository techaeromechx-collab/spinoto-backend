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
/* ── The shared WhatsApp queue ────────────────────────────────────────────────
   An auto-created WhatsApp lead has created_by NULL — no user made it — and,
   until routing assigns it, assigned_to NULL too. Every scope filter below keys
   off exactly those two columns, so without this the queue would be invisible
   to everyone except full-access users: the leads the CRM works hardest to
   capture would be the only ones an advisor cannot see.

   Scoped as tightly as it can be — WhatsApp source, unassigned only. The moment
   somebody owns it the lead leaves this clause and obeys the normal rules
   again. No parameter, so it can be concatenated into any of the three filters
   without disturbing their $n numbering. */
const SHARED_SQL =
  " OR (LOWER(TRIM(COALESCE(l.lead_source,''))) = 'whatsapp' AND l.assigned_to IS NULL)";

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

function listLeads(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';
    const user   = req.user;

    const conditions = [];
    const params     = [];

    // ── Scope by permission level ──────────────────────────────────────────
    if (!user.is_super_admin && !user.permissions.has('VIEW_LEAD')) {
      if (user.permissions.has('VIEW_TEAM_LEADS')) {
        // Find all callers whose manager_id = this user's id, then include own leads too
        const teamRows = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1`,
          [user.id]
        );
        const teamIds = teamRows.rows.map(r => r.id);
        teamIds.push(user.id); // include manager's own leads as well
        params.push(teamIds);
        conditions.push(`(l.created_by = ANY($${params.length})${SHARED_SQL})`);
      } else {
        // VIEW_OWN_LEADS — leads they created OR are assigned to
        params.push(user.id);
        conditions.push(`(l.created_by = $${params.length} OR l.assigned_to = $${params.length}${SHARED_SQL})`);
      }
    }

    // ── Search & status filters ────────────────────────────────────────────
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(COALESCE(l.name,'')) LIKE $${params.length} OR l.mobile LIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    // ── Source filter ──────────────────────────────────────────────────────
    //
    // New. The list had search and status only, so "show me just the WhatsApp
    // leads" was not expressible — which matters now that leads arrive from the
    // inbound webhook and need to be told apart from the ones staff typed.
    //
    // TRIM everywhere. The client mirrors this grouping in LeadsPage.jsx and
    // trims before comparing; without it here a source stored as '  WhatsApp  '
    // — which free-text entry allows — lands under WhatsApp in the browser and
    // under Other on the server, and the same filter returns two different
    // answers depending on which one you asked.
    //
    // Grouped rather than an exact match, because lead_source is free text
    // (VARCHAR(80), no FK) with years of values in it. 'Manual' is not a stored
    // value at all — it is the ABSENCE of a campaign source, which is what a
    // lead typed in by an advisor looks like. Encoding that here keeps the
    // chips honest rather than offering a filter that returns nothing.
    const source = (req.query.source || '').trim();
    if (source && source.toLowerCase() !== 'all') {
      const key = source.toLowerCase();
      if (key === 'whatsapp') {
        params.push('whatsapp');
        conditions.push(`LOWER(TRIM(COALESCE(l.lead_source, ''))) = $${params.length}`);
      } else if (key === 'website') {
        params.push('website');
        conditions.push(`LOWER(TRIM(COALESCE(l.lead_source, ''))) = $${params.length}`);
      } else if (key === 'meta ads' || key === 'meta_ads' || key === 'meta') {
        // Meta covers what people have historically typed for the same thing.
        conditions.push(
          `LOWER(TRIM(COALESCE(l.lead_source, ''))) IN ('meta ads','meta','facebook','instagram','facebook ads','instagram ads','social media')`
        );
      } else if (key === 'manual') {
        // Typed by a person: no source, or one of the walk-up channels.
        conditions.push(
          `(l.lead_source IS NULL OR TRIM(l.lead_source) = ''
            OR LOWER(TRIM(l.lead_source)) IN ('manual','walk-in','walk in','phone call','referral'))`
        );
      } else if (key === 'other') {
        // Everything the four chips above do not claim. Defined as the
        // complement so a source nobody thought of still appears SOMEWHERE
        // instead of being invisible in every filter.
        conditions.push(
          `(l.lead_source IS NOT NULL AND TRIM(l.lead_source) <> ''
            AND LOWER(TRIM(l.lead_source)) NOT IN (
              'whatsapp','website','meta ads','meta','facebook','instagram',
              'facebook ads','instagram ads','social media',
              'manual','walk-in','walk in','phone call','referral'))`
        );
      } else {
        // Anything else is treated as an exact source name, so the filter keeps
        // working if a new one is added to lead_sources without touching this.
        params.push(key);
        conditions.push(`LOWER(TRIM(COALESCE(l.lead_source, ''))) = $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

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

    const r = await pool.query(`${LIST_SELECT} ${where} ORDER BY l.created_at DESC`, params);

    // Tell the frontend what scope was applied so it can show the right heading
    const scope = user.is_super_admin || user.permissions.has('VIEW_LEAD')
      ? 'all'
      : user.permissions.has('VIEW_TEAM_LEADS')
      ? 'team'
      : 'own';

    res.json({ items: r.rows, scope });
  });
}

function getLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const user = req.user;

    // Build the same ownership scope used by listLeads
    let whereClause = 'WHERE l.id = $1';
    const params = [id];

    if (!user.is_super_admin && !user.permissions.has('VIEW_LEAD')) {
      if (user.permissions.has('VIEW_TEAM_LEADS')) {
        // All callers whose manager_id = this user + own leads
        const teamRows = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1`, [user.id]
        );
        const teamIds = [user.id, ...teamRows.rows.map(r => r.id)];
        params.push(teamIds);
        whereClause += ` AND (l.created_by = ANY($${params.length})${SHARED_SQL})`;
      } else {
        // VIEW_OWN_LEADS — leads created by or assigned to this user
        params.push(user.id);
        whereClause += ` AND (l.created_by = $${params.length} OR l.assigned_to = $${params.length}${SHARED_SQL})`;
      }
    }

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
        // Close any existing open follow-ups for this lead
        await client.query(
          `UPDATE lead_events SET is_done = TRUE, done_at = NOW()
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
          `UPDATE lead_events SET is_done = TRUE, done_at = NOW()
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

      // ── Alert #9 Lead Conversion ─────────────────────────────────────────
      if (coreData.status) {
        const conversionStatuses = ['won', 'converted', 'closed won'];
        if (conversionStatuses.includes(coreData.status.toLowerCase())) {
          fireLeadConversionAlert(id, req.user.id).catch(() => {});
        }
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

    // Same scope rules as listLeads
    if (!user.is_super_admin && !user.permissions.has('VIEW_LEAD')) {
      if (user.permissions.has('VIEW_TEAM_LEADS')) {
        const teamRows = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1`, [user.id]
        );
        const teamIds = teamRows.rows.map(r => r.id);
        teamIds.push(user.id);
        params.push(teamIds);
        conditions.push(`(l.created_by = ANY($${params.length})${SHARED_SQL})`);
      } else {
        // VIEW_OWN_LEADS — leads they created OR are assigned to
        params.push(user.id);
        conditions.push(`(l.created_by = $${params.length} OR l.assigned_to = $${params.length}${SHARED_SQL})`);
      }
    }

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
    });
    const { lead_ids, status, lost_reason } = schema.parse(req.body);

    // The status must exist. Matched case-insensitively because leads.status
    // stores the NAME, and a rename in Settings should not be able to strand a
    // request that was in flight.
    const stRes = await pool.query(
      `SELECT name, is_locked, converts_to_appointment
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
        return res.json({
          updated: 0,
          skipped_converted: skippedConverted,
          skipped_locked: skippedLocked,
          unchanged,
          status: statusName,
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
      await client.query(
        `UPDATE lead_events SET is_done = TRUE, done_at = NOW()
          WHERE lead_id = ANY($1) AND is_done = FALSE`,
        [ids]
      );

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

      // After the commit, never inside it: these fan out to push services and
      // must not be able to hold a transaction open or roll one back.
      const conversionStatuses = ['won', 'converted', 'closed won'];
      if (conversionStatuses.includes(statusName.toLowerCase())) {
        for (const id of ids) fireLeadConversionAlert(id, req.user.id).catch(() => {});
      }

      res.json({
        updated: ids.length,
        skipped_converted: skippedConverted,
        skipped_locked: skippedLocked,
        unchanged,
        status: statusName,
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
async function checkMobile(req, res, next) {
  try {
    const mobile     = (req.query.mobile || '').trim();
    const excludeId  = parseInt(req.query.exclude_id, 10) || 0;
    if (!mobile) return res.json({ duplicates: [] });

    // Only return leads that are still OPEN (not yet converted to an appointment,
    // not lost, not cancelled). Leads that already have an appointment linked are
    // excluded — they are done; showing them as duplicates is misleading.
    const r = await pool.query(
      `SELECT l.id, l.name, l.mobile, l.status, l.created_at,
              u.name AS created_by_name
         FROM leads l
         LEFT JOIN users          u   ON u.id  = l.created_by
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
      excludeId ? [mobile, excludeId] : [mobile]
    );
    res.json({ duplicates: r.rows });
  } catch (err) { next(err); }
}

module.exports = {
  listLeads, getLead, getLeadByToken, createLead, updateLead, deleteLead, lookupPrice, exportLeads, getStageStats, bulkAssign, bulkStatus, bulkDelete, checkMobile,
};
