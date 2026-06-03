'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/customers.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
// VIEW_LEAD is also accepted so agents who can see leads can see the customer profile
const canView        = [requireAuth, requirePermission('VIEW_CUSTOMER', 'EDIT_CUSTOMER', 'ADD_CUSTOMER_VEHICLE', 'EDIT_CUSTOMER_VEHICLE', 'DELETE_CUSTOMER_VEHICLE', 'VIEW_LEAD')];
const canEditDetail  = [requireAuth, requirePermission('EDIT_CUSTOMER')];
const canAddVehicle  = [requireAuth, requirePermission('ADD_CUSTOMER_VEHICLE',    'EDIT_CUSTOMER')];
const canEditVehicle = [requireAuth, requirePermission('EDIT_CUSTOMER_VEHICLE',   'EDIT_CUSTOMER')];
const canDelVehicle  = [requireAuth, requirePermission('DELETE_CUSTOMER_VEHICLE', 'EDIT_CUSTOMER')];

router.get('/',        ...canView, ctrl.listCustomers);

// Vehicle sub-routes — must be before /:mobile to avoid param clash
router.get   ('/:mobile/timeline',     ...canView,        ctrl.getCustomerTimeline);
router.get   ('/:mobile/vehicles',     ...canView,        ctrl.listCustomerVehicles);
router.post  ('/:mobile/vehicles',     ...canAddVehicle,  ctrl.addCustomerVehicle);
router.put   ('/:mobile/vehicles/:id', ...canEditVehicle, ctrl.updateCustomerVehicle);
router.delete('/:mobile/vehicles/:id', ...canDelVehicle,  ctrl.deleteCustomerVehicle);

router.get   ('/:mobile', ...canView,       ctrl.getCustomer);
router.put   ('/:mobile', ...canEditDetail, ctrl.updateCustomer);
router.delete('/:mobile', ...canEditDetail, ctrl.deleteCustomer);

module.exports = router;
