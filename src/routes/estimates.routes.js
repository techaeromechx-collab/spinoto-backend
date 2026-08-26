'use strict';

const express = require('express');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
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

/* Recording the CUSTOMER's decision is staff-only, and cannot share canExecute.
 *
 * canExecute has to keep its hub bypass — it also gates the per-item work-status
 * updates, which are the hub's own job while a car is on the ramp. But it let a
 * hub open "Mark Customer Approval" in the portal and tick the customer's lines
 * for them, and the controller wrote no provenance at all: no decision_source,
 * no timestamp, no user. An approved line had nothing behind it.
 *
 * requirePermission, not ...OrHub: the latter grants a hub login with zero
 * permissions assigned EVERYTHING, which is the default a hub is created with.
 * The controller refuses hub sessions on the role as well — a hub can
 * legitimately hold EDIT_ESTIMATE and would otherwise pass this gate.
 *
 * The customer's own link is unaffected: it is a public route with its own
 * last-4 identity check, and it is the path that records who decided. */
const canRecordCustomerDecision = requirePermission('EXECUTE_ESTIMATE', 'EDIT_ESTIMATE');

router.use(requireAuth);
// Customer mobile numbers are masked to 98382xxxxx for hub logins — see
// middleware/maskMobile.middleware.js. Mounted at the router so every response
// below is covered by default, including handlers added later.
router.use(maskCustomerContact);


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
router.post('/:id/customer-approval',              canRecordCustomerDecision, customerApproval);
router.patch('/:id/items/:itemId/work-status',     canExecute, updateItemWorkStatus);
router.delete('/:id',                              requireAuth, deleteEstimate);

module.exports = router;
