'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/appointments.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
// canView: staff with any appointment perm OR hub users (view their own appointments)
const canView   = [requireAuth, requirePermissionOrHub('VIEW_APPOINTMENT', 'CREATE_APPOINTMENT', 'EDIT_APPOINTMENT')];
const canCreate = [requireAuth, requirePermission('CREATE_APPOINTMENT')];
const canEdit   = [requireAuth, requirePermission('EDIT_APPOINTMENT')];

// Stats must be defined before /:id so Express doesn't treat "stats" as an id param
router.get   ('/stats', ...canView,   ctrl.getStats);

router.get   ('/',      ...canView,   ctrl.listAppointments);
router.post  ('/',      ...canCreate, ctrl.createAppointment);
router.get   ('/:id',   ...canView,   ctrl.getAppointment);
router.patch ('/:id',   ...canEdit,   ctrl.updateAppointment);

// ── Manual pickup flow status advances ───────────────────────────────────────
router.post('/:id/vehicle-picked', ...canEdit, ctrl.markVehiclePicked);
router.post('/:id/at-workshop',    ...canEdit, ctrl.markAtWorkshop);

module.exports = router;
