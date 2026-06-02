'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/invoices.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
const canView   = [requireAuth, requirePermission('VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE')];
const canCreate = [requireAuth, requirePermission('CREATE_INVOICE')];
const canEdit   = [requireAuth, requirePermission('EDIT_INVOICE')];

router.get   ('/',                        ...canView,   ctrl.listInvoices);
router.post  ('/',                        ...canCreate, ctrl.createInvoice);
router.get   ('/vehicle-history/:vnum',   ...canView,   ctrl.getVehicleHistory);
router.get   ('/:id',                     ...canView,   ctrl.getInvoice);
router.patch ('/:id',                     ...canEdit,   ctrl.updateInvoice);

module.exports = router;
