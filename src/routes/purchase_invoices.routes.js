'use strict';
const express = require('express');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { listPurchaseInvoices, getPurchaseInvoice, getPurchaseInvoicePdf, getPurchaseInvoiceByToken, generatePurchaseInvoice, approvePurchaseInvoice, rejectPurchaseInvoiceApproval, updatePurchaseInvoice, addHubPayment, deleteHubPayment, deleteHubPaymentBatch, updateHubPaymentDate, updateHubPaymentBatchDate, listPayouts, recalculatePurchaseInvoice, syncPurchaseInvoiceFromEstimate, listHubPayments, getTechRateSummary, bulkPayment, exportPayouts, cancelPurchaseInvoice } = require('../controllers/purchase_invoices.controller');
const router = express.Router();

const canView     = requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'VIEW_INVOICE', 'VIEW_PURCHASE_INVOICE');   // hub users: VIEW_INVOICE (or no perms = open)
const canApprovePI     = requirePermission('MANAGE_HUBS', 'APPROVE_PURCHASE_INVOICE');
const canRecalculatePI = requirePermission('MANAGE_HUBS', 'APPROVE_PURCHASE_INVOICE', 'RECALCULATE_PURCHASE_INVOICE');
const canGenerate = requirePermissionOrHub('MANAGE_HUBS', 'CREATE_INVOICE', 'CREATE_PURCHASE_INVOICE');          // hub users: CREATE_INVOICE (or no perms = open)
// ADD_INVOICE_PAYMENT is NOT on this list, and that removal is the fix.
//
// It is the customer-invoice cashier's code — "record payment entries against an
// invoice", group Invoices — and OR-ing it here silently promoted every counter
// user to payout authority over hubs. The handlers apply only _assertPiHub
// (tenancy); there is no second check inside, so this route gate was the entire
// control. A front-desk user could POST /bulk-payment and mark every hub invoice
// paid with no money having left the bank, or DELETE /payment-batch/:id and
// reverse a real transfer across many invoices at once.
//
// ADD_PURCHASE_INVOICE_PAYMENT already exists and already says exactly this
// ("Record or delete payment entries (payouts) against a purchase invoice").
// It was being made decorative by the OR.
const canPayment  = requirePermission('MANAGE_HUBS', 'ADD_PURCHASE_INVOICE_PAYMENT');
// sync-from-estimate REWRITES an existing invoice's line items and totals. That
// is an edit of an issued document, not a generation, so it does not get
// canGenerate's hub bypass — a zero-permission hub login used to pass it
// unconditionally. requirePermission here matches customer-invoices, where the
// same route is already requirePermission('EDIT_INVOICE'). The controller
// additionally refuses any hub_id session outright, because a hub login can
// legitimately hold CREATE_INVOICE and would otherwise pass this gate.
const canSyncPI   = requirePermission('MANAGE_HUBS', 'CREATE_INVOICE', 'CREATE_PURCHASE_INVOICE');

router.use(requireAuth);
// Customer mobile numbers are masked to 98382xxxxx for hub logins — see
// middleware/maskMobile.middleware.js. Mounted at the router so every response
// below is covered by default, including handlers added later.
router.use(maskCustomerContact);

router.get('/',              canView,     listPurchaseInvoices);
router.get('/payouts',       canView,     listPayouts);
router.get('/hub-payments',      canView, listHubPayments);
router.get('/tech-rate-summary', canView,    getTechRateSummary);
router.get('/export-payouts',    canView,    exportPayouts);
router.post('/bulk-payment',     canPayment, bulkPayment);
// Reverse a whole bulk payment. A literal path segment, so it must sit ABOVE
// the '/:id' routes below — otherwise 'payment-batch' is matched as an :id and
// idParam.parse throws a 400 on a perfectly valid request.
router.delete('/payment-batch/:batchId', canPayment, deleteHubPaymentBatch);
router.patch('/payment-batch/:batchId',  canPayment, updateHubPaymentBatchDate);
router.post('/generate',     canGenerate, generatePurchaseInvoice);
// by-token — resolves a shareable-URL token; must be before /:id
router.get('/by-token/:token', canView,   getPurchaseInvoiceByToken);
router.get('/:id',           canView,     getPurchaseInvoice);
// Themed PDF. Viewer role (admin vs hub) is resolved server-side from the
// session, so a hub can never request the admin view and see the margin.
router.get('/:id/pdf',       canView,     getPurchaseInvoicePdf);
router.post('/:id/approve',     canApprovePI,     approvePurchaseInvoice);
router.post('/:id/reject-approval', canApprovePI, rejectPurchaseInvoiceApproval);
// Void an invoice that should not exist. Same gate as approve/reject — the
// person who can approve a payout is the person who can void one. NOT a DELETE:
// the row and the hub's invoice number both survive, see the controller.
router.post('/:id/cancel',          canApprovePI, cancelPurchaseInvoice);
router.patch('/:id',            canApprovePI,     updatePurchaseInvoice);
router.post('/:id/recalculate',        canRecalculatePI, recalculatePurchaseInvoice);
router.post('/:id/sync-from-estimate', canSyncPI,        syncPurchaseInvoiceFromEstimate);
router.post('/:id/payments',           canPayment, addHubPayment);
router.delete('/:id/payments/:payId',  canPayment, deleteHubPayment);
router.patch('/:id/payments/:payId',   canPayment, updateHubPaymentDate);
module.exports = router;
