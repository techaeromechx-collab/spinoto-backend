'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listEstimates,
  getEstimate,
  getEstimatePdf,
  getEstimateByToken,
  createEstimate,
  updateEstimate,
  submitEstimate,
  companyApprove,
  companyRevise,
  customerApproval,
  updateItemWorkStatus,
  deleteEstimate,
  estimateDatePreflight,
  updateEstimateDate,
} = require('../controllers/estimates.controller');

const router = express.Router();

const canView    = requirePermissionOrHub('VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE', 'SUBMIT_ESTIMATE', 'EXECUTE_ESTIMATE');
const canCreate  = requirePermissionOrHub('CREATE_ESTIMATE');
const canEdit    = requirePermissionOrHub('EDIT_ESTIMATE');
const canSubmit  = requirePermissionOrHub('SUBMIT_ESTIMATE',  'EDIT_ESTIMATE');
const canApprove         = requirePermissionOrHub('APPROVE_ESTIMATE', 'EDIT_ESTIMATE');
const canRevise          = requirePermissionOrHub('REVISE_ESTIMATE',  'EDIT_ESTIMATE');
const canExecute         = requirePermissionOrHub('EXECUTE_ESTIMATE', 'EDIT_ESTIMATE');

router.use(requireAuth);

router.get('/',                                    canView,    listEstimates);
router.post('/',                                   canCreate,  createEstimate);
// by-token — resolves a shareable-URL token; must be before /:id
router.get('/by-token/:token',                     canView,    getEstimateByToken);
router.get('/:id',                                 canView,    getEstimate);
// Themed PDF — same pipeline as customer invoices and purchase invoices.
router.get('/:id/pdf',                             canView,    getEstimatePdf);
// The estimate's date is the anchor for the whole job chain, so it has its
// own permission rather than riding on general edit rights. The preflight is
// a dry run and only needs view access.
router.get('/:id/date-preflight',                  canView,    estimateDatePreflight);
router.patch('/:id/estimate-date',                 requirePermission('BACKDATE_ESTIMATE', 'OVERRIDE_INVOICE_DATE_LIMITS'), updateEstimateDate);
router.patch('/:id',                               canEdit,    updateEstimate);
router.post('/:id/submit',                         canSubmit,  submitEstimate);
router.post('/:id/company-approve',                canApprove, companyApprove);
router.post('/:id/company-revise',                 canRevise,  companyRevise);
router.post('/:id/customer-approval',              canExecute,   customerApproval);
router.patch('/:id/items/:itemId/work-status',     canExecute, updateItemWorkStatus);
router.delete('/:id',                              requireAuth, deleteEstimate);

module.exports = router;
