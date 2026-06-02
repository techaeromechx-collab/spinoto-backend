'use strict';
const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { listPurchaseInvoices, getPurchaseInvoice, generatePurchaseInvoice, approvePurchaseInvoice, addHubPayment, deleteHubPayment, listPayouts, recalculatePurchaseInvoice, listHubPayments, getTechRateSummary, bulkPayment } = require('../controllers/purchase_invoices.controller');
const router = express.Router();

const canView     = requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'VIEW_INVOICE', 'VIEW_PURCHASE_INVOICE');   // hub users: VIEW_INVOICE (or no perms = open)
const canManage   = requirePermission('MANAGE_HUBS', 'APPROVE_PURCHASE_INVOICE');                                // Spinoto staff: MANAGE_HUBS or dedicated approve permission
const canGenerate = requirePermissionOrHub('MANAGE_HUBS', 'CREATE_INVOICE', 'CREATE_PURCHASE_INVOICE');          // hub users: CREATE_INVOICE (or no perms = open)
const canPayment  = requirePermission('ADD_INVOICE_PAYMENT', 'MANAGE_HUBS', 'ADD_PURCHASE_INVOICE_PAYMENT');

router.use(requireAuth);
router.get('/',              canView,     listPurchaseInvoices);
router.get('/payouts',       canView,     listPayouts);
router.get('/hub-payments',      canView, listHubPayments);
router.get('/tech-rate-summary', canView,    getTechRateSummary);
router.post('/bulk-payment',     canPayment, bulkPayment);
router.post('/generate',     canGenerate, generatePurchaseInvoice);
router.get('/:id',           canView,     getPurchaseInvoice);
router.post('/:id/approve',     canManage,   approvePurchaseInvoice);
router.post('/:id/recalculate', canManage,   recalculatePurchaseInvoice);
router.post('/:id/payments',           canPayment, addHubPayment);
router.delete('/:id/payments/:payId',  canPayment, deleteHubPayment);
module.exports = router;
