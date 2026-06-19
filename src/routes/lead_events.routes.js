'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const { listEvents, pendingCount, markDone, getCompliance, getStats } = require('../controllers/lead_events.controller');

const router = express.Router();

const canFollowUp  = requirePermission('MANAGE_FOLLOW_UPS', 'VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD', 'EDIT_LEAD');
const canCompliance = requirePermission('MANAGE_FOLLOW_UPS', 'VIEW_REPORTS');

router.use(requireAuth);

router.get('/',              canFollowUp,   listEvents);
router.get('/pending-count', canFollowUp,   pendingCount);
router.get('/stats',         canFollowUp,   getStats);        // must be before /:id
router.get('/compliance',    canCompliance, getCompliance);   // must be before /:id
router.patch('/:id/done',    canFollowUp,   markDone);

module.exports = router;
