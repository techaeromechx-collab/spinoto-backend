'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/cc_categories.controller');

const router = express.Router();

// CC categories are read-only reference data needed by the lead capture flow,
// so VIEW_LEAD and CREATE_LEAD users also get read access.
const canView      = [requireAuth, requirePermission('VIEW_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'CREATE_CC_CATEGORY', 'EDIT_CC_CATEGORY', 'DELETE_CC_CATEGORY', 'MANAGE_MASTER_DATA', 'CREATE_LEAD', 'VIEW_LEAD')];
const canCreate    = [requireAuth, requirePermission('CREATE_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];
const canEdit      = [requireAuth, requirePermission('EDIT_CC_CATEGORY',   'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];
const canDelete    = [requireAuth, requirePermission('DELETE_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];

// POST /api/cc-categories/classify must come BEFORE /:id routes
router.post('/classify', canView,   ctrl.classify);

router.get('/',          canView,   ctrl.listCategories);
router.post('/',         canCreate, ctrl.createCategory);
router.put('/:id',       canEdit,   ctrl.updateCategory);
router.delete('/:id',    canDelete, ctrl.deleteCategory);

module.exports = router;
