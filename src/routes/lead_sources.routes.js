'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/lead_sources.controller');

const router = express.Router();

const canView   = requirePermission('VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD', 'MANAGE_MASTER_DATA');
const canManage = requirePermission('MANAGE_MASTER_DATA');

router.get('/',          requireAuth, canView,   c.listSources);
router.post('/reorder',  requireAuth, canManage, c.reorderSources);
router.post('/',         requireAuth, canManage, c.createSource);
router.patch('/:id',     requireAuth, canManage, c.updateSource);
router.delete('/:id',    requireAuth, canManage, c.deleteSource);

module.exports = router;
