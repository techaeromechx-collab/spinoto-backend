'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/lead_notes.controller');

const router = express.Router({ mergeParams: true });

// GET  /api/lead-notes/:leadId  — anyone who can view leads can see notes
router.get ('/:leadId', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.listNotes);

// POST /api/lead-notes/:leadId  — only users who can edit leads can add notes
router.post('/:leadId', requireAuth, requirePermission('EDIT_LEAD'), c.addNote);

module.exports = router;
