'use strict';
const { pool } = require('../config/db');
const { istToday, istAddDays, istWeekday, istEndOfDayISO } = require('../utils/appTime');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

/* ── "Finished" leads have no follow-ups ────────────────────────────────────
   ONE definition, used by all four handlers. It was copy-pasted into each of
   them under four different names (NOT_CONVERTED, NOT_CONVERTED_COUNT,
   COMPLIANCE_NOT_CONVERTED, and an inline fourth), which is three chances to
   fix a rule in the place you are looking at and leave it wrong in the badge —
   a count of 5 over a list of 3, and no error anywhere.

   is_closed is NEW here. All four copies tested converts_to_appointment and
   is_locked only. That happens to be harmless in the current status set,
   because 'Lost' carries all three flags — but the day somebody ticks "closed"
   on a status in Settings without also ticking "locked", every follow-up on
   those leads reappears in the chase list and nothing explains why. A status
   marked closed IS finished; that is what the flag means. */
const FINISHED_LEAD_SQL = `
  AND l.status NOT IN (
    SELECT name FROM lead_statuses
    WHERE (converts_to_appointment = TRUE OR is_locked = TRUE OR is_closed = TRUE)
      AND is_active = TRUE
  )`;

// ─── Date range helpers ────────────────────────────────────────────────────────
// filter param: 'overdue' | 'today' | 'tomorrow' | 'week' | 'custom'
// For custom: pass date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//
// Overdue → due_date <= yesterday  (everything still open from before today)
// Today   → due_date = today       (exact day — overdue has its own tab)
// Tomorrow→ due_date = tomorrow    (exact day, no overdue)
// Week    → due_date between today and end of this week (Sunday)
// Custom  → due_date between date_from and date_to
//
/* Every date here is an IST calendar date, computed as a string.
   It used to be `new Date().toISOString().slice(0, 10)`, which is the UTC date
   whatever the process timezone is — toISOString() always renders UTC, so even
   running the process on IST would not have fixed it. Between midnight and
   05:30 IST the whole screen was therefore showing yesterday: a follow-up due
   today missing from the Today tab, and one due yesterday still counted as
   merely due rather than overdue. */
function getDateRange(query) {
  const todayStr = istToday();

  const filter = query.filter || 'today';

  if (filter === 'tomorrow') {
    const tomStr = istAddDays(todayStr, 1);
    return { dateFrom: tomStr, dateTo: tomStr, includeOverdue: false };
  }

  if (filter === 'week') {
    /* The `|| 7` is PRESERVED, not inherited by accident: on a Sunday the old
       code ran the window to the FOLLOWING Sunday rather than ending it today,
       so "This Week" shows eight days once a week. That is arguably wrong, but
       it is a week-boundary question and not a timezone one, and quietly
       changing what a tab means while fixing clocks is how a timezone fix gets
       blamed for a missing follow-up. Left alone deliberately. */
    const endStr = istAddDays(todayStr, (7 - istWeekday(todayStr)) % 7 || 7);
    return {
      dateFrom: todayStr,
      dateTo: endStr,
      // An absolute instant for the due_at comparison: the end of that day in
      // IST, which is 18:29:59.999Z. The old code sent 23:59:59.999 in UTC —
      // 05:29 IST the NEXT morning — so the week window quietly leaked five and
      // a half hours of the following day into every "this week" list.
      endAt: istEndOfDayISO(endStr),
      includeOverdue: false,
      isWeek: true,
    };
  }

  if (filter === 'custom') {
    const dateFrom = query.date_from || todayStr;
    const dateTo   = query.date_to   || todayStr;
    return { dateFrom, dateTo, includeOverdue: false };
  }

  /* EVERYTHING STILL OPEN FROM BEFORE TODAY.
     Its own filter now, because it used to be folded into 'today' — that tab
     ran `due_date <= today`, so a follow-up three weeks late sat in a list
     labelled Today and there was no way to see today's work on its own.

     dateTo is YESTERDAY, so 'overdue' and 'today' cannot both contain the same
     row. The two counts add up, and neither double-counts.

     isOverdue selects a clause that matches on due_date ALONE. The generic
     includeOverdue clause is `due_at <= now OR (due_at IS NULL AND due_date <=
     dateTo)`, and its first half would pull in a follow-up set for 09:00 THIS
     MORNING once 09:00 has passed — a row whose due_date is today and which
     therefore also sits in the Today tab. The two tabs would double-count it,
     which is the exact thing this split exists to stop. due_date is NOT NULL
     (migration 037), so a date-only comparison loses nothing. */
  if (filter === 'overdue') {
    return {
      dateFrom: null,
      dateTo: istAddDays(todayStr, -1),
      includeOverdue: true,
      isOverdue: true,
    };
  }

  /* default: 'today' — EXACTLY today.
     This used to be `{ dateTo: todayStr, includeOverdue: true }`, i.e.
     `due_date <= today`, on the reading that Today meant "my queue right now".
     Defensible, but it is not what the tab says, and it made the one number
     people check every morning impossible to trust. Overdue has its own tab
     above; this one answers only "what is due today". */
  return { dateFrom: todayStr, dateTo: todayStr, includeOverdue: false };
}

/* ── What a tab MEANS, in one place ─────────────────────────────────────────
   Returns the SQL for one filter plus the parameters it needs, numbered from
   `offset`. The list endpoint calls it once; the tab-count endpoint calls it
   once per tab and stacks the offsets.

   ONE definition, and that is the entire reason it exists as a function. The
   counts sit ON the tabs: a badge saying 6 above a list of 4 is worse than no
   badge at all, because the badge is what people trust when they are deciding
   whether to click. Two copies of "what does Overdue mean" is exactly how that
   happens — the same mistake FINISHED_LEAD_SQL above was written to stop.

   It replaces a `buildDueFilter` that nothing called: a stale third opinion on
   the same question, kept alive only by never being used. */
function dueClauseFor(query, now, offset = 0) {
  /* The whole query object, not just the filter name: `custom` carries its
     range in date_from / date_to, and passing only the name would silently
     hand it today..today. */
  const { dateFrom, dateTo, endAt, includeOverdue, isWeek, isOverdue } =
    getDateRange(query);
  const p = n => `$${offset + n}`;

  /* Date only. Comparing due_at to `now` would count a follow-up due at 09:00
     today as overdue from 09:01 — a row whose due_date is today and which is
     therefore also in the Today tab. See getDateRange. */
  if (isOverdue) {
    return { sql: `(e.due_date <= ${p(1)})`, args: [dateTo] };
  }
  if (includeOverdue) {
    return {
      sql: `((e.due_at IS NOT NULL AND e.due_at <= ${p(1)})
             OR (e.due_at IS NULL AND e.due_date <= ${p(2)}))`,
      args: [now, dateTo],
    };
  }
  if (isWeek) {
    return {
      sql: `((e.due_at IS NOT NULL AND e.due_at <= ${p(1)})
             OR (e.due_at IS NULL AND e.due_date BETWEEN ${p(2)} AND ${p(3)}))`,
      args: [endAt, dateFrom, dateTo],
    };
  }
  // tomorrow / today / custom — an exact range, matched on due_date alone.
  return { sql: `(e.due_date BETWEEN ${p(1)} AND ${p(2)})`, args: [dateFrom, dateTo] };
}

/* ── Who may see whose follow-ups ───────────────────────────────────────────
   The same three-way rule listEvents applies, as a clause the count endpoint
   can bolt on. Super admin sees everything, a VIEW_TEAM_LEADS manager sees
   their own plus their direct reports', everyone else sees their own.

   listEvents still spells this out inline, because its manager branch also
   needs the ids in the SELECT to compute is_team_followup and folding that in
   would make this function do two jobs. If you change the rule, change it in
   both — the counts are on the tabs above the list they describe, and a badge
   that counts a wider set than the list shows is a bug people report as
   "missing follow-ups". */
async function visibilityClause(req, offset = 0) {
  const { id: userId, is_super_admin, permissions } = req.user;
  if (is_super_admin) return { sql: '', args: [] };

  const p = `$${offset + 1}`;
  if (permissions.has('VIEW_TEAM_LEADS')) {
    const team = await pool.query(
      `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`, [userId]
    );
    return {
      sql: `AND (l.created_by = ANY(${p}) OR l.assigned_to = ANY(${p}))`,
      args: [[userId, ...team.rows.map(r => r.id)]],
    };
  }
  return { sql: `AND (l.created_by = ${p} OR l.assigned_to = ${p})`, args: [userId] };
}

/* GET /api/lead-events/tab-counts
   One number per tab, for the badges on the Follow-ups page. Custom has none —
   it is whatever range the user types, so there is nothing to count until they
   type it. */
function tabCounts(req, res, next) {
  handle(req, res, next, async () => {
    const now  = new Date().toISOString();
    const TABS = ['overdue', 'today', 'tomorrow', 'week'];

    /* One query, four FILTER clauses — not four round trips. Each tab's params
       are appended in turn and its clause numbered from where the previous one
       stopped, so the offsets stay in step with the array. */
    const args = [];
    const cols = TABS.map(t => {
      const c = dueClauseFor({ filter: t }, now, args.length);
      args.push(...c.args);
      return `COUNT(*) FILTER (WHERE ${c.sql})::int AS ${t}`;
    });

    const scope = await visibilityClause(req, args.length);
    args.push(...scope.args);

    /* The page's agent picker, applied HERE as well as on the client.

       The list is narrowed in the browser (`lead_assigned_to_id === agent`), so
       without this the badges would keep counting the whole team while the rows
       under them showed one person's — the precise failure a badge is supposed
       to prevent. `l.assigned_to` is the column that alias comes from, so the
       two tests are the same test.

       Digits ONLY, tested on the whole string rather than trusting parseInt.
       parseInt('1; DROP TABLE leads') is 1 — harmless here because the value is
       parameterised, but it means a malformed id silently becomes a real user's
       and returns a confident wrong number. Anything that is not a plain
       positive integer is ignored, which is the same as no filter. */
    const rawAgent = String(req.query.agent_id ?? '');
    let agentSql = '';
    if (/^[1-9][0-9]*$/.test(rawAgent)) {
      args.push(Number(rawAgent));
      agentSql = `AND l.assigned_to = $${args.length}`;
    }

    const r = await pool.query(
      `SELECT ${cols.join(',\n             ')}
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
        WHERE e.is_done = FALSE
          ${scope.sql}
          ${agentSql}
          ${FINISHED_LEAD_SQL}`,
      args
    );

    const row = r.rows[0] || {};
    res.json({
      counts: {
        overdue:  Number(row.overdue  || 0),
        today:    Number(row.today    || 0),
        tomorrow: Number(row.tomorrow || 0),
        week:     Number(row.week     || 0),
      },
    });
  });
}

// GET /api/lead-events?filter=today|tomorrow|week|custom&date_from=&date_to=
// Returns undone follow-up events filtered by the chosen period.
//
// Visibility rules:
//   Super admin              → all follow-ups
//   Manager (VIEW_TEAM_LEADS)→ own + team members' follow-ups
//   Regular user             → leads they created OR are assigned to
//
// Extra fields:
//   assigned_to_name  — name of user the lead is assigned to
//   is_team_followup  — true when event belongs to a team member (manager view)
function listEvents(req, res, next) {
  handle(req, res, next, async () => {
    const { id: userId, is_super_admin, permissions } = req.user;
    const isManager = !is_super_admin && permissions.has('VIEW_TEAM_LEADS');

    // ── lead_id mode: return ALL events for a specific lead (used by lead detail modal) ──
    const leadIdFilter = req.query.lead_id ? parseInt(req.query.lead_id, 10) : null;
    if (leadIdFilter) {
      const SELECT = `
        e.id, e.lead_id, e.status_name, e.due_date, e.due_at, e.note, e.is_done, e.done_at, e.created_at,
        e.auto_closed,
        l.name AS lead_name, l.mobile AS lead_mobile,
        au.name AS assigned_to_name,
        /* Who set it and who completed it. On the lead's own timeline this is
           the whole point of 170/171: a follow-up nobody recognises setting is
           the one that gets ignored, and "done" with no name against it cannot
           be questioned. NULL for anything scheduled before those migrations —
           rendered as "—", not as a blank that reads like a missing join. */
        cu.name AS created_by_name,
        du.name AS done_by_name
      `;
      const r = await pool.query(
        `SELECT ${SELECT}
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN users cu ON cu.id = e.created_by
         LEFT JOIN users du ON du.id = e.done_by
         WHERE e.lead_id = $1
         ORDER BY e.due_date ASC, e.created_at ASC`,
        [leadIdFilter]
      );
      return res.json({ items: r.rows });
    }

    /* Only for the response body — the SQL takes its dates from dueClauseFor
       below, which calls getDateRange itself. */
    const { dateFrom, dateTo } = getDateRange(req.query);
    const now = new Date().toISOString();

    /* lead_token is public_token, and it is what the Follow-ups page needs to
       open a lead: /leads/:token resolves through
       `SELECT id FROM leads WHERE public_token = $1` (utils/publicToken.js), so
       a numeric lead_id NEVER matches — the page loaded and nothing opened.

       Nullable, deliberately not coalesced to the id: migration 165 backfilled
       every existing lead, but a row that somehow has no token has no URL
       either, and sending the id would just 404 more quietly. The page disables
       the button instead. */
    const SELECT = `
      e.id, e.lead_id, e.status_name, e.due_date, e.due_at, e.note, e.is_done, e.done_at, e.created_at,
      l.name         AS lead_name,
      l.mobile       AS lead_mobile,
      l.status       AS lead_current_status,
      l.assigned_to  AS lead_assigned_to_id,
      l.public_token AS lead_token,
      au.name        AS assigned_to_name,
      cu.name        AS created_by_name
    `;

    let r;

    /* The due-date clause comes from dueClauseFor, the same helper the tab-count
       endpoint uses. It used to be an inline getDueClause() here, which meant
       the badge on a tab and the list under it were two separate opinions about
       what that tab contained. */
    const due = dueClauseFor(req.query, now, 0);

    // Exclude leads whose current status is terminal (locked) or already converted to an
    // appointment — follow-ups on those leads are no longer actionable.

    if (is_super_admin) {
      r = await pool.query(
        `SELECT ${SELECT}, FALSE AS is_team_followup
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN users cu ON cu.id = e.created_by
         WHERE e.is_done = FALSE
           AND (${due.sql})
           ${FINISHED_LEAD_SQL}
         ORDER BY e.due_date ASC, e.created_at ASC`,
        due.args
      );

    } else if (isManager) {
      const teamRes = await pool.query(
        `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`, [userId]
      );
      const allIds = [userId, ...teamRes.rows.map(r => r.id)];
      const offset = due.args.length;

      r = await pool.query(
        `SELECT ${SELECT},
                CASE WHEN (l.created_by = $${offset + 1} OR l.assigned_to = $${offset + 1}) THEN FALSE ELSE TRUE END AS is_team_followup
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN users cu ON cu.id = e.created_by
         WHERE e.is_done = FALSE
           AND (l.created_by = ANY($${offset + 2}) OR l.assigned_to = ANY($${offset + 2}))
           AND (${due.sql})
           ${FINISHED_LEAD_SQL}
         ORDER BY e.due_date ASC, e.created_at ASC`,
        [...due.args, userId, allIds]
      );

    } else {
      const offset = due.args.length;

      r = await pool.query(
        `SELECT ${SELECT}, FALSE AS is_team_followup
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN users cu ON cu.id = e.created_by
         WHERE e.is_done = FALSE
           AND (l.created_by = $${offset + 1} OR l.assigned_to = $${offset + 1})
           AND (${due.sql})
           ${FINISHED_LEAD_SQL}
         ORDER BY e.due_date ASC, e.created_at ASC`,
        [...due.args, userId]
      );
    }

    res.json({ items: r.rows, filter: req.query.filter || 'today', dateFrom, dateTo });
  });
}

// GET /api/lead-events/pending-count
// Always counts today + overdue (used for bell badge — never changes with filter tabs)
function pendingCount(req, res, next) {
  handle(req, res, next, async () => {
    const today = istToday();
    const { id: userId, is_super_admin, permissions } = req.user;
    const isManager = !is_super_admin && permissions.has('VIEW_TEAM_LEADS');
    const now = new Date().toISOString();

    let r;

    if (is_super_admin) {
      r = await pool.query(
        `SELECT COUNT(*) AS count FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         WHERE e.is_done = FALSE
           AND (
             (e.due_at IS NOT NULL AND e.due_at <= $1)
             OR (e.due_at IS NULL AND e.due_date <= $2)
           )
           ${FINISHED_LEAD_SQL}`,
        [now, today]
      );

    } else if (isManager) {
      const teamRes = await pool.query(
        `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`,
        [userId]
      );
      const allIds = [userId, ...teamRes.rows.map(r => r.id)];

      r = await pool.query(
        `SELECT COUNT(*) AS count FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         WHERE e.is_done = FALSE
           AND (l.created_by = ANY($3) OR l.assigned_to = ANY($3))
           AND (
             (e.due_at IS NOT NULL AND e.due_at <= $1)
             OR (e.due_at IS NULL AND e.due_date <= $2)
           )
           ${FINISHED_LEAD_SQL}`,
        [now, today, allIds]
      );

    } else {
      r = await pool.query(
        `SELECT COUNT(*) AS count FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         WHERE e.is_done = FALSE
           AND (l.created_by = $3 OR l.assigned_to = $3)
           AND (
             (e.due_at IS NOT NULL AND e.due_at <= $1)
             OR (e.due_at IS NULL AND e.due_date <= $2)
           )
           ${FINISHED_LEAD_SQL}`,
        [now, today, userId]
      );
    }

    res.json({ count: Number(r.rows[0].count) });
  });
}

// GET /api/lead-events/stats?user_id=X
// GET /api/lead-events/stats?user_id=X&period=today|week|month|all
// Overdue & Due Today are always current state (no period bound).
// Upcoming & Completed are scoped to the selected period.
// Avg Response Time is this-week vs last-week (fixed, not period-bound).
function getStats(req, res, next) {
  handle(req, res, next, async () => {
    const { id: userId, is_super_admin, permissions } = req.user;
    const isManager = !is_super_admin && permissions.has('VIEW_TEAM_LEADS');
    const today = istToday();

    // ── Target user resolution ──────────────────────────────────────────
    const requestedId = req.query.user_id;
    let targetIds = null;

    if (is_super_admin) {
      if (!requestedId || requestedId === 'all') {
        targetIds = null;
      } else if (requestedId === 'me' || requestedId === String(userId)) {
        targetIds = [userId];
      } else {
        const reqId = parseInt(requestedId, 10);
        targetIds = isNaN(reqId) ? [userId] : [reqId];
      }
    } else if (isManager) {
      const teamRes = await pool.query(
        `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`, [userId]
      );
      const teamIds = [userId, ...teamRes.rows.map(r => r.id)];
      if (!requestedId || requestedId === 'me' || requestedId === String(userId)) {
        targetIds = [userId];
      } else if (requestedId === 'all') {
        targetIds = teamIds;
      } else {
        const reqId = parseInt(requestedId, 10);
        targetIds = teamIds.includes(reqId) ? [reqId] : [userId];
      }
    } else {
      targetIds = [userId];
    }

    // ── Period bounds (for Upcoming & Completed) ─────────────────────────
    const period = req.query.period || 'week';
    let periodStart = null;
    let periodEnd   = null;

    /* All string arithmetic on IST dates.
       These were JS Date objects built with local-time setters and then read
       back with toISOString() — a combination that is wrong in two independent
       ways. toISOString() always renders UTC, so Monday 00:00 IST came back as
       the SUNDAY date; and the local setters answered to whatever zone the
       process happened to run in, which was UTC. Every "this week" bound was a
       day early, so Sunday's completed follow-ups were being counted into the
       previous week and Monday's fell out of both. */
    const dow = istWeekday(today);                       // 0 = Sunday
    const mon = istAddDays(today, -(dow === 0 ? 6 : dow - 1));

    if (period === 'today') {
      periodStart = today;
      periodEnd   = today;
    } else if (period === 'week') {
      periodStart = mon;
      periodEnd   = istAddDays(mon, 6);
    } else if (period === 'month') {
      periodStart = `${today.slice(0, 7)}-01`;
      // Day 0 of next month is the last day of this one. Built from the IST
      // date string rather than the process clock, so it cannot land in the
      // wrong month on the 1st before 05:30.
      const [y, m] = today.split('-').map(Number);
      periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }
    // 'all' → periodStart = null, periodEnd = null

    // ── This-week / last-week for avg response delta ──────────────────────
    const thisWeekStart = mon;
    const lastWeekStart = istAddDays(mon, -7);

    // ── Build query params ────────────────────────────────────────────────
    // $1=today $2=periodStart $3=periodEnd $4=thisWeekStart $5=lastWeekStart
    // optional $6=targetIds
    const queryParams = [today, periodStart, periodEnd, thisWeekStart, lastWeekStart];
    let targetExtra = '';
    if (targetIds) {
      queryParams.push(targetIds);
      targetExtra = `AND (l.created_by = ANY($6) OR l.assigned_to = ANY($6))`;
    }

    const r = await pool.query(
      `SELECT
         -- Always current state (no period filter)
         COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date < $1::date
         )::int AS overdue,
         COUNT(*) FILTER (WHERE e.is_done = FALSE
           AND e.due_date = ($1::date - INTERVAL '1 day')::date
         )::int AS overdue_new,
         COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date = $1::date
         )::int AS due_today,

         -- Period-scoped: Upcoming (future pending within period end)
         COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date > $1::date
           AND ($3::text IS NULL OR e.due_date <= $3::date)
         )::int AS upcoming,

         -- Period-scoped: Completed (done_at within period bounds)
         --
         -- NOT e.auto_closed on every done-based figure below. "Completed" here
         -- is shown to an advisor as their own week's work, so a follow-up that
         -- expired when somebody moved the status must not appear in it — that
         -- is somebody reading their own effort off a number that counts things
         -- they did not do.
         COUNT(*) FILTER (WHERE e.is_done = TRUE AND NOT e.auto_closed
           AND ($2::text IS NULL OR e.done_at::date >= $2::date)
           AND ($3::text IS NULL OR e.done_at::date <= $3::date)
         )::int AS completed,

         -- All-time for completion rate denominator
         COUNT(*) FILTER (WHERE e.is_done = TRUE AND NOT e.auto_closed)::int AS completed_total,
         -- and the denominator loses them too, or the rate is a fraction whose
         -- top and bottom count different things.
         COUNT(*) FILTER (WHERE NOT (e.is_done = TRUE AND e.auto_closed))::int AS total,

         -- Avg response: this week vs last week (always fixed).
         -- done_at - created_at on an auto-closed row measures how long the
         -- lead sat before somebody changed its status, which is not a response
         -- time to anything.
         ROUND(AVG(CASE WHEN e.is_done = TRUE AND NOT e.auto_closed AND e.done_at >= $4::date
           THEN EXTRACT(EPOCH FROM (e.done_at - e.created_at)) / 86400.0 END)::numeric, 1
         ) AS avg_response_days,
         ROUND(AVG(CASE WHEN e.is_done = TRUE AND NOT e.auto_closed
           AND e.done_at >= $5::date AND e.done_at < $4::date
           THEN EXTRACT(EPOCH FROM (e.done_at - e.created_at)) / 86400.0 END)::numeric, 1
         ) AS avg_response_last_week

       FROM lead_events e
       JOIN leads l ON l.id = e.lead_id
       WHERE TRUE ${targetExtra} ${FINISHED_LEAD_SQL}`,
      queryParams
    );

    const row = r.rows[0];
    const total          = Number(row.total);
    const completedTotal = Number(row.completed_total);
    const thisWeekAvg    = row.avg_response_days      != null ? Number(row.avg_response_days)      : null;
    const lastWeekAvg    = row.avg_response_last_week != null ? Number(row.avg_response_last_week) : null;

    res.json({
      overdue:            Number(row.overdue),
      overdue_new:        Number(row.overdue_new),
      due_today:          Number(row.due_today),
      upcoming:           Number(row.upcoming),
      completed:          Number(row.completed),
      total,
      completion_rate:    total > 0 ? Math.round((completedTotal / total) * 100) : 0,
      avg_response_days:  thisWeekAvg,
      avg_response_delta: (thisWeekAvg !== null && lastWeekAvg !== null)
                            ? Number((thisWeekAvg - lastWeekAvg).toFixed(1))
                            : null,
    });
  });
}

// PATCH /api/lead-events/:id/done
//
// The ONE path that means "a person did this follow-up". Everything else that
// sets is_done — a status change, a bulk update, an import, an appointment
// booking — writes auto_closed = TRUE and is excluded from the numbers.
//
// done_by is stamped here and nowhere else, for the same reason: it is the only
// moment at which a specific human is claiming the work.
function markDone(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);

    /* ── Whose follow-up is this ─────────────────────────────────────────
       The UPDATE was `WHERE id = $1` and nothing else. Every read on this
       router is carefully scoped — listEvents, pendingCount, getStats and
       getCompliance each rebuild the same three-tier rule — and the one WRITE
       was scoped by nothing at all. Any holder of any of the six permissions
       on canFollowUp (which includes plain CREATE_LEAD) could PATCH an
       arbitrary id and close a follow-up on a lead they cannot open, cannot
       list, and will never see again.

       It is not reachable by clicking: the UI can only tick what the list
       handed it. It is one curl away, and it got sharper the moment done_by
       started recording a name — a closed follow-up now carries an assertion
       about who did the work, so an unscoped write is a way to put somebody
       else's name on your call, or your name on theirs.

       404 rather than 403 for an out-of-scope id, matching the not-found case
       below. A 403 would confirm the row exists, which is exactly the fact the
       scope is there to withhold. */
    const params = [id, req.user.id];
    let scope = '';
    if (!(req.user.is_super_admin || req.user.permissions.has('VIEW_LEAD'))) {
      if (req.user.permissions.has('VIEW_TEAM_LEADS')) {
        const team = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`, [req.user.id]);
        params.push([req.user.id, ...team.rows.map(x => x.id)]);
        scope = `AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_events.lead_id
                              AND (l.created_by = ANY($3) OR l.assigned_to = ANY($3)))`;
      } else {
        scope = `AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_events.lead_id
                              AND (l.created_by = $2 OR l.assigned_to = $2))`;
      }
    }

    const r = await pool.query(
      `UPDATE lead_events
       SET is_done = TRUE, done_at = NOW(), done_by = $2, auto_closed = FALSE
       WHERE id = $1 ${scope}
       RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json({ item: r.rows[0] });
  });
}

// GET /api/lead-events/compliance
// Returns follow-up compliance stats. Visibility mirrors listEvents.
//   on_time  = marked done on or before the due date
//   late     = marked done after the due date
//   missed   = still not done and past due
//   rate     = on_time / (on_time + late + missed) * 100
function getCompliance(req, res, next) {
  handle(req, res, next, async () => {
    const { id: userId, is_super_admin, permissions } = req.user;
    const isManager = !is_super_admin && permissions.has('VIEW_TEAM_LEADS');

    // Build visibility filter
    let visibilitySQL = '';
    let visibilityParams = [];

    if (!is_super_admin) {
      if (isManager) {
        const teamRes = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1 AND is_active = TRUE`, [userId]
        );
        const allIds = [userId, ...teamRes.rows.map(r => r.id)];
        visibilitySQL = `AND (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`;
        visibilityParams = [allIds];
      } else {
        visibilitySQL = `AND (l.created_by = $1 OR l.assigned_to = $1)`;
        visibilityParams = [userId];
      }
    }

    const pOffset = visibilityParams.length;

    /* ── Auto-closed follow-ups are not compliance, either way ──────────────
       A follow-up closed by a status change is not evidence the advisor made
       the call, and it is not evidence they skipped it. It is evidence the
       reason for the call went away. So it belongs in neither on_time, late nor
       missed — it comes back as its own count, `auto`, and stays out of the
       rate.

       Counting it as on_time (what happened before) inflates: one import
       updating 400 statuses booked 400 completed follow-ups. Counting it as
       missed would deflate just as wrongly: moving Attempt 1 → Attempt 2 IS
       working the lead, and punishing it would push people to stop using the
       statuses.

       `auto` is returned rather than silently dropped because it is the number
       that says how much of the rate you should trust. 40 on_time out of 50
       reads very differently when 900 more were auto-closed — that is a team
       whose follow-ups are mostly being overtaken by events, and no single
       percentage can tell you that. */
    const overall = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1})::int                                             AS total_due,
         COUNT(*) FILTER (WHERE e.is_done = TRUE  AND NOT e.auto_closed AND e.done_at::date <= e.due_date)::int AS on_time,
         COUNT(*) FILTER (WHERE e.is_done = TRUE  AND NOT e.auto_closed AND e.done_at::date >  e.due_date)::int AS late,
         COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date < $${pOffset + 1})::int                        AS missed,
         COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.auto_closed)::int                                       AS auto
       FROM lead_events e
       JOIN leads l ON l.id = e.lead_id
       WHERE TRUE ${visibilitySQL} ${FINISHED_LEAD_SQL}`,
      [...visibilityParams, istToday()]
    );

    // Per-agent breakdown (only for super admin or manager)
    let byAgent = [];
    if (is_super_admin || isManager) {
      const agentRes = await pool.query(
        `SELECT
           COALESCE(u.name, 'Unassigned') AS agent_name,
           COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1})::int                                          AS total_due,
           COUNT(*) FILTER (WHERE e.is_done = TRUE  AND NOT e.auto_closed AND e.done_at::date <= e.due_date)::int AS on_time,
           COUNT(*) FILTER (WHERE e.is_done = TRUE  AND NOT e.auto_closed AND e.done_at::date >  e.due_date)::int AS late,
           COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date < $${pOffset + 1})::int                     AS missed,
           COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.auto_closed)::int                                     AS auto
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users u ON u.id = COALESCE(l.assigned_to, l.created_by)
         WHERE TRUE ${visibilitySQL} ${FINISHED_LEAD_SQL}
         GROUP BY u.id, u.name
         HAVING COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1}) > 0
         ORDER BY total_due DESC
         LIMIT 20`,
        [...visibilityParams, istToday()]
      );
      byAgent = agentRes.rows;
    }

    const o = overall.rows[0];
    const onTime = Number(o.on_time);
    const late   = Number(o.late);
    const missed = Number(o.missed);
    const auto   = Number(o.auto);
    // `auto` is deliberately NOT in the denominator — see the query above.
    const denominator = onTime + late + missed;
    const rate = denominator > 0 ? Math.round((onTime / denominator) * 100) : null;

    res.json({
      summary: { total_due: Number(o.total_due), on_time: onTime, late, missed, auto, rate },
      by_agent: byAgent.map(a => ({
        agent_name: a.agent_name,
        total_due:  Number(a.total_due),
        on_time:    Number(a.on_time),
        late:       Number(a.late),
        missed:     Number(a.missed),
        auto:       Number(a.auto),
        rate: (Number(a.on_time) + Number(a.late) + Number(a.missed)) > 0
          ? Math.round((Number(a.on_time) / (Number(a.on_time) + Number(a.late) + Number(a.missed))) * 100)
          : null,
      })),
    });
  });
}

module.exports = { listEvents, tabCounts, pendingCount, markDone, getCompliance, getStats };
