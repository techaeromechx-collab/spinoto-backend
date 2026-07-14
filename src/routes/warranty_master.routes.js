'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/warranty_master.controller');

const router = express.Router();

// Read/lookup uses requirePermissionOrHub so hub users (who can create
// estimates via requirePermissionOrHub on the estimates routes) can also
// resolve auto-warranties — same pattern as discount_master.routes.js.
const canRead   = [requireAuth, requirePermissionOrHub('MANAGE_WARRANTIES', 'CREATE_WARRANTY', 'EDIT_WARRANTY', 'DELETE_WARRANTY', 'MANAGE_MASTER_DATA','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','CREATE_LEAD','VIEW_LEAD')];
const canCreate = [requireAuth, requirePermission('CREATE_WARRANTY', 'MANAGE_WARRANTIES', 'MANAGE_MASTER_DATA')];
const canEdit   = [requireAuth, requirePermission('EDIT_WARRANTY',   'MANAGE_WARRANTIES', 'MANAGE_MASTER_DATA')];
const canDelete = [requireAuth, requirePermission('DELETE_WARRANTY', 'MANAGE_WARRANTIES', 'MANAGE_MASTER_DATA')];

router.get('/',          canRead, c.listWarranties);
router.get('/lookup',    canRead, c.lookupWarranty);       // ?service_id=&part_id=&category_id=&vehicle_type_id=
router.get('/effective', canRead, c.effectiveForService);  // ?service_id=&category_id= — Services page coverage tags
router.get('/:id',    canRead,   c.getWarranty);
router.post('/',      canCreate, c.createWarranty);
router.patch('/:id',  canEdit,   c.updateWarranty);
router.delete('/:id', canDelete, c.deleteWarranty);

module.exports = router;
