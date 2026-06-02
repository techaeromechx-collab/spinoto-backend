const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/reports.controller');

const router = express.Router();

const canView = [requireAuth, requirePermission('VIEW_REPORTS')];

router.get('/dashboard',           canView, c.getDashboardStats);
router.get('/summary',             canView, c.getSummary);
router.get('/status-distribution', canView, c.getStatusDistribution);
router.get('/category-revenue',    canView, c.getCategoryRevenue);
router.get('/by-user',             canView, c.getByUser);
router.get('/user-detail/:userId', canView, c.getUserDetail);

// Analytics endpoints
router.get('/analytics/revenue-trend',   canView, c.getRevenueTrend);
router.get('/analytics/funnel',          canView, c.getConversionFunnel);
router.get('/analytics/top-performers',  canView, c.getTopPerformers);

module.exports = router;
