'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/discount_master.controller');

const router = express.Router();

const canRead   = [requireAuth, requirePermission('MANAGE_DISCOUNTS', 'CREATE_DISCOUNT', 'EDIT_DISCOUNT', 'DELETE_DISCOUNT', 'MANAGE_MASTER_DATA','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','CREATE_LEAD','VIEW_LEAD')];
const canCreate = [requireAuth, requirePermission('CREATE_DISCOUNT', 'MANAGE_DISCOUNTS', 'MANAGE_MASTER_DATA')];
const canEdit   = [requireAuth, requirePermission('EDIT_DISCOUNT',   'MANAGE_DISCOUNTS', 'MANAGE_MASTER_DATA')];
const canDelete = [requireAuth, requirePermission('DELETE_DISCOUNT', 'MANAGE_DISCOUNTS', 'MANAGE_MASTER_DATA')];

router.get('/',         canRead,   c.listDiscounts);
router.get('/lookup',   canRead,   c.lookupDiscount);   // ?service_id=&part_id=&category_id=
router.get('/:id',      canRead,   c.getDiscount);
router.post('/',        canCreate, c.createDiscount);
router.patch('/:id',    canEdit,   c.updateDiscount);
router.delete('/:id',   canDelete, c.deleteDiscount);

module.exports = router;
