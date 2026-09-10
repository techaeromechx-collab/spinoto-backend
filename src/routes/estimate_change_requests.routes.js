'use strict';

/**
 * /api/estimate-change-requests — reviewing a hub's proposed edit to an
 * estimate.
 *
 * WHO MAY READ: a hub sees its own requests (it needs to know what it asked
 * for and what came back), staff see everything. The scoping is in the
 * controller, off the SESSION's hub_id, never off a query parameter.
 *
 * WHO MAY DECIDE: staff only.
 *
 * requirePermission, NOT requirePermissionOrHub. The OrHub helper passes any
 * hub login through — including one with zero permission rows, which was every
 * hub before migration 179 — and this is the one endpoint a hub must never
 * reach, because the entire point of the feature is that the hub does not get
 * to decide its own request. The controller refuses hub sessions on the ROLE as
 * well: a hub can legitimately hold EDIT_ESTIMATE and would otherwise sail
 * through this gate. Same belt-and-braces as
 * syncPurchaseInvoiceFromEstimate, and for the same reason.
 */

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const {
  listChangeRequests,
  getChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
} = require('../controllers/estimate_change_requests.controller');

const router = express.Router();

router.use(requireAuth);
// Mounted for the same reason it is on the invoice routers: a request carries
// the estimate's customer context, and a hub reading its own request must see
// the same masked number it sees everywhere else.
router.use(maskCustomerContact);

// Reading. A hub needs this to see the outcome of its own request, so the
// hub-tolerant guard is correct here — and the controller pins it to that hub.
const canRead = requirePermissionOrHub(
  'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE', 'SUBMIT_ESTIMATE');

// Deciding. Approving rewrites an issued customer invoice and the hub's own
// sales invoice, so it sits behind the permissions that already govern exactly
// that: approving an estimate, or editing an invoice.
const canDecide = requirePermission('APPROVE_ESTIMATE', 'EDIT_INVOICE', 'MANAGE_HUBS');

router.get('/',               canRead,   listChangeRequests);
router.get('/:id',            canRead,   getChangeRequest);
router.post('/:id/approve',   canDecide, approveChangeRequest);
router.post('/:id/reject',    canDecide, rejectChangeRequest);

module.exports = router;
