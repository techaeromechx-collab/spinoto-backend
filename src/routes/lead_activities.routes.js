'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/lead_activities.controller');

const router = express.Router({ mergeParams: true });

// GET /api/lead-activities/:leadId  — anyone who can view leads can see the timeline
router.get('/:leadId', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.listActivities);

module.exports = router;
