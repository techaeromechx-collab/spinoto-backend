'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/call_outcomes.controller');

const router = express.Router();

// Anyone working with leads can read the active outcomes list
router.get('/', requireAuth, requirePermission('VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD', 'MANAGE_MASTER_DATA'), c.listOutcomes);

// Manage — master data admins only
router.post('/reorder', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.reorderOutcomes);
router.post('/',        requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.createOutcome);
router.patch('/:id',    requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.updateOutcome);
router.delete('/:id',   requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.deleteOutcome);

module.exports = router;
