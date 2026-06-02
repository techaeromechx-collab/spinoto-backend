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

const canView   = requirePermissionOrHub('VIEW_ESTIMATE'); // hub users can read their own estimates
const canCreate = requirePermissionOrHub('CREATE_ESTIMATE'); // hub users can create estimates
const canEdit   = requirePermissionOrHub('EDIT_ESTIMATE'); // hub users can edit/submit estimates

router.use(requireAuth);

router.get('/',                                    canView,   listEstimates);
router.post('/',                                   canCreate, createEstimate);
router.get('/:id',                                 canView,   getEstimate);
router.patch('/:id',                               canEdit,   updateEstimate);
router.post('/:id/submit',                         canEdit,   submitEstimate);
router.post('/:id/company-approve',                canEdit,   companyApprove);
router.post('/:id/company-revise',                 canEdit,   companyRevise);
router.post('/:id/customer-approval',              canEdit,   customerApproval);
router.patch('/:id/items/:itemId/work-status',     canEdit,   updateItemWorkStatus);

module.exports = router;
