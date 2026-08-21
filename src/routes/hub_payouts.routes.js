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
//
// ── THIS LIST IS CANONICAL. TWO OTHER FILES MUST MATCH IT. ─────────────────
//
//   frontend/src/components/AppShell.jsx   the sidebar entry
//   frontend/src/App.jsx                   the /payouts route guard
//
// They are kept in step by test/hubpayoutperms.test.js, which parses all three
// and fails if they differ. That test exists because they HAD drifted, into
// three different lists, and every combination below was live at once:
//
//   VIEW_HUB_PAYOUTS  — the permission named for this very screen — appeared
//                       nowhere in the frontend at all. Ticking its checkbox
//                       hid nothing and revealed nothing.
//   VIEW_HUB          — was in the sidebar and the route guard but NOT here,
//                       so the link appeared, the page opened, and every
//                       request on it came back 403.
//   VIEW_PURCHASE_INVOICE — was in the sidebar and here, but not the route
//                       guard: the link appeared and clicking it was blocked.
//
// None of that was a data leak — this file is the real gate and it held. They
// were dead links, which is why they survived so long: nothing errors loudly
// enough for anyone to file a bug about a menu item.
//
// If you change this list, change the other two and run that test.
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
