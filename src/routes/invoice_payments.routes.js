'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true }); // inherit :id from parent
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/invoice_payments.controller');

// ── Permission sets ───────────────────────────────────────────────────────────
// Viewing payments is part of viewing an invoice
const canView   = [requireAuth, requirePermission('VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'ADD_INVOICE_PAYMENT')];
const canManage = [requireAuth, requirePermission('ADD_INVOICE_PAYMENT', 'EDIT_INVOICE')];

router.get   ('/',        ...canView,   ctrl.listPayments);
router.post  ('/',        ...canManage, ctrl.addPayment);
router.delete('/:payId',  ...canManage, ctrl.deletePayment);

module.exports = router;
