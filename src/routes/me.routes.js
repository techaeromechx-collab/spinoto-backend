const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const { pool } = require('../config/db');

// Values must be validated, not just key-whitelisted — otherwise empty names,
// multi-MB photo strings, or non-string values (→ unhandled 500s) get through.
const profileSchema = z.object({
  name:                  z.string().trim().min(1).max(120).optional(),
  mobile:                z.string().trim().max(20).optional().nullable(),
  department:            z.string().trim().max(80).optional().nullable(),
  joining_date:          z.string().trim().max(30).optional().nullable(),
  profile_photo:         z.string().max(500_000).optional().nullable(), // data-URL or URL
  notification_settings: z.record(z.boolean()).optional(),
});

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING — GET /api/me  (unchanged — no breaking change)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.is_super_admin, u.created_at,
              u.mobile, u.department, u.joining_date, u.profile_photo, u.last_login,
              u.notification_settings, u.manager_id, u.hub_id,
              u.role_id, ro.name AS role_name,
              m.name AS manager_name,
              h.hub_name,
              COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       LEFT JOIN users m ON m.id = u.manager_id
       LEFT JOIN hubs h ON h.id = u.hub_id
       LEFT JOIN roles ro ON ro.id = u.role_id
       WHERE u.id = $1
       GROUP BY u.id, m.name, h.hub_name, ro.name`,
      [req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING — PATCH /api/me/password  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW — PATCH /api/me/profile  — update own profile info
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    let data;
    try {
      data = profileSchema.parse(req.body); // strips unknown keys
    } catch (zerr) {
      return res.status(400).json({ error: zerr.errors?.map(e => `${e.path.join('.')}: ${e.message}`).join('; ') || 'Invalid profile payload' });
    }

    const allowed = ['name', 'mobile', 'department', 'joining_date', 'profile_photo', 'notification_settings'];
    const fields = [];
    const params = [];

    for (const key of allowed) {
      if (key in data && data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.user.id);
    await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );

    // Return updated user
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.is_super_admin, u.created_at,
              u.mobile, u.department, u.joining_date, u.profile_photo, u.last_login,
              u.notification_settings, u.manager_id, u.hub_id,
              u.role_id, ro.name AS role_name,
              m.name AS manager_name,
              h.hub_name,
              COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       LEFT JOIN users m ON m.id = u.manager_id
       LEFT JOIN hubs h ON h.id = u.hub_id
       LEFT JOIN roles ro ON ro.id = u.role_id
       WHERE u.id = $1
       GROUP BY u.id, m.name, h.hub_name, ro.name`,
      [req.user.id]
    );
    res.json({ user: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW — GET /api/me/stats  — KPI numbers for the logged-in user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;

    const [leadsR, leadsLastR, followupsR, followupsYestR, overdueR, activityR, activityLastR, notesR, notesLastR] = await Promise.all([
      // Total / converted / pending leads (all time)
      pool.query(`
        SELECT
          COUNT(*)                                                                                    AS total_leads,
          COUNT(*) FILTER (WHERE status IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          ))                                                                                         AS converted_leads,
          COUNT(*) FILTER (WHERE status NOT IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          ) AND LOWER(COALESCE(status,'')) NOT IN ('lost','closed','cancelled'))                     AS pending_leads
        FROM leads
        WHERE created_by = $1 OR assigned_to = $1`, [uid]),

      // Same counts restricted to last month (for trend comparison)
      pool.query(`
        SELECT
          COUNT(*)                                                                                    AS total_leads,
          COUNT(*) FILTER (WHERE status IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          ))                                                                                         AS converted_leads,
          COUNT(*) FILTER (WHERE status NOT IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          ) AND LOWER(COALESCE(status,'')) NOT IN ('lost','closed','cancelled'))                     AS pending_leads
        FROM leads
        WHERE (created_by = $1 OR assigned_to = $1)
          AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
          AND created_at <  DATE_TRUNC('month', NOW())`, [uid]),

      // Follow-ups today
      pool.query(`
        SELECT COUNT(*) AS today_followups
        FROM lead_events le
        JOIN leads l ON l.id = le.lead_id
        WHERE le.is_done = FALSE
          AND le.due_date = CURRENT_DATE
          AND (l.created_by = $1 OR l.assigned_to = $1)`, [uid]),

      // Follow-ups yesterday (for day-over-day trend)
      pool.query(`
        SELECT COUNT(*) AS yesterday_followups
        FROM lead_events le
        JOIN leads l ON l.id = le.lead_id
        WHERE le.due_date = CURRENT_DATE - INTERVAL '1 day'
          AND (l.created_by = $1 OR l.assigned_to = $1)`, [uid]),

      // Overdue follow-ups
      pool.query(`
        SELECT COUNT(*) AS overdue_followups
        FROM lead_events le
        JOIN leads l ON l.id = le.lead_id
        WHERE le.is_done = FALSE
          AND le.due_at < NOW()
          AND (l.created_by = $1 OR l.assigned_to = $1)`, [uid]),

      // Activities this month
      pool.query(`
        SELECT COUNT(*) AS monthly_activities
        FROM lead_activities
        WHERE created_by = $1
          AND created_at >= DATE_TRUNC('month', NOW())`, [uid]),

      // Activities last month
      pool.query(`
        SELECT COUNT(*) AS monthly_activities
        FROM lead_activities
        WHERE created_by = $1
          AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
          AND created_at <  DATE_TRUNC('month', NOW())`, [uid]),

      // Notes this month
      pool.query(`
        SELECT COUNT(*) AS notes_count
        FROM lead_notes
        WHERE created_by = $1
          AND created_at >= DATE_TRUNC('month', NOW())`, [uid]),

      // Notes last month
      pool.query(`
        SELECT COUNT(*) AS notes_count
        FROM lead_notes
        WHERE created_by = $1
          AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
          AND created_at <  DATE_TRUNC('month', NOW())`, [uid]),
    ]);

    // Monthly lead conversion trend (last 6 months)
    const trendR = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN (
          SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
        )) AS converted
      FROM leads
      WHERE (created_by = $1 OR assigned_to = $1)
        AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)`, [uid]);

    res.json({
      total_leads:        parseInt(leadsR.rows[0].total_leads),
      converted_leads:    parseInt(leadsR.rows[0].converted_leads),
      pending_leads:      parseInt(leadsR.rows[0].pending_leads),
      today_followups:    parseInt(followupsR.rows[0].today_followups),
      overdue_followups:  parseInt(overdueR.rows[0].overdue_followups),
      monthly_activities: parseInt(activityR.rows[0].monthly_activities),
      notes_count:        parseInt(notesR.rows[0].notes_count),
      trend:              trendR.rows,
      // Last-period values for trend badges
      prev_total_leads:        parseInt(leadsLastR.rows[0].total_leads),
      prev_converted_leads:    parseInt(leadsLastR.rows[0].converted_leads),
      prev_pending_leads:      parseInt(leadsLastR.rows[0].pending_leads),
      prev_monthly_activities: parseInt(activityLastR.rows[0].monthly_activities),
      prev_notes_count:        parseInt(notesLastR.rows[0].notes_count),
      prev_today_followups:    parseInt(followupsYestR.rows[0].yesterday_followups),
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/me/trend?range=7d|30d|3m|6m  — chart data with selectable range
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trend', requireAuth, async (req, res, next) => {
  try {
    const uid   = req.user.id;
    const range = req.query.range || '6m';

    // Map range → interval + grouping
    const cfg = {
      '7d':  { interval: '6 days',    step: '1 day',   trunc: 'day',   fmt: 'DD Mon' },
      '30d': { interval: '29 days',   step: '1 day',   trunc: 'day',   fmt: 'DD Mon' },
      '3m':  { interval: '2 months',  step: '1 month', trunc: 'month', fmt: 'Mon YYYY' },
      '6m':  { interval: '5 months',  step: '1 month', trunc: 'month', fmt: 'Mon YYYY' },
    }[range] || { interval: '5 months', step: '1 month', trunc: 'month', fmt: 'Mon YYYY' };

    // generate_series ensures every period appears even with 0 leads
    const r = await pool.query(`
      WITH series AS (
        SELECT generate_series(
          DATE_TRUNC($2, NOW() - INTERVAL '${cfg.interval}'),
          DATE_TRUNC($2, NOW()),
          INTERVAL '${cfg.step}'
        ) AS period
      ),
      agg AS (
        SELECT
          DATE_TRUNC($2, created_at)  AS period,
          COUNT(*)                    AS total,
          COUNT(*) FILTER (WHERE status IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          ))                          AS converted
        FROM leads
        WHERE (created_by = $1 OR assigned_to = $1)
          AND created_at >= DATE_TRUNC($2, NOW() - INTERVAL '${cfg.interval}')
          AND created_at <  NOW() + INTERVAL '1 day'
        GROUP BY DATE_TRUNC($2, created_at)
      )
      SELECT
        TO_CHAR(s.period, $3)        AS label,
        s.period,
        COALESCE(a.total, 0)         AS total,
        COALESCE(a.converted, 0)     AS converted
      FROM series s
      LEFT JOIN agg a ON a.period = s.period
      ORDER BY s.period`,
      [uid, cfg.trunc, cfg.fmt]
    );

    res.json({ range, rows: r.rows });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW — GET /api/me/activity  — recent activity timeline for logged-in user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;

    const r = await pool.query(`
      SELECT
        la.id, la.type, la.old_value, la.new_value, la.note, la.created_at,
        l.id   AS lead_id,
        l.name AS lead_name,
        l.mobile AS lead_mobile
      FROM lead_activities la
      JOIN leads l ON l.id = la.lead_id
      WHERE la.created_by = $1
      ORDER BY la.created_at DESC
      LIMIT 20`, [uid]);

    res.json({ items: r.rows });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW — GET /api/me/team  — team members + their stats (managers/admins only)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/team', requireAuth, requirePermission('VIEW_TEAM_LEADS', 'VIEW_REPORTS'), async (req, res, next) => {
  try {
    const uid = req.user.id;

    // Get team members (users whose manager_id = current user)
    const membersR = await pool.query(`
      SELECT
        u.id, u.name, u.email, u.mobile, u.department, u.is_active,
        u.last_login, u.joining_date, u.profile_photo,
        COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions,
        (SELECT COUNT(*) FROM leads WHERE assigned_to = u.id OR created_by = u.id) AS total_leads,
        (SELECT COUNT(*) FROM leads WHERE (assigned_to = u.id OR created_by = u.id)
          AND LOWER(COALESCE(status,'')) IN ('won','converted'))                    AS converted_leads,
        (SELECT COUNT(*) FROM lead_events le JOIN leads l ON l.id = le.lead_id
          WHERE (l.assigned_to = u.id OR l.created_by = u.id)
            AND le.is_done = FALSE AND le.due_at < NOW())                          AS overdue_count
      FROM users u
      LEFT JOIN user_permissions up ON up.user_id = u.id
      WHERE u.manager_id = $1
      GROUP BY u.id
      ORDER BY u.name`, [uid]);

    res.json({ items: membersR.rows });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW — GET /api/me/team-stats  — aggregated team analytics (managers/admins)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/team-stats', requireAuth, requirePermission('VIEW_TEAM_LEADS', 'VIEW_REPORTS'), async (req, res, next) => {
  try {
    const uid = req.user.id;

    // All team member IDs
    const teamR = await pool.query(
      `SELECT id FROM users WHERE manager_id = $1`, [uid]
    );
    const teamIds = teamR.rows.map(r => r.id);
    if (!teamIds.length) return res.json({ active_members: 0, team_leads: 0, team_converted: 0, team_overdue: 0, escalated: 0, best_performer: null });

    const [leadsR, overdueR, escalatedR] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS team_leads,
          COUNT(*) FILTER (WHERE status IN (
            SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
          )) AS team_converted
        FROM leads
        WHERE assigned_to = ANY($1) OR created_by = ANY($1)`, [teamIds]),

      pool.query(`
        SELECT COUNT(*) AS team_overdue
        FROM lead_events le
        JOIN leads l ON l.id = le.lead_id
        WHERE le.is_done = FALSE AND le.due_at < NOW()
          AND (l.assigned_to = ANY($1) OR l.created_by = ANY($1))`, [teamIds]),

      pool.query(`
        SELECT COUNT(DISTINCT le.lead_id) AS escalated
        FROM lead_events le
        JOIN leads l ON l.id = le.lead_id
        WHERE le.is_done = FALSE AND le.due_at < NOW()
          AND EXTRACT(DAY FROM NOW() - le.due_at) > 3
          AND (l.assigned_to = ANY($1) OR l.created_by = ANY($1))`, [teamIds]),
    ]);

    // Best performer: most converted leads this month
    const bestR = await pool.query(`
      SELECT u.name, COUNT(*) AS converted
      FROM leads l
      JOIN users u ON u.id = l.assigned_to
      WHERE l.assigned_to = ANY($1)
        AND l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        AND l.updated_at >= DATE_TRUNC('month', NOW())
      GROUP BY u.id, u.name
      ORDER BY converted DESC
      LIMIT 1`, [teamIds]);

    res.json({
      active_members:  teamIds.length,
      team_leads:      parseInt(leadsR.rows[0].team_leads),
      team_converted:  parseInt(leadsR.rows[0].team_converted),
      team_overdue:    parseInt(overdueR.rows[0].team_overdue),
      escalated:       parseInt(escalatedR.rows[0].escalated),
      best_performer:  bestR.rows[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
