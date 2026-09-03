'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const { listEvents, tabCounts, pendingCount, markDone, getCompliance, getStats } = require('../controllers/lead_events.controller');

const router = express.Router();

const canFollowUp  = requirePermission('MANAGE_FOLLOW_UPS', 'VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD', 'EDIT_LEAD');
const canCompliance = requirePermission('MANAGE_FOLLOW_UPS', 'VIEW_REPORTS');

router.use(requireAuth);

router.get('/',              canFollowUp,   listEvents);
/* Badges on the Follow-ups tabs. Same permission as the list it sits above —
   a count is a fact about rows you are allowed to see, and it is scoped by the
   same three-way rule inside the controller. Before /:id, like the rest. */
router.get('/tab-counts',    canFollowUp,   tabCounts);
router.get('/pending-count', canFollowUp,   pendingCount);
router.get('/stats',         canFollowUp,   getStats);        // must be before /:id
router.get('/compliance',    canCompliance, getCompliance);   // must be before /:id
router.patch('/:id/done',    canFollowUp,   markDone);

module.exports = router;
