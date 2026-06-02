'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/invoice_statuses.controller');

router.get   ('/',          requireAuth, requirePermission('VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','MANAGE_MASTER_DATA'), ctrl.listStatuses);
router.post  ('/',          requireAuth, requirePermission('MANAGE_MASTER_DATA'), ctrl.createStatus);
router.patch ('/:id',       requireAuth, requirePermission('MANAGE_MASTER_DATA'), ctrl.updateStatus);
router.delete('/:id',       requireAuth, requirePermission('MANAGE_MASTER_DATA'), ctrl.deleteStatus);
router.post  ('/reorder',   requireAuth, requirePermission('MANAGE_MASTER_DATA'), ctrl.reorderStatuses);

module.exports = router;
