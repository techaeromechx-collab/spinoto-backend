'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const ctrl = require('../controllers/customers.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
// VIEW_LEAD is also accepted so agents who can see leads can see the customer profile
const canView        = [requireAuth, requirePermission('VIEW_CUSTOMER', 'EDIT_CUSTOMER', 'ADD_CUSTOMER_VEHICLE', 'EDIT_CUSTOMER_VEHICLE', 'DELETE_CUSTOMER_VEHICLE', 'VIEW_LEAD')];
const canEditDetail  = [requireAuth, requirePermission('EDIT_CUSTOMER')];
const canAddVehicle  = [requireAuth, requirePermission('ADD_CUSTOMER_VEHICLE',    'EDIT_CUSTOMER')];
const canEditVehicle = [requireAuth, requirePermission('EDIT_CUSTOMER_VEHICLE',   'EDIT_CUSTOMER')];
const canDelVehicle  = [requireAuth, requirePermission('DELETE_CUSTOMER_VEHICLE', 'EDIT_CUSTOMER')];

// The routes a hub-portal login is allowed to reach.
//
// requirePermissionOrHub, unlike everything else in this file — a hub raising a
// direct estimate has to be able to find the customer standing in front of it.
// Otherwise it retypes the mobile by hand, and one wrong digit creates a second
// customer that nothing in this system can merge back.
//
// What keeps that safe is the controller, not the gate: for a hub caller the
// lookup matches a COMPLETE mobile or registration number only, never a name,
// and returns nothing but name, whatsapp and vehicles. There is no browsing
// surface — a partial number returns nothing at all.
const canPick = [requireAuth, requirePermissionOrHub(
  'VIEW_CUSTOMER', 'EDIT_CUSTOMER', 'ADD_CUSTOMER_VEHICLE', 'EDIT_CUSTOMER_VEHICLE',
  'DELETE_CUSTOMER_VEHICLE', 'VIEW_LEAD',
  'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE',
)];

// Second line of defence behind the exact-match rule: one lookup yields one
// name, and this caps how fast anyone could work through a number range.
const pickLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

// Static routes BEFORE /:mobile, or "lookup" is captured as a mobile number.
router.get('/lookup',  ...canPick, pickLimit, ctrl.lookupCustomers);

router.get('/',        ...canView, ctrl.listCustomers);

// by-token — resolves a shareable-URL token to a customer (via
// customer_identities); grouped with the other sub-routes below.
router.get   ('/by-token/:token',      ...canView,        ctrl.getCustomerByToken);

// Vehicle sub-routes — must be before /:mobile to avoid param clash
router.get   ('/:mobile/timeline',     ...canView,        ctrl.getCustomerTimeline);
router.get   ('/:mobile/vehicle-usage', ...canView,       ctrl.getVehicleUsage);
// Readable by a hub: it already had to know the complete mobile number to get
// here, and this returns cars — not visits, spend, or which hub serviced them.
router.get   ('/:mobile/vehicles',     ...canPick, pickLimit, ctrl.listCustomerVehicles);
router.post  ('/:mobile/vehicles',     ...canAddVehicle,  ctrl.addCustomerVehicle);
router.put   ('/:mobile/vehicles/:id', ...canEditVehicle, ctrl.updateCustomerVehicle);
router.delete('/:mobile/vehicles/:id', ...canDelVehicle,  ctrl.deleteCustomerVehicle);

router.get   ('/:mobile', ...canView,       ctrl.getCustomer);
// Staff only, deliberately. This is an upsert on mobile, so a hub typing "Raj"
// for a number your staff saved as "Rajesh Kumar" would rename that customer
// everywhere. Hubs put the name on the estimate instead, which carries its own
// copy — see createEstimate.
router.put   ('/:mobile', ...canEditDetail, ctrl.updateCustomer);
router.delete('/:mobile', ...canEditDetail, ctrl.deleteCustomer);

module.exports = router;
