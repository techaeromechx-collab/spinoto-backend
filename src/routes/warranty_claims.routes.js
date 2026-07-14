'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/warranty_claims.controller');

const router = express.Router();

// Hub users can view + register claims for their own hub (scoping enforced in
// the controller). Decisions (approve/reject) and redo creation are company-only.
const canRead     = [requireAuth, requirePermissionOrHub('VIEW_CLAIM', 'CREATE_CLAIM', 'APPROVE_CLAIM', 'RESOLVE_CLAIM', 'MANAGE_CLAIMS')];
const canCreate   = [requireAuth, requirePermissionOrHub('CREATE_CLAIM', 'MANAGE_CLAIMS')];
const canDecide   = [requireAuth, requirePermission('APPROVE_CLAIM', 'MANAGE_CLAIMS')];
const canResolve  = [requireAuth, requirePermission('RESOLVE_CLAIM', 'MANAGE_CLAIMS')];

router.get ('/',                canRead,    c.listClaims);
router.get ('/stats',           canRead,    c.claimStats);      // analytics: summary, trend, by-service, by-hub
router.get ('/eligible-items',  canRead,    c.eligibleItems);   // ?mobile= or ?customer_invoice_id=
router.get ('/:id',             canRead,    c.getClaim);
router.post('/',                canCreate,  c.createClaim);
router.patch('/:id',            canCreate,  c.updateClaim);     // intake fields, pre-decision only
router.post('/:id/review',      canDecide,  c.reviewClaim);
router.post('/:id/approve',     canDecide,  c.approveClaim);
router.post('/:id/reject',      canDecide,  c.rejectClaim);
router.post('/:id/cancel',      canCreate,  c.cancelClaim);
router.post('/:id/create-redo', canResolve, c.createRedo);

module.exports = router;
