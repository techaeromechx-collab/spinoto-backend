'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/cc_categories.controller');
const { cacheGet } = require('../utils/responseCache');

const router = express.Router();

// CC categories are read-only reference data needed by the lead capture flow,
// so VIEW_LEAD and CREATE_LEAD users also get read access.
/* requirePermissionOrHub, and the estimate codes alongside the lead ones.
   A CC category is not a secret — it is the engine size band that decides what
   a service costs, and a hub cannot build an estimate without it. It was
   reachable by anyone who could create a LEAD and by nobody on the hub portal,
   which is backwards: the hub is the party actually pricing the job.

   The plain requirePermission was the sharper half of the problem. A hub login
   with ZERO permissions means "open access" everywhere it is honoured — but
   requirePermission asks an empty permission set whether it contains a code,
   gets false, and 403s. So the least restricted hubs were the ones locked out. */
const canView      = [requireAuth, requirePermissionOrHub('VIEW_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'CREATE_CC_CATEGORY', 'EDIT_CC_CATEGORY', 'DELETE_CC_CATEGORY', 'MANAGE_MASTER_DATA', 'CREATE_LEAD', 'VIEW_LEAD', 'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE')];
const canCreate    = [requireAuth, requirePermission('CREATE_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];
const canEdit      = [requireAuth, requirePermission('EDIT_CC_CATEGORY',   'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];
const canDelete    = [requireAuth, requirePermission('DELETE_CC_CATEGORY', 'MANAGE_CC_CATEGORY', 'MANAGE_MASTER_DATA')];

// POST /api/cc-categories/classify must come BEFORE /:id routes
router.post('/classify', canView,   ctrl.classify);

// Shared reference data — cached, invalidated on Master Data edits.
router.get('/',          canView,   cacheGet('cc_categories'), ctrl.listCategories);
router.post('/',         canCreate, ctrl.createCategory);
router.put('/:id',       canEdit,   ctrl.updateCategory);
router.delete('/:id',    canDelete, ctrl.deleteCategory);

module.exports = router;
