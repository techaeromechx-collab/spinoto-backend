const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/ledger.controller');

const router = express.Router();

/* A statement shows everything a party was ever billed and everything they
   paid, so it is gated on seeing invoices — the same bar as the documents it
   is assembled from. It writes nothing, so there is no separate manage
   permission to grant.

   requirePermission, not requirePermissionOrHub: a hub statement lists what
   every other hub is owed through the payables route, and a zero-permission
   hub login would otherwise be waved straight through. The controller refuses
   hub users again. */
const canView = [requireAuth, requirePermission('VIEW_INVOICE')];

router.get('/payables',              canView, c.payables);
router.get('/customer/:mobile',      canView, c.customerLedger);
router.get('/customer/:mobile/pdf',  canView, c.statementPdfHandler);
router.get('/hub/:hubId',            canView, c.hubLedger);
router.get('/hub/:hubId/pdf',        canView, c.statementPdfHandler);

module.exports = router;
