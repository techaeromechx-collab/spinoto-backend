'use strict';

/**
 * /api/public/pay/* — UNAUTHENTICATED. The customer's pay-by-link page.
 *
 * Third public surface in this application, after /api/public/booking and
 * /api/public/documents. Read the header of public.payments.controller.js
 * before changing anything here.
 *
 * ── On the rate limits ──────────────────────────────────────────────────────
 * Token guessing is not the primary concern: the token is 10 random bytes and
 * brute-forcing it is infeasible. The real risks are:
 *
 *   - card testing. A stolen card list run against a payment endpoint, one
 *     small order at a time, to find which numbers still work. This is the
 *     reason /order is the tightest limit here.
 *   - opening thousands of orders to burn gateway quota, or simply to fill our
 *     transactions table with noise.
 *
 * rateLimit keys on req.route.path, NOT req.path — see the long note in
 * middleware/rateLimit.middleware.js. With a parameterised route the two differ,
 * and keying on the substituted path would give every token its own fresh
 * allowance, which is the same as having no limit at all.
 */

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const c = require('../controllers/public.payments.controller');

const router = express.Router();

// Reading a link is cheap and legitimately repeated — a customer refreshes,
// comes back later, opens it on a second device.
const readLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

// Opening an order is the expensive, abusable one.
const orderLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Verification is generous: a customer with a flaky connection may legitimately
// retry, and every attempt still has to carry a valid HMAC to do anything.
const verifyLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

router.get('/:token',         readLimit,   c.getPayPage);
router.post('/:token/order',  orderLimit,  c.createPublicOrder);
router.post('/:token/verify', verifyLimit, c.verifyPublicPayment);

module.exports = router;
