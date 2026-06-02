'use strict';

const { Router } = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/logs.controller');

const router = Router();

// Super Admin only
router.use(requireAuth, requireSuperAdmin);

router.get('/logins',   ctrl.getLoginLogs);
router.get('/activity', ctrl.getActivityLogs);

module.exports = router;
