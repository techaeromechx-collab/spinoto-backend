const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/vehicles.controller');
const { cacheGet } = require('../utils/responseCache');

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

// ── Reference list reads — VIEW_REFERENCE_DATA or any managing permission ─────
const canViewRef = [requireAuth, requirePermission(
  'VIEW_REFERENCE_DATA', 'MANAGE_VEHICLE_TYPES', 'MANAGE_BODY_TYPES', 'MANAGE_SEGMENTS',
  'VIEW_CC_CATEGORY', 'CREATE_CC_CATEGORY', 'EDIT_CC_CATEGORY', 'DELETE_CC_CATEGORY', 'MANAGE_CC_CATEGORY',
  'MANAGE_MASTER_DATA', 'CREATE_VEHICLE', 'UPDATE_VEHICLE', 'DELETE_VEHICLE',
  'VIEW_VEHICLE', 'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE', 'CREATE_LEAD',
)];
// Reference lists are shared/non-per-user and change rarely — cache the
// rendered JSON, keyed per full URL (so e.g. ?type_class=2W vs 4W never
// collide), and let socket.js's invalidate-emit wrap clear it the moment
// someone edits Master Data.
router.get('/types',      canViewRef, cacheGet('vehicles'), c.listTypes);
router.get('/makes',      canViewRef, cacheGet('vehicles'), c.listMakes);
router.get('/models',     canViewRef, cacheGet('vehicles'), c.listModels);
router.get('/segments',   canViewRef, cacheGet('vehicles'), c.listSegments);
router.get('/body-types', canViewRef, cacheGet('vehicles'), c.listBodyTypes);

// ── Reference list writes — granular permissions per data type ────────────────
const canManageTypes    = [requireAuth, requirePermission('MANAGE_VEHICLE_TYPES', 'MANAGE_MASTER_DATA')];
const canManageBodyTypes= [requireAuth, requirePermission('MANAGE_BODY_TYPES',    'MANAGE_MASTER_DATA')];
const canManageSegments = [requireAuth, requirePermission('MANAGE_SEGMENTS',      'MANAGE_MASTER_DATA')];
const canDestroyTypes   = [requireAuth, requirePermission('MANAGE_VEHICLE_TYPES', 'MANAGE_MASTER_DATA')];
const canDestroyBody    = [requireAuth, requirePermission('MANAGE_BODY_TYPES',    'MANAGE_MASTER_DATA')];
const canDestroySegs    = [requireAuth, requirePermission('MANAGE_SEGMENTS',      'MANAGE_MASTER_DATA')];

// Makes & Models still use MANAGE_MASTER_DATA (no granular perm for makes/models)
const canManageMakes = [requireAuth, requirePermission('MANAGE_MASTER_DATA', 'CREATE_VEHICLE', 'UPDATE_VEHICLE')];
const canDestroyMakes= [requireAuth, requirePermission('MANAGE_MASTER_DATA', 'DELETE_VEHICLE')];

// Vehicle Types — full CRUD
router.post  ('/types',        canManageTypes,  c.createType);
router.patch ('/types/:id',    canManageTypes,  c.updateType);
router.delete('/types/:id',    canDestroyTypes, c.deleteType);

// Makes & Models — full CRUD
router.post  ('/makes',        canManageMakes,  c.createMake);
router.patch ('/makes/:id',    canManageMakes,  c.updateMake);
router.delete('/makes/:id',    canDestroyMakes, c.deleteMake);

router.post  ('/models',       canManageMakes,  c.createModel);
router.patch ('/models/:id',   canManageMakes,  c.updateModel);
router.delete('/models/:id',   canDestroyMakes, c.deleteModel);

// Segments — full CRUD
router.post  ('/segments',     canManageSegments, c.createSegment);
router.patch ('/segments/:id', canManageSegments, c.updateSegment);
router.delete('/segments/:id', canDestroySegs,    c.deleteSegment);

// Body Types — full CRUD
router.post  ('/body-types',     canManageBodyTypes, c.createBodyType);
router.patch ('/body-types/:id', canManageBodyTypes, c.updateBodyType);
router.delete('/body-types/:id', canDestroyBody,     c.deleteBodyType);

module.exports = router;
