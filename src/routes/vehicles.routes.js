const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/vehicles.controller');

const router = express.Router();

// ── Flat vehicle records (type + make + model + segment + body_type) ──────────
// NOTE: /records routes must come BEFORE the /:id wildcard routes below.

router.get(
  '/records',
  requireAuth,
  // Hub users need vehicle records for estimate creation — accept estimate permissions as implicit VIEW_VEHICLE
  requirePermissionOrHub('VIEW_VEHICLE', 'MANAGE_MASTER_DATA', 'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE'),
  c.listVehicleRecords
);
router.post(
  '/records',
  requireAuth,
  requirePermission('CREATE_VEHICLE', 'MANAGE_MASTER_DATA'),
  c.createVehicleRecord
);
router.patch(
  '/records/:id',
  requireAuth,
  requirePermission('UPDATE_VEHICLE', 'MANAGE_MASTER_DATA'),
  c.updateVehicleRecord
);
router.delete(
  '/records/:id',
  requireAuth,
  requirePermission('DELETE_VEHICLE', 'MANAGE_MASTER_DATA'),
  c.deleteVehicleRecord
);

// ── Reference list reads — any authenticated user ─────────────────────────────
router.get('/types',      requireAuth, c.listTypes);
router.get('/makes',      requireAuth, c.listMakes);
router.get('/models',     requireAuth, c.listModels);
router.get('/segments',   requireAuth, c.listSegments);
router.get('/body-types', requireAuth, c.listBodyTypes);

// ── Reference list writes — MANAGE_MASTER_DATA or granular vehicle perms ──────
const canManage  = [requireAuth, requirePermission('MANAGE_MASTER_DATA', 'CREATE_VEHICLE', 'UPDATE_VEHICLE')];
const canDestroy = [requireAuth, requirePermission('MANAGE_MASTER_DATA', 'DELETE_VEHICLE')];

// Vehicle Types — full CRUD (FK will block if in use)
router.post  ('/types',        canManage,  c.createType);
router.patch ('/types/:id',    canManage,  c.updateType);
router.delete('/types/:id',    canDestroy, c.deleteType);

// Makes & Models — full CRUD (hard delete allowed, FK will block if in use)
router.post  ('/makes',        canManage,  c.createMake);
router.patch ('/makes/:id',    canManage,  c.updateMake);
router.delete('/makes/:id',    canDestroy, c.deleteMake);

router.post  ('/models',       canManage,  c.createModel);
router.patch ('/models/:id',   canManage,  c.updateModel);
router.delete('/models/:id',   canDestroy, c.deleteModel);

// Segments — full CRUD (FK will block if in use)
router.post  ('/segments',     canManage,  c.createSegment);
router.patch ('/segments/:id', canManage,  c.updateSegment);
router.delete('/segments/:id', canDestroy, c.deleteSegment);

// Body Types — full CRUD (FK will block if in use)
router.post  ('/body-types',     canManage,  c.createBodyType);
router.patch ('/body-types/:id', canManage,  c.updateBodyType);
router.delete('/body-types/:id', canDestroy, c.deleteBodyType);

module.exports = router;
