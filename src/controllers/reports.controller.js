const { pool } = require('../config/db');

// ── Date-range WHERE helper ────────────────────────────────────────────────────
function dateParams(from, to, params, field) {
  const parts = [];
  if (from) { params.push(from); parts.push(`${field} >= $${params.length}::date`); }
  if (to)   { params.push(to);   parts.push(`${field} <  ($${params.length}::date + interval '1 day')`); }
  return parts.length ? parts.join(' AND ') : '';
}

// ── Hub WHERE helper ───────────────────────────────────────────────────────────
// Filters leads by the hub of the user who created/is assigned to the lead
function hubClause(hubId, params, createdByAlias = 'created_by', assignedToAlias = 'assigned_to') {
  if (!hubId) return '';
  params.push(Number(hubId));
  const n = params.length;
  return `EXISTS (
    SELECT 1 FROM users _u WHERE _u.id IN (${createdByAlias}, ${assignedToAlias}) AND _u.hub_id = $${n}
  )`;
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
    const { from, to, hub_id, prev_from, prev_to } = req.query;
    const { scope, userIds } = await resolveScope(req.user);

    function buildQuery(f, t) {
      const params = [];
      let scopeWhere = '';
      if (userIds) { params.push(userIds); scopeWhere = `created_by = ANY($${params.length})`; }
      const dw  = dateParams(f, t, params, 'created_at');
      const hub = hubClause(hub_id, params);
      const clauses = [scopeWhere, dw, hub].filter(Boolean);
      const where   = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return { sql: `
        SELECT
          COUNT(*)::int                                                                        AS total_leads,
          COUNT(*) FILTER (
            WHERE status IN (
              SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
            )
          )::int                                                                               AS converted_leads,
          COALESCE(SUM(total_price), 0)::numeric                                              AS total_potential_revenue,
          COALESCE(SUM(total_price) FILTER (
            WHERE status IN (
              SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE
            )
          ), 0)::numeric                                                                       AS realized_revenue
        FROM leads ${where}
      `, params };
    }

    const curr = buildQuery(from, to);
    const queries = [pool.query(curr.sql, curr.params)];

    // Previous period comparison
    if (prev_from && prev_to) {
      const prev = buildQuery(prev_from, prev_to);
      queries.push(pool.query(prev.sql, prev.params));
    }

    const [currRes, prevRes] = await Promise.all(queries);
    res.json({
      ...currRes.rows[0],
      scope,
      prev: prevRes ? prevRes.rows[0] : null,
    });
  } catch (err) { next(err); }
}

// =====================================================================
// STATUS DISTRIBUTION
// =====================================================================
async function getStatusDistribution(req, res, next) {
  try {
    const { from, to, hub_id } = req.query;
    const { userIds }          = await resolveScope(req.user);
    const params               = [];

    let scopeWhere = '';
    if (userIds) { params.push(userIds); scopeWhere = `created_by = ANY($${params.length})`; }

    const dw      = dateParams(from, to, params, 'created_at');
    const hub     = hubClause(hub_id, params);
    const clauses = [scopeWhere, dw, hub].filter(Boolean);
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
    const { from, to, hub_id } = req.query;
    const { userIds }          = await resolveScope(req.user);
    const params               = [];

    let scopeJoin = '';
    if (userIds) { params.push(userIds); scopeJoin = `AND l.created_by = ANY($${params.length})`; }

    const dw       = dateParams(from, to, params, 'l.created_at');
    const hub      = hub_id ? hubClause(hub_id, params, 'l.created_by', 'l.assigned_to') : '';
    const dateCond = [dw, hub].filter(Boolean).map(c => `AND ${c}`).join(' ');

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
    const { from, to, hub_id }  = req.query;
    const { scope, userIds }    = await resolveScope(req.user);
    const params                = [];

    // Which users to show
    let userWhere = 'u.is_active = TRUE';
    if (userIds) {
      params.push(userIds);
      userWhere = `u.is_active = TRUE AND u.id = ANY($${params.length})`;
    }
    if (hub_id) {
      params.push(Number(hub_id));
      userWhere += ` AND u.hub_id = $${params.length}`;
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
        COUNT(l.id) FILTER (
          WHERE l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        )::int                                                                      AS converted_leads,
        COALESCE(SUM(l.total_price), 0)::numeric                                   AS total_revenue,
        COALESCE(SUM(l.total_price) FILTER (
          WHERE l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        ), 0)::numeric                                                              AS realized_revenue
      FROM users u
      LEFT JOIN leads l ON (l.created_by = u.id OR l.assigned_to = u.id) ${dateCond}
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
        COUNT(l.id) FILTER (
          WHERE l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        )::int                                                                         AS converted_leads,
        COUNT(l.id) FILTER (WHERE l.created_at::date = CURRENT_DATE)::int             AS leads_today,
        COUNT(l.id) FILTER (
          WHERE l.status IS NOT NULL
            AND l.status NOT IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
            AND l.status NOT IN (SELECT name FROM lead_statuses WHERE is_active = FALSE)
        )::int                                                                         AS active_leads,
        COUNT(l.id) FILTER (WHERE l.status IS NULL)::int                               AS new_leads,
        COALESCE(SUM(l.total_price), 0)::numeric                                       AS pipeline_value,
        COALESCE(SUM(l.total_price) FILTER (
          WHERE l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        ), 0)::numeric                                                                 AS realized_revenue
      FROM users u
      LEFT JOIN leads l ON (l.created_by = u.id OR l.assigned_to = u.id) ${dateCond}
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
      WHERE (created_by = $1 OR assigned_to = $1) ${sbWhere}
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
      WHERE (l.created_by = $1 OR l.assigned_to = $1)
        AND e.is_done = FALSE
        AND e.due_date <= $2
      ORDER BY e.due_date ASC, e.created_at ASC
      LIMIT 20
    `, [userId, today]);

    // 4. Recent leads (latest 10, always real-time)
    const rlRes = await pool.query(`
      SELECT
        l.id, l.name, l.mobile, l.status, l.total_price,
        vt.name AS vehicle_type_name,
        l.created_at
      FROM leads l
      LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
      WHERE (l.created_by = $1 OR l.assigned_to = $1)
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

// ── Dashboard stats ───────────────────────────────────────────────────────────
// GET /api/reports/dashboard
// Returns: today_appointments, month_revenue, pending_invoices, lead_conversion,
//          hub_performance[], recent_invoices[]
async function getDashboardStats(req, res, next) {
  try {
    const today      = new Date().toISOString().split('T')[0];
    const monthStart = today.slice(0, 7) + '-01';

    // ── Resolve scope ─────────────────────────────────────────────────────
    const { scope, userIds } = await resolveScope(req.user);
    const isAll = scope === 'all';
    // SQL snippet and param builder for lead-scoped queries
    const leadScope = (alias = 'l', offset = 0) => {
      if (isAll) return { sql: '', params: [] };
      return {
        sql: ` AND (${alias}.created_by = ANY($${offset + 1}) OR ${alias}.assigned_to = ANY($${offset + 1}))`,
        params: [userIds],
      };
    };

    // ── Hub performance period ────────────────────────────────────────────
    const period = req.query.period || 'month';
    let hubStart;
    if (period === 'week') {
      const d = new Date(); d.setDate(d.getDate() - 6);
      hubStart = d.toISOString().split('T')[0];
    } else if (period === 'all') {
      hubStart = '2000-01-01';
    } else {
      hubStart = monthStart;
    }

    const ls1 = leadScope('l', 1);
    const ls2 = leadScope('l', 1);

    const [
      todayAppts,
      monthRevenue,
      pendingInvoices,
      leadConversion,
      hubPerformance,
      recentInvoices,
      invoiceStatusBreak,
      pipelineValue,
      unassignedLeads,
      pendingEstimates,
      overdueFollowups,
      convertedThisMonth,
    ] = await Promise.all([

      // Today's appointments — no user scoping (appointments page shows all)
      pool.query(
        `SELECT COUNT(*)::int AS count 
           FROM appointments a 
          WHERE a.scheduled_date = $1::date
            AND a.status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))`,
        [today]
      ),

      // This month's revenue — scoped via appointment → lead
      pool.query(
        `SELECT COALESCE(SUM(ci.amount_paid), 0) AS revenue,
                COUNT(*)::int AS invoice_count
           FROM customer_invoices ci
           ${isAll ? '' : 'LEFT JOIN appointments a ON a.id = ci.appointment_id LEFT JOIN leads l ON l.id = a.lead_id'}
          WHERE ci.created_at >= $1::date
          ${isAll ? '' : `AND (l.created_by = ANY($2) OR l.assigned_to = ANY($2))`}`,
        isAll ? [monthStart] : [monthStart, userIds]
      ),

      // Pending invoices — scoped via appointment → lead
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(ci.grand_total - ci.amount_paid), 0) AS outstanding_amount
           FROM customer_invoices ci
           ${isAll ? '' : 'LEFT JOIN appointments a ON a.id = ci.appointment_id LEFT JOIN leads l ON l.id = a.lead_id'}
          WHERE ci.grand_total - ci.amount_paid > 0
          ${isAll ? '' : `AND (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}`,
        isAll ? [] : [userIds]
      ),

      // Lead conversion rate — scoped by lead owner
      pool.query(
        `SELECT
           COUNT(DISTINCT l.id)::int AS total_leads,
           COUNT(DISTINCT a.lead_id)::int AS converted_leads,
           CASE WHEN COUNT(DISTINCT l.id) > 0
                THEN ROUND(COUNT(DISTINCT a.lead_id)::numeric / COUNT(DISTINCT l.id) * 100, 1)
                ELSE 0 END AS conversion_rate
         FROM leads l
         LEFT JOIN appointments a ON a.lead_id = l.id
         ${isAll ? '' : `WHERE (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}`,
        isAll ? [] : [userIds]
      ),

      // Hub performance — always system-wide (hub-level metric)
      pool.query(
        `SELECT
           h.hub_name,
           COUNT(a.id)::int                AS appointment_count,
           COALESCE(SUM(a.total_price), 0) AS total_value
         FROM hubs h
         LEFT JOIN appointments a ON a.hub_id = h.id
           AND a.scheduled_date >= $1::date
           AND a.status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))
         WHERE h.deleted_at IS NULL AND h.is_active = TRUE
         GROUP BY h.id, h.hub_name
         ORDER BY appointment_count DESC
         LIMIT 6`,
        [hubStart]
      ),

      // Recent invoices — scoped via appointment → lead
      pool.query(
        `SELECT ci.id,
                COALESCE(ci.customer_name, a.customer_name) AS customer_name,
                COALESCE(ci.mobile, a.mobile) AS mobile,
                ci.grand_total AS total,
                ci.amount_paid,
                (ci.grand_total - ci.amount_paid) AS outstanding,
                ci.status AS status_name,
                ci.created_at
           FROM customer_invoices ci
           LEFT JOIN appointments a ON a.id = ci.appointment_id
           ${isAll ? '' : 'LEFT JOIN leads l ON l.id = a.lead_id'}
           ${isAll ? '' : `WHERE (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}
           ORDER BY ci.created_at DESC LIMIT 5`,
        isAll ? [] : [userIds]
      ),

      // Invoice status breakdown — scoped via appointment → lead
      pool.query(
        `SELECT ci.status AS name, COUNT(*)::int AS count,
                COALESCE(SUM(ci.grand_total), 0) AS total_amount
           FROM customer_invoices ci
           ${isAll ? '' : 'LEFT JOIN appointments a ON a.id = ci.appointment_id LEFT JOIN leads l ON l.id = a.lead_id'}
           ${isAll ? '' : `WHERE (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}
           GROUP BY ci.status ORDER BY count DESC`,
        isAll ? [] : [userIds]
      ),

      // Pipeline value — scoped by lead owner
      pool.query(
        `SELECT COALESCE(SUM(l.total_price), 0) AS pipeline_value
           FROM leads l
           LEFT JOIN lead_statuses ls ON ls.name = l.status
          WHERE (l.status IS NULL OR ls.is_pipeline = TRUE)
          ${isAll ? '' : `AND (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}`,
        isAll ? [] : [userIds]
      ),

      // Unassigned leads — scoped by lead owner
      pool.query(
        `SELECT COUNT(*)::int AS count FROM leads l
          WHERE l.assigned_to IS NULL
          ${isAll ? '' : `AND (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}`,
        isAll ? [] : [userIds]
      ),

      // Pending estimates — scoped via appointment → lead
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM estimates e
           ${isAll ? '' : 'LEFT JOIN appointments a ON a.id = e.appointment_id LEFT JOIN leads l ON l.id = a.lead_id'}
          WHERE e.status IN ('draft', 'pending_review')
          ${isAll ? '' : `AND (l.created_by = ANY($1) OR l.assigned_to = ANY($1))`}`,
        isAll ? [] : [userIds]
      ),

      // Overdue follow-ups — scoped via lead
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM lead_events le
           ${isAll ? '' : 'JOIN leads l ON l.id = le.lead_id'}
          WHERE le.is_done = FALSE
            AND ((le.due_at IS NOT NULL AND le.due_at < NOW())
              OR (le.due_at IS NULL AND le.due_date < $1::date))
          ${isAll ? '' : `AND (l.created_by = ANY($2) OR l.assigned_to = ANY($2))`}`,
        isAll ? [today] : [today, userIds]
      ),

      // Converted this month — scoped via lead
      pool.query(
        `SELECT COUNT(DISTINCT a.lead_id)::int AS count
           FROM appointments a
           ${isAll ? '' : 'JOIN leads l ON l.id = a.lead_id'}
          WHERE a.created_at >= $1::date
            AND a.lead_id IS NOT NULL
            AND a.status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))
          ${isAll ? '' : `AND (l.created_by = ANY($2) OR l.assigned_to = ANY($2))`}`,
        isAll ? [monthStart] : [monthStart, userIds]
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
      unassigned_leads:      unassignedLeads.rows[0]?.count || 0,
      pending_estimates:     pendingEstimates.rows[0]?.count || 0,
      overdue_followups:     overdueFollowups.rows[0]?.count || 0,
      converted_this_month:  convertedThisMonth.rows[0]?.count || 0,
    });
  } catch (err) { next(err); }
}

// ── Analytics: Monthly Revenue Trend ─────────────────────────────────────────
async function getRevenueTrend(req, res, next) {
  try {
    const { from, to } = req.query;
    const { scope, userIds } = await resolveScope(req.user);
    const isAll = scope === 'all';

    const params = [];
    let scopeJoin  = '';
    let scopeWhere = '';

    if (!isAll) {
      params.push(userIds);
      scopeJoin  = `LEFT JOIN appointments a ON a.id = ci.appointment_id
                    LEFT JOIN leads l ON l.id = a.lead_id`;
      scopeWhere = `AND (l.created_by = ANY($${params.length}) OR l.assigned_to = ANY($${params.length}))`;
    }

    // Date range — default to last 12 months if not provided
    let dateWhere;
    if (from && to) {
      params.push(from); params.push(to);
      dateWhere = `ci.created_at >= $${params.length - 1}::date AND ci.created_at < ($${params.length}::date + interval '1 day')`;
    } else {
      dateWhere = `ci.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'`;
    }

    const r = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', ci.created_at), 'Mon YYYY') AS month,
        DATE_TRUNC('month', ci.created_at)                      AS month_date,
        COALESCE(SUM(ci.amount_paid), 0)                        AS revenue,
        COUNT(*)::int                                            AS invoice_count
      FROM customer_invoices ci
      ${scopeJoin}
      WHERE ${dateWhere}
      ${scopeWhere}
      GROUP BY DATE_TRUNC('month', ci.created_at)
      ORDER BY month_date ASC
    `, params);

    res.json({ items: r.rows });
  } catch (err) { next(err); }
}

// ── Analytics: Conversion Funnel ─────────────────────────────────────────────
async function getConversionFunnel(req, res, next) {
  try {
    const { from, to } = req.query;
    function buildFunnelQ(table) {
      const extraWhere = table === 'appointments'
        ? " AND status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))"
        : "";

      if (from && to) {
        return pool.query(
          `SELECT COUNT(*) AS total FROM ${table} WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 day') ${extraWhere}`,
          [from, to]
        );
      }
      return pool.query(`SELECT COUNT(*) AS total FROM ${table} ${table === 'appointments' ? `WHERE status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))` : ''}`);
    }
    const [leads, appts, estimates, invoices] = await Promise.all([
      buildFunnelQ('leads'),
      buildFunnelQ('appointments'),
      buildFunnelQ('estimates'),
      buildFunnelQ('purchase_invoices'),
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

// ── Analytics: Top Hubs & Top Services ───────────────────────────────────────
async function getTopPerformers(req, res, next) {
  try {
    const { from, to } = req.query;
    const dateParams = from && to ? [from, to] : [];
    const hubDateWhere = from && to
      ? `pi.created_at >= $1::date AND pi.created_at < ($2::date + interval '1 day')`
      : `pi.created_at >= NOW() - INTERVAL '90 days'`;
    const svcDateWhere = from && to
      ? `cii.created_at >= $1::date AND cii.created_at < ($2::date + interval '1 day')`
      : `cii.created_at >= NOW() - INTERVAL '90 days'`;

    const [hubs, services] = await Promise.all([
      pool.query(`
        SELECT h.hub_name,
               COUNT(pi.id)                      AS invoice_count,
               COALESCE(SUM(pi.grand_total), 0)  AS revenue
          FROM purchase_invoices pi
          JOIN hubs h ON h.id = pi.hub_id
         WHERE ${hubDateWhere}
         GROUP BY h.id, h.hub_name
         ORDER BY revenue DESC NULLS LAST
         LIMIT 8
      `, dateParams),
      pool.query(`
        SELECT s.name AS service_name,
               COUNT(cii.id)                                        AS usage_count,
               COALESCE(SUM(cii.customer_rate * cii.quantity), 0)   AS revenue
          FROM customer_invoice_items cii
          JOIN estimates e        ON e.id  = (SELECT ci.estimate_id FROM customer_invoices ci WHERE ci.id = cii.customer_invoice_id LIMIT 1)
          JOIN estimate_items ei  ON ei.id = cii.estimate_item_id
          JOIN services s         ON s.id  = ei.service_id
         WHERE ${svcDateWhere}
           AND s.id IS NOT NULL
         GROUP BY s.id, s.name
         ORDER BY revenue DESC NULLS LAST
         LIMIT 8
      `, dateParams),
    ]);
    res.json({ top_hubs: hubs.rows, top_services: services.rows });
  } catch (err) { next(err); }
}

// ── Team Performance ──────────────────────────────────────────────────────────
// GET /api/reports/team-performance?period=week|month|all
async function getTeamPerformance(req, res, next) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Resolve period → start date
    const period = req.query.period || 'month';
    let periodStart;
    if (period === 'week') {
      const d = new Date(); d.setDate(d.getDate() - 6);
      periodStart = d.toISOString().split('T')[0];
    } else if (period === 'all') {
      periodStart = '2000-01-01';
    } else {
      periodStart = today.slice(0, 7) + '-01'; // this month
    }

    // Managers (VIEW_TEAM_LEADS only, no MANAGE_USERS, not super admin) see only their own team.
    // Admins / super admins / VIEW_REPORTS users see everyone.
    const isManagerOnly = !req.user.is_super_admin
      && !req.user.permissions.has('MANAGE_USERS')
      && !req.user.permissions.has('VIEW_REPORTS');

    const teamFilter  = isManagerOnly ? 'AND u.manager_id = $3' : '';
    const queryParams = isManagerOnly ? [today, periodStart, req.user.id] : [today, periodStart];

    const rows = await pool.query(
      `SELECT
         u.id   AS user_id,
         u.name AS user_name,

         -- Leads generated (created by user) in period
         (SELECT COUNT(*)::int FROM leads
          WHERE created_by = u.id AND created_at::date >= $2)               AS leads_generated,

         -- Leads assigned to user in period
         (SELECT COUNT(*)::int FROM leads
          WHERE assigned_to = u.id AND created_at::date >= $2)              AS leads_assigned,

         -- Leads converted (has appointment) for user in period
         (SELECT COUNT(*)::int FROM leads l2
          WHERE (l2.created_by = u.id OR l2.assigned_to = u.id)
            AND l2.created_at::date >= $2
            AND EXISTS (
              SELECT 1 FROM appointments a 
              WHERE a.lead_id = l2.id
                AND a.status_id NOT IN (SELECT id FROM appointment_statuses WHERE slug IN ('no-show', 'cancelled'))
            )) AS leads_converted,

         -- Total pending follow-ups on leads belonging to user
         (SELECT COUNT(*)::int FROM lead_events le
          JOIN leads l2 ON l2.id = le.lead_id
          WHERE (l2.assigned_to = u.id OR l2.created_by = u.id)
            AND le.is_done = FALSE)                                          AS followups_total,

         -- Today's follow-ups due for user
         (SELECT COUNT(*)::int FROM lead_events le
          JOIN leads l2 ON l2.id = le.lead_id
          WHERE (l2.assigned_to = u.id OR l2.created_by = u.id)
            AND le.is_done = FALSE
            AND le.due_date = $1)                                            AS followups_today,

         -- Today's leads (created or assigned today)
         (SELECT COUNT(*)::int FROM leads
          WHERE (created_by = u.id OR assigned_to = u.id)
            AND created_at::date = $1)                                       AS today_leads

       FROM users u
       WHERE u.hub_id IS NULL
         AND u.is_super_admin IS NOT TRUE
         ${teamFilter}
       ORDER BY leads_generated DESC`,
      queryParams
    );

    res.json({ items: rows.rows });
  } catch (err) { next(err); }
}

// ── Leads By Source ───────────────────────────────────────────────────────────
// GET /api/reports/leads-by-source?from=&to=&hub_id=
async function getLeadsBySource(req, res, next) {
  try {
    const { from, to, hub_id } = req.query;
    const { userIds } = await resolveScope(req.user);
    const params = [];

    let scopeWhere = '';
    if (userIds) { params.push(userIds); scopeWhere = `l.created_by = ANY($${params.length})`; }

    const dw  = dateParams(from, to, params, 'l.created_at');
    const hub = hub_id ? hubClause(hub_id, params, 'l.created_by', 'l.assigned_to') : '';

    const clauses = [scopeWhere, dw, hub].filter(Boolean);
    const where   = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(l.lead_source), ''), 'Unknown') AS source,
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (
          WHERE l.status IN (SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE)
        )::int                                                 AS converted
      FROM leads l
      ${where}
      GROUP BY COALESCE(NULLIF(TRIM(l.lead_source), ''), 'Unknown')
      ORDER BY total DESC
    `, params);

    res.json({ items: r.rows });
  } catch (err) { next(err); }
}

// ── Leads Over Time ───────────────────────────────────────────────────────────
// GET /api/reports/leads-over-time?from=&to=&group_by=day|week&hub_id=
async function getLeadsOverTime(req, res, next) {
  try {
    const { from, to, hub_id, group_by = 'day' } = req.query;
    const { userIds } = await resolveScope(req.user);
    const params = [];

    // scope
    let scopeWhere = '';
    if (userIds) { params.push(userIds); scopeWhere = `l.created_by = ANY($${params.length})`; }

    // date
    const dw  = dateParams(from, to, params, 'l.created_at');

    // hub — filter by users who belong to that hub
    const hub = hub_id ? hubClause(hub_id, params, 'l.created_by', 'l.assigned_to') : '';

    const clauses = [scopeWhere, dw, hub].filter(Boolean);
    const where   = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const trunc = group_by === 'week' ? 'week' : group_by === 'month' ? 'month' : 'day';

    const r = await pool.query(`
      SELECT
        DATE_TRUNC('${trunc}', l.created_at)::date AS period,
        COUNT(*)::int                               AS count
      FROM leads l
      ${where}
      GROUP BY DATE_TRUNC('${trunc}', l.created_at)
      ORDER BY period ASC
    `, params);

    res.json({ items: r.rows, group_by: trunc });
  } catch (err) { next(err); }
}

module.exports = {
  getDashboardStats, getSummary, getStatusDistribution,
  getCategoryRevenue, getByUser, getUserDetail,
  getRevenueTrend, getConversionFunnel, getTopPerformers,
  getTeamPerformance, getLeadsOverTime, getLeadsBySource,
};
