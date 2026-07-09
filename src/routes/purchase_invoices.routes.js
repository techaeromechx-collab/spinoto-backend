'use strict';
const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { listPurchaseInvoices, getPurchaseInvoice, generatePurchaseInvoice, approvePurchaseInvoice, rejectPurchaseInvoiceApproval, updatePurchaseInvoice, addHubPayment, deleteHubPayment, listPayouts, recalculatePurchaseInvoice, syncPurchaseInvoiceFromEstimate, listHubPayments, getTechRateSummary, bulkPayment, exportPayouts } = require('../controllers/purchase_invoices.controller');
const router = express.Router();

const canView     = requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'VIEW_INVOICE', 'VIEW_PURCHASE_INVOICE');   // hub users: VIEW_INVOICE (or no perms = open)
const canApprovePI     = requirePermission('MANAGE_HUBS', 'APPROVE_PURCHASE_INVOICE');
const canRecalculatePI = requirePermission('MANAGE_HUBS', 'APPROVE_PURCHASE_INVOICE', 'RECALCULATE_PURCHASE_INVOICE');
const canGenerate = requirePermissionOrHub('MANAGE_HUBS', 'CREATE_INVOICE', 'CREATE_PURCHASE_INVOICE');          // hub users: CREATE_INVOICE (or no perms = open)
const canPayment  = requirePermission('ADD_INVOICE_PAYMENT', 'MANAGE_HUBS', 'ADD_PURCHASE_INVOICE_PAYMENT');

router.use(requireAuth);
router.get('/',              canView,     listPurchaseInvoices);
router.get('/payouts',       canView,     listPayouts);
router.get('/hub-payments',      canView, listHubPayments);
router.get('/tech-rate-summary', canView,    getTechRateSummary);
router.get('/export-payouts',    canView,    exportPayouts);
router.post('/bulk-payment',     canPayment, bulkPayment);
router.post('/generate',     canGenerate, generatePurchaseInvoice);
router.get('/:id',           canView,     getPurchaseInvoice);
router.post('/:id/approve',     canApprovePI,     approvePurchaseInvoice);
router.post('/:id/reject-approval', canApprovePI, rejectPurchaseInvoiceApproval);
router.patch('/:id',            canApprovePI,     updatePurchaseInvoice);
router.post('/:id/recalculate',        canRecalculatePI, recalculatePurchaseInvoice);
router.post('/:id/sync-from-estimate', canGenerate,      syncPurchaseInvoiceFromEstimate);
router.post('/:id/payments',           canPayment, addHubPayment);
router.delete('/:id/payments/:payId',  canPayment, deleteHubPayment);
module.exports = router;
