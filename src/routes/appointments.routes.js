'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const ctrl = require('../controllers/appointments.controller');

// This router has no router.use(requireAuth) — each route carries it in its own
// permission array — so the mask is appended to those arrays instead. It must
// run after requireAuth, which it does: it is last in each list.
// ── Permission sets ───────────────────────────────────────────────────────────
// canView: staff with any appointment perm OR hub users (view their own appointments)
const canView   = [requireAuth, requirePermissionOrHub('VIEW_APPOINTMENT', 'CREATE_APPOINTMENT', 'EDIT_APPOINTMENT'), maskCustomerContact];
const canCreate = [requireAuth, requirePermission('CREATE_APPOINTMENT'), maskCustomerContact];
const canEdit   = [requireAuth, requirePermission('EDIT_APPOINTMENT'), maskCustomerContact];
// Deletion nukes the whole chain (estimate → PI → CI → claims) — own permission
const canDelete = [requireAuth, requirePermission('DELETE_APPOINTMENT'), maskCustomerContact];

// Stats must be defined before /:id so Express doesn't treat "stats" as an id param
router.get   ('/stats', ...canView,   ctrl.getStats);
// Same reason as /stats above: a literal segment, so it must sit before '/:id'.
router.get   ('/calendar', ...canView, ctrl.listAppointmentsCalendar);

router.get   ('/',      ...canView,   ctrl.listAppointments);
router.post  ('/',      ...canCreate, ctrl.createAppointment);
// by-token — resolves a shareable-URL token; must be before /:id
router.get   ('/by-token/:token', ...canView, ctrl.getAppointmentByToken);
router.get   ('/:id',   ...canView,   ctrl.getAppointment);
router.get   ('/:id/delete-preview', ...canDelete, ctrl.deletePreview);
router.delete('/:id',   ...canDelete, ctrl.deleteAppointment);
router.patch ('/:id',   ...canEdit,   ctrl.updateAppointment);

// ── Manual pickup flow status advances ───────────────────────────────────────
router.post('/:id/vehicle-picked', ...canEdit, ctrl.markVehiclePicked);
router.post('/:id/at-workshop',    ...canEdit, ctrl.markAtWorkshop);

module.exports = router;
