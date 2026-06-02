'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/customers.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
// VIEW_LEAD is also accepted so agents who can see leads can see the customer profile
const canView  = [requireAuth, requirePermission('VIEW_CUSTOMER', 'EDIT_CUSTOMER', 'VIEW_LEAD')];
// Write operations require explicit EDIT_CUSTOMER permission — VIEW_CUSTOMER alone is read-only
const canWrite = [requireAuth, requirePermission('EDIT_CUSTOMER')];

router.get('/',        ...canView, ctrl.listCustomers);

// Vehicle sub-routes — must be before /:mobile to avoid param clash
router.get   ('/:mobile/timeline',     ...canView,  ctrl.getCustomerTimeline);
router.get   ('/:mobile/vehicles',     ...canView,  ctrl.listCustomerVehicles);
router.post  ('/:mobile/vehicles',     ...canWrite, ctrl.addCustomerVehicle);
router.put   ('/:mobile/vehicles/:id', ...canWrite, ctrl.updateCustomerVehicle);
router.delete('/:mobile/vehicles/:id', ...canWrite, ctrl.deleteCustomerVehicle);

router.get   ('/:mobile', ...canView,  ctrl.getCustomer);
router.put   ('/:mobile', ...canWrite, ctrl.updateCustomer);
router.delete('/:mobile', ...canWrite, ctrl.deleteCustomer);

module.exports = router;
