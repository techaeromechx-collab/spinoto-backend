'use strict';
const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listCustomerInvoices, getCustomerInvoice,
  addPayment, deletePayment,
  approveCustomerInvoice,
  generateCustomerInvoiceFromEstimate,
  getVehicleHistory,
} = require('../controllers/customer_invoices.controller');
const router = express.Router();

const canView    = requirePermissionOrHub('VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'ADD_INVOICE_PAYMENT');
const canCreate  = requirePermission('CREATE_INVOICE');
const canEdit    = requirePermission('EDIT_INVOICE');
const canPayment = requirePermission('ADD_INVOICE_PAYMENT');

router.use(requireAuth);
router.get('/',                        canView,    listCustomerInvoices);
// Static routes BEFORE /:id to avoid param capture
router.post('/from-estimate',          canCreate,  generateCustomerInvoiceFromEstimate);
router.get('/vehicle-history/:vnum',   canView,    getVehicleHistory);
router.get('/:id',                     canView,    getCustomerInvoice);
router.post('/:id/approve',            canEdit,    approveCustomerInvoice);
router.post('/:id/payments',           canPayment, addPayment);
router.delete('/:id/payments/:payId',  canPayment, deletePayment);
module.exports = router;
