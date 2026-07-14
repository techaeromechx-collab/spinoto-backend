'use strict';
const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listCustomerInvoices, getCustomerInvoice, getCustomerInvoiceByToken,
  addPayment, updatePayment, deletePayment,
  approveCustomerInvoice,
  updateCustomerInvoiceNotes,
  generateCustomerInvoiceFromEstimate,
  syncCustomerInvoiceFromEstimate,
  getVehicleHistory,
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
router.get('/',                        canView,    listCustomerInvoices);
// Static routes BEFORE /:id to avoid param capture
router.post('/from-estimate',          canCreate,  generateCustomerInvoiceFromEstimate);
router.get('/vehicle-history/:vnum',   canView,    getVehicleHistory);
router.get('/by-token/:token',         canView,    getCustomerInvoiceByToken);
router.get('/:id',                     canView,    getCustomerInvoice);
router.patch('/:id',                   canEdit,    updateCustomerInvoiceNotes);
router.post('/:id/approve',            canEdit,    approveCustomerInvoice);
router.post('/:id/sync-from-estimate', canEdit,    syncCustomerInvoiceFromEstimate);
router.post('/:id/payments',           canPayment, addPayment);
router.patch('/:id/payments/:payId',   requirePermission('EDIT_INVOICE_PAYMENT'), updatePayment);
router.delete('/:id/payments/:payId',  canDeletePayment, deletePayment);
module.exports = router;
