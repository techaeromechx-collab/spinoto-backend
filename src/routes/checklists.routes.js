'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/checklists.controller');

const router = express.Router();

/* MANAGE_MASTER_DATA, not a new permission. A checklist template is master
   data in the ordinary sense — the same class of thing as services, vehicle
   models and lead sources — and a fresh permission granted to no role would
   only have to be handed out again to the people who already hold this one.
 *
 * requirePermission, not requirePermissionOrHub: hubs FILL checklists in, they
 * do not design them. A zero-permission hub login would otherwise be waved
 * through. The controller refuses hub users again in case this line is ever
 * copied to a route that uses the OrHub variant. */
const canManage = [requireAuth, requirePermission('MANAGE_MASTER_DATA')];

// Templates
router.get   ('/',               canManage, c.listTemplates);
router.post  ('/',               canManage, c.createTemplate);
router.get   ('/:id',            canManage, c.getTemplate);
router.patch ('/:id',            canManage, c.updateTemplate);
router.delete('/:id',            canManage, c.deleteTemplate);
router.post  ('/:id/duplicate',  canManage, c.duplicateTemplate);

/* Before '/:id' would have been wrong for the literal segments below, but all
   of these carry their own prefix after the id, so ordering is not load-
   bearing here. Kept grouped by what they act on instead. */

// Groups
router.post  ('/:id/groups',          canManage, c.createGroup);
router.patch ('/groups/:groupId',     canManage, c.updateGroup);
router.delete('/groups/:groupId',     canManage, c.deleteGroup);

// Points — a point's three outcome labels are edited with it, not separately
router.post  ('/groups/:groupId/points', canManage, c.createPoint);
router.patch ('/points/:pointId',        canManage, c.updatePoint);
router.delete('/points/:pointId',        canManage, c.deletePoint);

// One call for a whole drag, so a dropped connection cannot half-sort a sheet
router.patch ('/:id/reorder',         canManage, c.reorder);

module.exports = router;
