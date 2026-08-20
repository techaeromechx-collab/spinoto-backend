'use strict';
const express = require('express');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listCustomerInvoices, exportCustomerInvoices, getCustomerInvoice, getCustomerInvoiceByToken, getCustomerInvoicePdf,
  addPayment, updatePayment, deletePayment,
  approveCustomerInvoice,
  updateCustomerInvoiceNotes,
  updateCustomerInvoiceExtras,
  generateCustomerInvoiceFromEstimate,
  syncCustomerInvoiceFromEstimate,
  getVehicleHistory,
  invoiceDatePreflight,
  updateInvoiceDate,
  invoiceDateCompliance,
} = require('../controllers/customer_invoices.controller');
const router = express.Router();

const canView    = requirePermissionOrHub('VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'ADD_INVOICE_PAYMENT');
const canCreate  = requirePermission('CREATE_INVOICE');
const canEdit    = requirePermission('EDIT_INVOICE');
const canPayment = requirePermission('ADD_INVOICE_PAYMENT');
// Deleting payments is higher-stakes (can un-pay a PAID invoice, reopen the
// appointment, and pull the hub payout back) — gated by its own permission.
const canDeletePayment = requirePermission('DELETE_INVOICE_PAYMENT');

router.use(requireAuth);
// Customer mobile numbers are masked to 98382xxxxx for hub logins — see
// middleware/maskMobile.middleware.js. Mounted at the router so every response
// below is covered by default, including handlers added later.
router.use(maskCustomerContact);

router.get('/',                        canView,    listCustomerInvoices);
// Static routes BEFORE /:id to avoid param capture
router.get('/export',                  canView,    exportCustomerInvoices);
router.post('/from-estimate',          canCreate,  generateCustomerInvoiceFromEstimate);
router.get('/vehicle-history/:vnum',   canView,    getVehicleHistory);
// Static, so it must sit above /:id. Read-only compliance view: every
// backdated invoice and every number/date order disagreement.
// requirePermission, NOT requirePermissionOrHub: this lists every backdated
// invoice company-wide with customer names, totals, reasons and who did it.
// A hub partner has no business seeing another hub's accounting corrections,
// and requirePermissionOrHub waves through hub users with zero permissions.
router.get('/date-compliance',         requirePermission('VIEW_INVOICE'), invoiceDateCompliance);
router.get('/by-token/:token',         canView,    getCustomerInvoiceByToken);
router.get('/:id',                     canView,    getCustomerInvoice);
router.get('/:id/pdf',                 canView,    getCustomerInvoicePdf);
router.patch('/:id',                   canEdit,    updateCustomerInvoiceNotes);
// Optional header/line-item display fields (PO no., e-way bill, batch/exp/mfg,
// free-item flag, custom fields+columns). Same permission as any other invoice
// edit — they print on the invoice, so they aren't cosmetic-only in practice.
router.patch('/:id/extras',            canEdit,    updateCustomerInvoiceExtras);
// Changing the legal date of a tax invoice is its own permission, not part of
// general EDIT_INVOICE — it moves revenue between reporting periods and starts
// the warranty clock earlier. The preflight is a dry run, so it only needs
// view rights; the handler reports what an override WOULD unlock without
// applying one.
router.get('/:id/date-preflight',      canView,    invoiceDatePreflight);
router.patch('/:id/invoice-date',      requirePermission('BACKDATE_INVOICE', 'OVERRIDE_INVOICE_DATE_LIMITS'), updateInvoiceDate);
router.post('/:id/approve',            canEdit,    approveCustomerInvoice);
router.post('/:id/sync-from-estimate', canEdit,    syncCustomerInvoiceFromEstimate);
router.post('/:id/payments',           canPayment, addPayment);
router.patch('/:id/payments/:payId',   requirePermission('EDIT_INVOICE_PAYMENT'), updatePayment);
router.delete('/:id/payments/:payId',  canDeletePayment, deletePayment);
module.exports = router;
