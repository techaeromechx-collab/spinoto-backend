'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/lead_statuses.controller');

const router = express.Router();

// Read — anyone who works with leads can read statuses
router.get('/',     requireAuth, requirePermission('VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD', 'MANAGE_MASTER_DATA'), c.listStatuses);
// Manage — only master data admins
router.post('/reorder', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.reorderStatuses);
router.post('/',        requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.createStatus);
router.patch('/:id', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.updateStatus);
router.delete('/:id', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.deleteStatus);

module.exports = router;
