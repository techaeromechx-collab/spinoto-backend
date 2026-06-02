const { pool } = require('../config/db');

// ── Date-range WHERE helper ────────────────────────────────────────────────────
function dateParams(from, to, params, field) {
  const parts = [];
  if (from) { params.push(from); parts.push(`${field} >= $${params.length}::date`); }
  if (to)   { params.push(to);   parts.push(`${field} <  ($${params.length}::date + interval '1 day')`); }
  return parts.length ? parts.join(' AND ') : '';
}

// ── Resolve scope (mirrors leads controller logic) ────────────────────────────
// Returns { scope, userIds }
// scope: 'all' | 'team' | 'own'
// userIds: array of user ids to filter by (null = no filter needed for 'all')
async function resolveScope(user) {
  if (user.is_super_admin || user.permissions.has('VIEW_LEAD')) {
    return { scope: 'all', userIds: null };
  }
  if (user.permissions.has('VIEW_TEAM_LEADS')) {
    const teamRows = await pool.query(
      `SELECT id FROM users WHERE manager_id = $1`, [user.id]
    );
    const ids = teamRows.rows.map(r => r.id);
    ids.push(user.id);
    return { scope: 'team', userIds: ids };
  }
  return { scope: 'own', userIds: [user.id] };
}

// =====================================================================
// OVERVIEW SUMMARY
// =====================================================================
async function getSummary(req, res, next) {
  try {
    const { from, to }          = req.query;
    const { scope, userIds }    = await resolveScope(req.user);
    const params                = [];

    // scope clause
    let scopeWhere = '';
    if (userIds) { params.push(userIds); scopeWhere = `created_by = ANY($${params.length})`; }

    // date clause
    const dw = dateParams(from, to, params, 'created_at');

    const clauses = [scopeWhere, dw].filter(Boolean);
    const where   = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT
        COUNT(*)::int                                                               AS total_leads,
        COUNT(*) FILTER (WHERE status = 'converted')::int                          AS converted_leads,
        COALESCE(SUM(total_price), 0)::numeric                                     AS total_potential_revenue,
        COALESCE(SUM(total_price) FILTER (WHERE status = 'converted'), 0)::numeric AS realized_revenue
      FROM leads ${where}
    `, params);

    res.json({ ...r.rows[0], scope });
  } catch (err) { next(err); }
}

// =====================================================================
// STATUS DISTRIBUTION
// =====================================================================
async function getStatusDistribution(req, res, next) {
  try {
    const { from, to }       = req.query;
    const { userIds }        = await resolveScope(req.user);
    const params             = [];

    let scopeWhere = '';
    if (userIds) { params.push(userIds); scopeWhere = `created_by = ANY($${params.length})`; }

    const dw      = dateParams(from, to, params, 'created_at');
    const clauses = [scopeWhere, dw].filter(Boolean);
    const where   = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT status AS name, COUNT(*)::int AS value
      FROM leads ${where}
      GROUP BY status
      ORDER BY value DESC
    `, params);

    res.json({ items: r.rows });
  } catch (err) { next(err); }
}

// =====================================================================
// CATEGORY REVENUE
// =====================================================================
async function getCategoryRevenue(req, res, next) {
  try {
    const { from, to }       = req.query;
    const { userIds }        = await resolveScope(req.user);
    const params             = [];

    let scopeJoin = '';
    if (userIds) { params.push(userIds); scopeJoin = `AND l.created_by = ANY($${params.length})`; }

    const dw      = dateParams(from, to, params, 'l.created_at');
    const dateCond = dw ? `AND ${dw}` : '';

    const r = await pool.query(`
      SELECT
        sc.name                             AS name,
        COALESCE(SUM(ls.price), 0)::numeric AS value
      FROM service_categories sc
      LEFT JOIN services      s  ON s.category_id  = sc.id
      LEFT JOIN lead_services ls ON ls.service_id  = s.id
      LEFT JOIN leads         l  ON l.id = ls.lead_id ${scopeJoin} ${dateCond}
      GROUP BY sc.name
      ORDER BY value DESC
    `, params);

    res.json({ items: r.rows });
  } catch (err) { next(err); }
}

// =====================================================================
// BY USER — per-agent breakdown (scoped)
// =====================================================================
async function getByUser(req, res, next) {
  try {
    const { from, to }          = req.query;
    const { scope, userIds }    = await resolveScope(req.user);
    const params                = [];

    // Which users to show
    let userWhere = 'u.is_active = TRUE';
    if (userIds) {
      params.push(userIds);
      userWhere = `u.is_active = TRUE AND u.id = ANY($${params.length})`;
    }

    // Date filter on leads join
    const dw       = dateParams(from, to, params, 'l.created_at');
    const dateCond = dw ? `AND ${dw}` : '';

    const r = await pool.query(`
      SELECT
        u.id                                                                        AS user_id,
        u.name                                                                      AS user_name,
        u.email,
        COUNT(l.id)::int                                                            AS total_leads,
        COUNT(l.id) FILTER (WHERE l.status = 'converted')::int                     AS converted_leads,
        COALESCE(SUM(l.total_price), 0)::numeric                                   AS total_revenue,
        COALESCE(SUM(l.total_price) FILTER (WHERE l.status = 'converted'), 0)::numeric AS realized_revenue
      FROM users u
      LEFT JOIN leads l ON l.created_by = u.id ${dateCond}
      WHERE ${userWhere}
      GROUP BY u.id, u.name, u.email
      ORDER BY total_leads DESC NULLS LAST, u.name ASC
    `, params);

    res.json({ items: r.rows, scope });
  } catch (err) { next(err); }
}

// =====================================================================
// USER DETAIL — full drill-down for one agent
// GET /api/reports/user-detail/:userId?from=&to=
// =====================================================================
async function getUserDetail(req, res, next) {
  try {
    const userId       = parseInt(req.params.userId, 10);
    const { from, to } = req.query;
    const today        = new Date().toISOString().slice(0, 10);

    // ── permission check: only super-admins or VIEW_LEAD can see any user;
    //    team managers can see their own team; others only themselves
    const { scope, userIds } = await resolveScope(req.user);
    if (scope === 'own' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (scope === 'team' && userIds && !userIds.includes(userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── build date params for the selected period
    const params = [userId];
    const dw     = dateParams(from, to, params, 'l.created_at');
    const dateCond = dw ? `AND ${dw}` : '';

    // 1. Aggregate KPIs (scoped to date range)
    const kpiRes = await pool.query(`
      SELECT
        u.id        AS user_id,
        u.name      AS user_name,
        u.email,
        u.is_super_admin,
        COUNT(l.id)::int                                                               AS total_leads,
        COUNT(l.id) FILTER (WHERE l.status = 'converted')::int                        AS converted_leads,
        COUNT(l.id) FILTER (WHERE l.created_at::date = CURRENT_DATE)::int             AS leads_today,
        COUNT(l.id) FILTER (
          WHERE l.status IS NOT NULL AND l.status NOT IN ('converted','lost','cancelled','appointment cancelled')
        )::int                                                                         AS active_leads,
        COUNT(l.id) FILTER (WHERE l.status IS NULL)::int                               AS new_leads,
        COALESCE(SUM(l.total_price), 0)::numeric                                       AS pipeline_value,
        COALESCE(SUM(l.total_price) FILTER (WHERE l.status = 'converted'),0)::numeric  AS realized_revenue
      FROM users u
      LEFT JOIN leads l ON l.created_by = u.id ${dateCond}
      WHERE u.id = $1
      GROUP BY u.id, u.name, u.email, u.is_super_admin
    `, params);

    if (!kpiRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    // 2. Status breakdown (scoped to date range)
    const sbParams = [userId];
    const sbDw     = dateParams(from, to, sbParams, 'created_at');
    const sbWhere  = sbDw ? `AND ${sbDw}` : '';
    const sbRes = await pool.query(`
      SELECT
        COALESCE(status, 'New Lead') AS status_name,
        COUNT(*)::int AS count
      FROM leads
      WHERE created_by = $1 ${sbWhere}
      GROUP BY status
      ORDER BY count DESC
    `, sbParams);

    // 3. Pending follow-up events (always real-time, not date-scoped)
    const evRes = await pool.query(`
      SELECT
        e.id, e.due_date, e.note, e.status_name,
        l.id AS lead_id, l.name AS lead_name, l.mobile AS lead_mobile, l.status AS lead_status
      FROM lead_events e
      JOIN leads l ON l.id = e.lead_id
      WHERE l.created_by = $1
        AND e.is_done = FALSE
        AND e.due_date <= $2
      ORDER BY e.due_date ASC, e.created_at ASC
      LIMIT 20
    `, [userId, today]);

    // 4. Recent leads (latest 10, always real-time)
    const rlRes = await pool.query(`
      SELECT
        l.id, l.name, l.mobile, l.status, l.total_price, l.vehicle_type_id,
        l.created_at
      FROM leads l
      WHERE l.created_by = $1
      ORDER BY l.created_at DESC
      LIMIT 10
    `, [userId]);

    res.json({
      user:         kpiRes.rows[0],
      statusBreak:  sbRes.rows,
      pendingEvents: evRes.rows,
      recentLeads:  rlRes.rows,
    });
  } catch (err) { next(err); }
}

module.exports = {
  getDashboardStats,
  getSummary,
  getStatusDistribution,
  getCategoryRevenue,
  getByUser,
  getUserDetail,
};

// ── Dashboard stats ───────────────────────────────────────────────────────────
// GET /api/reports/dashboard
// Returns: today_appointments, month_revenue, pending_invoices, lead_conversion,
//          hub_performance[], recent_invoices[]
async function getDashboardStats(req, res, next) {
  try {
    const today      = new Date().toISOString().split('T')[0];
    const monthStart = today.slice(0, 7) + '-01';

    const [
      todayAppts,
      monthRevenue,
      pendingInvoices,
      leadConversion,
      hubPerformance,
      recentInvoices,
      invoiceStatusBreak,
      pipelineValue,
    ] = await Promise.all([

      // Today's appointments
      pool.query(
        `SELECT COUNT(*)::int AS count FROM appointments WHERE scheduled_date = $1::date`,
        [today]
      ),

      // This month's revenue (customer invoices — amount_paid sum)
      pool.query(
        `SELECT COALESCE(SUM(amount_paid), 0) AS revenue,
                COUNT(*)::int AS invoice_count
           FROM customer_invoices
          WHERE created_at >= $1::date`,
        [monthStart]
      ),

      // Pending invoices — customer_invoices with outstanding balance
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(grand_total - amount_paid), 0) AS outstanding_amount
           FROM customer_invoices
          WHERE grand_total - amount_paid > 0`
      ),

      // Lead conversion rate (leads that have an appointment / total leads)
      pool.query(
        `SELECT
           COUNT(DISTINCT l.id)::int                                       AS total_leads,
           COUNT(DISTINCT a.lead_id)::int                                  AS converted_leads,
           CASE WHEN COUNT(DISTINCT l.id) > 0
                THEN ROUND(COUNT(DISTINCT a.lead_id)::numeric / COUNT(DISTINCT l.id) * 100, 1)
                ELSE 0 END                                                 AS conversion_rate
         FROM leads l
         LEFT JOIN appointments a ON a.lead_id = l.id`
      ),

      // Hub performance — top hubs by appointment count this month
      pool.query(
        `SELECT
           h.hub_name,
           COUNT(a.id)::int                            AS appointment_count,
           COALESCE(SUM(a.total_price), 0)             AS total_value
         FROM hubs h
         LEFT JOIN appointments a ON a.hub_id = h.id
           AND a.scheduled_date >= $1::date
         WHERE h.deleted_at IS NULL AND h.is_active = TRUE
         GROUP BY h.id, h.hub_name
         ORDER BY appointment_count DESC
         LIMIT 6`,
        [monthStart]
      ),

      // Recent customer invoices (last 5)
      pool.query(
        `SELECT ci.id,
                COALESCE(ci.customer_name, a.customer_name) AS customer_name,
                COALESCE(ci.mobile, a.mobile)               AS mobile,
                ci.grand_total  AS total,
                ci.amount_paid,
                (ci.grand_total - ci.amount_paid) AS outstanding,
                ci.status       AS status_name,
                ci.created_at
           FROM customer_invoices ci
           LEFT JOIN appointments a ON a.id = ci.appointment_id
           ORDER BY ci.created_at DESC LIMIT 5`
      ),

      // Invoice status breakdown from customer_invoices
      pool.query(
        `SELECT status AS name, COUNT(*)::int AS count,
                COALESCE(SUM(grand_total), 0) AS total_amount
           FROM customer_invoices
           GROUP BY status
           ORDER BY count DESC`
      ),

      // Pipeline value — sum total_price for leads whose status has is_pipeline = true
      // Leads with NULL status (brand-new, no status set) are also counted in pipeline
      pool.query(
        `SELECT COALESCE(SUM(l.total_price), 0) AS pipeline_value
           FROM leads l
           LEFT JOIN lead_statuses ls ON ls.name = l.status
          WHERE l.status IS NULL OR ls.is_pipeline = TRUE`
      ),
    ]);

    res.json({
      today_appointments:  todayAppts.rows[0]?.count || 0,
      month_revenue:       monthRevenue.rows[0]?.revenue || 0,
      month_invoice_count: monthRevenue.rows[0]?.invoice_count || 0,
      pending_invoices:    pendingInvoices.rows[0]?.count || 0,
      outstanding_amount:  pendingInvoices.rows[0]?.outstanding_amount || 0,
      lead_conversion:     leadConversion.rows[0] || { total_leads: 0, converted_leads: 0, conversion_rate: 0 },
      hub_performance:     hubPerformance.rows,
      recent_invoices:     recentInvoices.rows,
      invoice_status_break: invoiceStatusBreak.rows,
      pipeline_value:      Number(pipelineValue.rows[0]?.pipeline_value || 0),
    });
  } catch (err) { next(err); }
}

module.exports = {
  getDashboardStats,
  getSummary,
  getStatusDistribution,
  getCategoryRevenue,
  getByUser,
  getUserDetail,
};

// ── Analytics: Monthly Revenue Trend (last 12 months) ────────────────────────
async function getRevenueTrend(req, res, next) {
  try {
    const r = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YYYY') AS month,
        DATE_TRUNC('month', invoice_date) AS month_date,
        COALESCE(SUM(grand_total), 0)  AS revenue,
        COUNT(*)                        AS invoice_count,
        COALESCE(SUM(amount_paid), 0)  AS collected
      FROM purchase_invoices
      WHERE invoice_date >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
      GROUP BY DATE_TRUNC('month', invoice_date)
      ORDER BY month_date ASC
    `);
    res.json({ items: r.rows });
  } catch (err) { next(err); }
}

// ── Analytics: Conversion Funnel ─────────────────────────────────────────────
async function getConversionFunnel(req, res, next) {
  try {
    const [leads, appts, estimates, invoices] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM leads`),
      pool.query(`SELECT COUNT(*) AS total FROM appointments`),
      pool.query(`SELECT COUNT(*) AS total FROM estimates`),
      pool.query(`SELECT COUNT(*) AS total FROM purchase_invoices`),
    ]);
    res.json({
      funnel: [
        { stage: 'Leads',        count: Number(leads.rows[0].total) },
        { stage: 'Appointments', count: Number(appts.rows[0].total) },
        { stage: 'Estimates',    count: Number(estimates.rows[0].total) },
        { stage: 'Invoices',     count: Number(invoices.rows[0].total) },
      ],
    });
  } catch (err) { next(err); }
}

// ── Analytics: Top Hubs & Top Services (last 90 days) ────────────────────────
async function getTopPerformers(req, res, next) {
  try {
    const [hubs, services] = await Promise.all([
      pool.query(`
        SELECT h.name AS hub_name,
               COUNT(pi.id)                      AS invoice_count,
               COALESCE(SUM(pi.grand_total), 0)  AS revenue
          FROM purchase_invoices pi
          JOIN hubs h ON h.id = pi.hub_id
         WHERE pi.invoice_date >= NOW() - INTERVAL '90 days'
         GROUP BY h.id, h.name
         ORDER BY revenue DESC NULLS LAST
         LIMIT 8
      `),
      pool.query(`
        SELECT s.name AS service_name,
               COUNT(ii.id)                   AS usage_count,
               COALESCE(SUM(ii.total), 0)     AS revenue
          FROM invoice_items ii
          JOIN services s ON s.id = ii.service_id
         WHERE ii.created_at >= NOW() - INTERVAL '90 days'
         GROUP BY s.id, s.name
         ORDER BY revenue DESC NULLS LAST
         LIMIT 8
      `),
    ]);
    res.json({ top_hubs: hubs.rows, top_services: services.rows });
  } catch (err) { next(err); }
}

module.exports = {
  getDashboardStats, getSummary, getStatusDistribution,
  getCategoryRevenue, getByUser, getUserDetail,
  getRevenueTrend, getConversionFunnel, getTopPerformers,
};
