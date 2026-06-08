const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/reports.controller');

const router = express.Router();

const canView        = [requireAuth, requirePermission('VIEW_REPORTS')];
const canViewRevenue = [requireAuth, requirePermission('VIEW_REPORTS', 'VIEW_DASHBOARD_REVENUE')];
const canViewLeads   = [requireAuth, requirePermission('VIEW_REPORTS', 'VIEW_DASHBOARD_LEADS')];
const canViewInvoice = [requireAuth, requirePermission('VIEW_REPORTS', 'VIEW_DASHBOARD_INVOICES')];
const canViewAppts   = [requireAuth, requirePermission('VIEW_REPORTS', 'VIEW_DASHBOARD_APPOINTMENTS')];
const canViewAny     = [requireAuth, requirePermission(
  'VIEW_REPORTS',
  'VIEW_DASHBOARD_REVENUE', 'VIEW_DASHBOARD_LEADS', 'VIEW_DASHBOARD_INVOICES',
  'VIEW_DASHBOARD_APPOINTMENTS', 'VIEW_DASHBOARD_FOLLOWUPS',
)];
const canViewTeamPerf = [requireAuth, requirePermission(
  'VIEW_REPORTS', 'VIEW_DASHBOARD_TEAM_PERFORMANCE', 'VIEW_TEAM_LEADS', 'MANAGE_USERS',
)];

router.get('/dashboard',           canViewAny,     c.getDashboardStats);
router.get('/summary',             canViewAny,     c.getSummary);
router.get('/status-distribution', canViewLeads,   c.getStatusDistribution);
router.get('/category-revenue',    canViewRevenue, c.getCategoryRevenue);
router.get('/by-user',             canView,        c.getByUser);
router.get('/user-detail/:userId', canView,        c.getUserDetail);

// Analytics endpoints
router.get('/analytics/revenue-trend',   canViewRevenue,  c.getRevenueTrend);
router.get('/analytics/funnel',          canViewLeads,    c.getConversionFunnel);
router.get('/analytics/top-performers',  canViewRevenue,  c.getTopPerformers);
router.get('/analytics/leads-over-time', canViewLeads,    c.getLeadsOverTime);
router.get('/analytics/leads-by-source', canViewLeads,    c.getLeadsBySource);
router.get('/team-performance',          canViewTeamPerf, c.getTeamPerformance);

module.exports = router;
