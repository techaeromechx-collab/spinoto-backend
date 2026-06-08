'use strict';

const { Router } = require('express');
const { requireAuth, requireSuperAdmin, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/logs.controller');

const router = Router();

router.use(requireAuth);

// Login logs — super admin only
router.get('/logins',   requireSuperAdmin, ctrl.getLoginLogs);

// Activity log — super admin OR users with VIEW_DASHBOARD_ACTIVITIES
router.get('/activity', requirePermission('VIEW_DASHBOARD_ACTIVITIES'), ctrl.getActivityLogs);

module.exports = router;
