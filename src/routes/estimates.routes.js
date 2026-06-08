'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  submitEstimate,
  companyApprove,
  companyRevise,
  customerApproval,
  updateItemWorkStatus,
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
router.get('/:id',                                 canView,    getEstimate);
router.patch('/:id',                               canEdit,    updateEstimate);
router.post('/:id/submit',                         canSubmit,  submitEstimate);
router.post('/:id/company-approve',                canApprove, companyApprove);
router.post('/:id/company-revise',                 canRevise,  companyRevise);
router.post('/:id/customer-approval',              canExecute,   customerApproval);
router.patch('/:id/items/:itemId/work-status',     canExecute, updateItemWorkStatus);

module.exports = router;
