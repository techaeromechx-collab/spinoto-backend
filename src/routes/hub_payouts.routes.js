'use strict';

/**
 * /api/hub-payouts — money going OUT.
 *
 * Its own router rather than more routes on purchase_invoices.routes.js, because
 * the permissions are genuinely different. That file's `canPayment` lets anyone
 * who can record a bookkeeping entry through; sending real money needs its own
 * code, and mixing the two in one file is how the wrong one gets copied onto a
 * route added next year.
 */

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const {
  listPayouts, payoutSummary, exportPayouts, createPayout, refresh, readiness, register,
} = require('../controllers/hub_payouts.controller');

const router = express.Router();

router.use(requireAuth);

// Reading is wide: anyone who can look at purchase invoices or the payments
// module has a legitimate reason to see what has been paid out.
const canView = requirePermission(
  'VIEW_HUB_PAYOUTS', 'MANAGE_HUBS', 'VIEW_PURCHASE_INVOICE', 'VIEW_PAYMENTS');

// Sending is narrow, and MANAGE_HUBS is deliberately NOT on it. That code is
// held by people who administer hub records — names, rates, service mappings —
// which is not the same authority as moving money out of the company account.
const canPay = requirePermission('PAY_HUB_ONLINE');

// Registering decides WHERE every future automatic payout to a hub goes, so it
// sits beside paying rather than beside editing a hub.
const canRegister = requirePermission('MANAGE_HUB_PAYOUT_ACCOUNT', 'PAY_HUB_ONLINE');

// Literal segments before anything that could be read as an :id.
router.get('/summary', canView, payoutSummary);
router.get('/export',  canView, exportPayouts);
router.get('/hubs/:hubId/readiness', canView, readiness);
router.post('/hubs/:hubId/register', canRegister, register);

router.get('/',  canView, listPayouts);
router.post('/', canPay,  createPayout);
router.post('/:id/refresh', canView, refresh);

module.exports = router;
