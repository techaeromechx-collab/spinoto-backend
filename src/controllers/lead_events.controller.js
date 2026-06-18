'use strict';
const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// ─── Date range helpers ────────────────────────────────────────────────────────
// filter param: 'today' | 'tomorrow' | 'week' | 'custom'
// For custom: pass date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//
// Today   → due_date <= today      (includes overdue)
// Tomorrow→ due_date = tomorrow    (exact day, no overdue)
// Week    → due_date between today and end of this week (Sunday)
// Custom  → due_date between date_from and date_to
//
function getDateRange(query) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const filter = query.filter || 'today';

  if (filter === 'tomorrow') {
    const tom = new Date(today);
    tom.setDate(tom.getDate() + 1);
    const tomStr = tom.toISOString().slice(0, 10);
    return { dateFrom: tomStr, dateTo: tomStr, includeOverdue: false };
  }

  if (filter === 'week') {
    const end = new Date(today);
    // days until Sunday (0 = Sunday)
    const daysUntilSun = (7 - today.getDay()) % 7 || 7;
    end.setDate(today.getDate() + daysUntilSun);
    end.setHours(23, 59, 59, 999); // end of Sunday
    const endDateStr = end.toISOString().slice(0, 10);
    const endAtStr   = end.toISOString(); // full timestamp for due_at comparison
    return { dateFrom: todayStr, dateTo: endDateStr, endAt: endAtStr, includeOverdue: false, isWeek: true };
  }

  if (filter === 'custom') {
    const dateFrom = query.date_from || todayStr;
    const dateTo   = query.date_to   || todayStr;
    return { dateFrom, dateTo, includeOverdue: false };
  }

  // default: 'today' — includes overdue (due_date <= today)
  return { dateFrom: null, dateTo: todayStr, includeOverdue: true };
}

// Builds the WHERE clause for due date filtering
// includeOverdue = true  → due_date <= dateTo  (past + today/week)
// includeOverdue = false → due_date BETWEEN dateFrom AND dateTo  (exact range)
function buildDueFilter(includeOverdue, paramOffset = 0) {
  // paramOffset lets us shift $1/$2 when other params come first
  const p1 = `$${paramOffset + 1}`;
  const p2 = `$${paramOffset + 2}`;
  const p3 = `$${paramOffset + 3}`;

  if (includeOverdue) {
    // today filter: due <= dateTo (p2), or due_at <= now (p1)
    return {
      sql: `(
        (e.due_at IS NOT NULL AND e.due_at <= ${p1})
        OR
        (e.due_at IS NULL AND e.due_date <= ${p2})
      )`,
      params: (now, dateTo) => [now, dateTo],
    };
  }

  // range filter: due_date BETWEEN dateFrom AND dateTo
  return {
    sql: `(
      e.due_at IS NULL
      AND e.due_date BETWEEN ${p2} AND ${p3}
    )`,
    params: (now, dateFrom, dateTo) => [now, dateFrom, dateTo],
  };
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
        l.name AS lead_name, l.mobile AS lead_mobile,
        au.name AS assigned_to_name
      `;
      const r = await pool.query(
        `SELECT ${SELECT}
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         WHERE e.lead_id = $1
         ORDER BY e.due_date ASC, e.created_at ASC`,
        [leadIdFilter]
      );
      return res.json({ items: r.rows });
    }

    const { dateFrom, dateTo, endAt, includeOverdue, isWeek } = getDateRange(req.query);
    const now = new Date().toISOString();

    const SELECT = `
      e.id, e.lead_id, e.status_name, e.due_date, e.due_at, e.note, e.is_done, e.done_at, e.created_at,
      l.name        AS lead_name,
      l.mobile      AS lead_mobile,
      l.status      AS lead_current_status,
      l.assigned_to AS lead_assigned_to_id,
      au.name       AS assigned_to_name
    `;

    let r;

    // ── Build the due-date WHERE clause based on filter type ─────────────────
    // today    → due_at <= now  OR  due_date <= today        (overdue + today)
    // week     → due_at <= endOfSunday  OR  due_date <= endOfWeek  (whole week range)
    // tomorrow/custom → due_date BETWEEN dateFrom AND dateTo (exact range, no due_at)
    const getDueClause = () => {
      if (includeOverdue) {
        // today — overdue + today: due_at <= now OR due_date <= today
        return { sql: `(e.due_at IS NOT NULL AND e.due_at <= $1) OR (e.due_at IS NULL AND e.due_date <= $2)`, args: [now, dateTo] };
      }
      if (isWeek) {
        // week — due_at within this week OR due_date within this week
        return { sql: `(e.due_at IS NOT NULL AND e.due_at <= $1) OR (e.due_at IS NULL AND e.due_date BETWEEN $2 AND $3)`, args: [endAt, dateFrom, dateTo] };
      }
      // tomorrow / custom — match by due_date regardless of due_at
      return { sql: `e.due_date BETWEEN $1 AND $2`, args: [dateFrom, dateTo] };
    };

    const due = getDueClause();

    // Exclude leads whose current status is terminal (locked) or already converted to an
    // appointment — follow-ups on those leads are no longer actionable.
    const NOT_CONVERTED = `
      AND l.status NOT IN (
        SELECT name FROM lead_statuses
        WHERE (converts_to_appointment = TRUE OR is_locked = TRUE)
          AND is_active = TRUE
      )`;

    if (is_super_admin) {
      r = await pool.query(
        `SELECT ${SELECT}, FALSE AS is_team_followup
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
         WHERE e.is_done = FALSE
           AND (${due.sql})
           ${NOT_CONVERTED}
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
         WHERE e.is_done = FALSE
           AND (l.created_by = ANY($${offset + 2}) OR l.assigned_to = ANY($${offset + 2}))
           AND (${due.sql})
           ${NOT_CONVERTED}
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
         WHERE e.is_done = FALSE
           AND (l.created_by = $${offset + 1} OR l.assigned_to = $${offset + 1})
           AND (${due.sql})
           ${NOT_CONVERTED}
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
    const today = new Date().toISOString().slice(0, 10);
    const { id: userId, is_super_admin, permissions } = req.user;
    const isManager = !is_super_admin && permissions.has('VIEW_TEAM_LEADS');
    const now = new Date().toISOString();

    let r;

    const NOT_CONVERTED_COUNT = `
      AND l.status NOT IN (
        SELECT name FROM lead_statuses
        WHERE (converts_to_appointment = TRUE OR is_locked = TRUE)
          AND is_active = TRUE
      )`;

    if (is_super_admin) {
      r = await pool.query(
        `SELECT COUNT(*) AS count FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         WHERE e.is_done = FALSE
           AND (
             (e.due_at IS NOT NULL AND e.due_at <= $1)
             OR (e.due_at IS NULL AND e.due_date <= $2)
           )
           ${NOT_CONVERTED_COUNT}`,
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
           ${NOT_CONVERTED_COUNT}`,
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
           ${NOT_CONVERTED_COUNT}`,
        [now, today, userId]
      );
    }

    res.json({ count: Number(r.rows[0].count) });
  });
}

// PATCH /api/lead-events/:id/done
function markDone(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `UPDATE lead_events
       SET is_done = TRUE, done_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
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

    // Overall summary
    const overall = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1})::int                                             AS total_due,
         COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.done_at::date <= e.due_date)::int                       AS on_time,
         COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.done_at::date >  e.due_date)::int                       AS late,
         COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date < $${pOffset + 1})::int                        AS missed
       FROM lead_events e
       JOIN leads l ON l.id = e.lead_id
       WHERE TRUE ${visibilitySQL}`,
      [...visibilityParams, new Date().toISOString().slice(0, 10)]
    );

    // Per-agent breakdown (only for super admin or manager)
    let byAgent = [];
    if (is_super_admin || isManager) {
      const agentRes = await pool.query(
        `SELECT
           COALESCE(u.name, 'Unassigned') AS agent_name,
           COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1})::int                                          AS total_due,
           COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.done_at::date <= e.due_date)::int                    AS on_time,
           COUNT(*) FILTER (WHERE e.is_done = TRUE  AND e.done_at::date >  e.due_date)::int                    AS late,
           COUNT(*) FILTER (WHERE e.is_done = FALSE AND e.due_date < $${pOffset + 1})::int                     AS missed
         FROM lead_events e
         JOIN leads l ON l.id = e.lead_id
         LEFT JOIN users u ON u.id = COALESCE(l.assigned_to, l.created_by)
         WHERE TRUE ${visibilitySQL}
         GROUP BY u.id, u.name
         HAVING COUNT(*) FILTER (WHERE e.due_date <= $${pOffset + 1}) > 0
         ORDER BY total_due DESC
         LIMIT 20`,
        [...visibilityParams, new Date().toISOString().slice(0, 10)]
      );
      byAgent = agentRes.rows;
    }

    const o = overall.rows[0];
    const onTime = Number(o.on_time);
    const late   = Number(o.late);
    const missed = Number(o.missed);
    const denominator = onTime + late + missed;
    const rate = denominator > 0 ? Math.round((onTime / denominator) * 100) : null;

    res.json({
      summary: { total_due: Number(o.total_due), on_time: onTime, late, missed, rate },
      by_agent: byAgent.map(a => ({
        agent_name: a.agent_name,
        total_due:  Number(a.total_due),
        on_time:    Number(a.on_time),
        late:       Number(a.late),
        missed:     Number(a.missed),
        rate: (Number(a.on_time) + Number(a.late) + Number(a.missed)) > 0
          ? Math.round((Number(a.on_time) / (Number(a.on_time) + Number(a.late) + Number(a.missed))) * 100)
          : null,
      })),
    });
  });
}

module.exports = { listEvents, pendingCount, markDone, getCompliance };
