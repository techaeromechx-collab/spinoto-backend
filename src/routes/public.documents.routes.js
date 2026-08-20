'use strict';

// PUBLIC, UNAUTHENTICATED document links.
//
// Second public surface in this application, after /api/public/booking. Read the
// header of public.documents.controller.js before changing anything here — the
// narrow SELECT in that file is the whole security model, and this router is
// only the rate limit in front of it.
//
// Deliberately NO `:type` parameter. One route, one document type, hardcoded.
// A generic /:type/:token would be one mapping-table typo away from serving
// purchase invoices — which carry what we pay the hub — to customers.

const express = require('express');
const c = require('../controllers/public.documents.controller');
const { rateLimit } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const MIN = 60 * 1000;

// Tighter than the booking catalog's 120/15min, looser than its write paths.
//
// Each hit renders a PDF through Puppeteer, so the cost per request is real —
// this is as much a protection against a slow resource as against token
// guessing. A customer opening their own invoice, reloading, and forwarding it
// to a spouse who opens it too stays well inside 30.
//
// Token guessing is not the primary concern: public_token is random and
// non-enumerable by design (migration 085), and the limiter is keyed per IP, so
// it slows a scan rather than stopping a distributed one. The token's entropy
// is what makes that acceptable.
const documentLimit = rateLimit({ windowMs: 15 * MIN, max: 30 });

router.get('/customer-invoice/:token', documentLimit, c.getPublicCustomerInvoice);

// The advance receipt / refund voucher. Same limit and same reasoning as the
// invoice: each hit renders a PDF, and the token's entropy — not this limiter —
// is what makes guessing infeasible.
//
// One route for both documents, because the token identifies which. Two routes
// would let a customer discover, from a 404, that their token is a receipt
// rather than a refund.
router.get('/advance/:token', documentLimit, c.getPublicAdvanceVoucher);

// ── Estimate approval ───────────────────────────────────────────────────────
//
// Different from the invoice route in kind, not just in shape: an invoice is
// read-only, an estimate commits a customer to a price. Hence the second factor
// on the decision endpoint (see public.estimate.controller.js) and a tighter
// limit on it — 10 in 15 minutes is generous for a person answering their own
// estimate and hostile to anyone guessing four digits.
const e = require('../controllers/public.estimate.controller');

const decisionLimit = rateLimit({ windowMs: 15 * MIN, max: 10 });

router.get('/estimate/:token',           documentLimit, e.getPublicEstimate);
router.post('/estimate/:token/decision', decisionLimit, e.decidePublicEstimate);

// The printable estimate. documentLimit, not decisionLimit: downloading is
// read-only and a customer reopening their own quote a few times is normal,
// where approving it is once-only and gets the tighter allowance.
router.get('/estimate-pdf/:token',       documentLimit, e.getPublicEstimatePdf);

module.exports = router;
