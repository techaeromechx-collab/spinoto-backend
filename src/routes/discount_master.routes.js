'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/discount_master.controller');

const router = express.Router();

const canRead  = [requireAuth, requirePermission('MANAGE_DISCOUNTS', 'MANAGE_MASTER_DATA','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','CREATE_LEAD','VIEW_LEAD')];
const canWrite = [requireAuth, requirePermission('MANAGE_DISCOUNTS', 'MANAGE_MASTER_DATA')];

router.get('/',         canRead,  c.listDiscounts);
router.get('/lookup',   canRead,  c.lookupDiscount);   // ?service_id=&part_id=&category_id=
router.get('/:id',      canRead,  c.getDiscount);
router.post('/',        canWrite, c.createDiscount);
router.patch('/:id',    canWrite, c.updateDiscount);
router.delete('/:id',   canWrite, c.deleteDiscount);

module.exports = router;
