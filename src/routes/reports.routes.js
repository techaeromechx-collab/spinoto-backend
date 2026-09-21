const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/reports.controller');
const gstr1 = require('../controllers/gstr1.controller');

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
/* canViewRevenue, not canViewLeads: this returns what was quoted, what the
   hubs cost and the margin between them. Counts of appointments would be
   harmless; the money beside them is not, and the permission has to match the
   most sensitive thing in the response rather than the least. */
router.get('/pipeline-summary',    canViewRevenue, c.getPipelineSummary);
router.get('/by-user',             canView,        c.getByUser);
router.get('/user-detail/:userId', canView,        c.getUserDetail);

// Analytics endpoints
router.get('/hub-revenue',               canViewRevenue,  c.getHubRevenue);
router.get('/analytics/revenue-trend',   canViewRevenue,  c.getRevenueTrend);
router.get('/analytics/funnel',          canViewLeads,    c.getConversionFunnel);
router.get('/analytics/top-performers',  canViewRevenue,  c.getTopPerformers);
router.get('/analytics/leads-over-time', canViewLeads,    c.getLeadsOverTime);
router.get('/analytics/leads-by-source', canViewLeads,    c.getLeadsBySource);
router.get('/team-performance',          canViewTeamPerf, c.getTeamPerformance);

/* GSTR-1. canViewInvoice, not canViewRevenue: the response is the invoice
   ledger for a period — every customer name, every B2B GSTIN — so the
   permission that matches it is the one that governs invoices. The controller
   additionally refuses hub logins outright; a company GST return has no
   correct hub-scoped version. */
router.get('/gstr1',                     canViewInvoice,  gstr1.getGstr1);

module.exports = router;
