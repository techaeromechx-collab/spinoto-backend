'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const c = require('../controllers/warranty_claims.controller');

const router = express.Router();

/* ── Customer numbers are masked for hub sessions ──────────────────────────
   This file was the one hub-reachable router that had been missed. canRead is
   requirePermissionOrHub, and listClaims and eligible-items both select
   ci.mobile, so a hub browsing warranty claims saw full customer numbers while
   the SAME customer was masked on the appointment and the invoice beside it.

   In the ARRAYS, after requireAuth — not `router.use`, which is how the four
   other masked routers do it. Those call `router.use(requireAuth)` first; this
   file does not, and mounting the mask at the router would put it AHEAD of the
   per-route requireAuth. maskCustomerContact reads req.user to decide whether
   to wrap res.json, so it would have found nothing, masked nothing, and failed
   silently — a guard that looks present and does not run. Same placement as
   appointments.routes.js, for the same reason.

   On the company-only arrays too. It is a no-op for staff (the wrapper is not
   even installed), and it means a permission later widened to OrHub does not
   quietly open a hole. */
const canRead     = [requireAuth, requirePermissionOrHub('VIEW_CLAIM', 'CREATE_CLAIM', 'APPROVE_CLAIM', 'RESOLVE_CLAIM', 'MANAGE_CLAIMS'), maskCustomerContact];
const canCreate   = [requireAuth, requirePermissionOrHub('CREATE_CLAIM', 'MANAGE_CLAIMS'), maskCustomerContact];
const canDecide   = [requireAuth, requirePermission('APPROVE_CLAIM', 'MANAGE_CLAIMS'), maskCustomerContact];
const canResolve  = [requireAuth, requirePermission('RESOLVE_CLAIM', 'MANAGE_CLAIMS'), maskCustomerContact];

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
