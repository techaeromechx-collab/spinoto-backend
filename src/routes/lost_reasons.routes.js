'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/lost_reasons.controller');

const router = express.Router();

// Read — anyone who can work a lead needs the list, because the popup shows it.
router.get('/', requireAuth, requirePermission('VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD', 'MANAGE_MASTER_DATA'), c.listReasons);

// Manage — master data admins only.
router.post('/reorder', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.reorderReasons);
router.post('/',        requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.createReason);
router.patch('/:id',    requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.updateReason);
router.delete('/:id',   requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.deleteReason);

module.exports = router;
