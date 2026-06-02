'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/cc_categories.controller');

const router = express.Router();

// CC categories are read-only reference data needed by the lead capture flow,
// so VIEW_LEAD and CREATE_LEAD users also get read access.
const canView   = [requireAuth, requirePermission('VIEW_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA', 'CREATE_LEAD', 'VIEW_LEAD')];
const canManage = [requireAuth, requirePermission('MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];

// POST /api/cc-categories/classify must come BEFORE /:id routes
router.post('/classify', canView,   ctrl.classify);

router.get('/',          canView,   ctrl.listCategories);
router.post('/',         canManage, ctrl.createCategory);
router.put('/:id',       canManage, ctrl.updateCategory);
router.delete('/:id',    canManage, ctrl.deleteCategory);

module.exports = router;
