'use strict';

/**
 * /api/webhooks/* — UNAUTHENTICATED gateway callbacks.
 *
 * Its own file, and its own mount in server.js, so that this fact is impossible
 * to lose. A route added to payments.routes.js inherits requireAuth; a route
 * added here inherits nothing. Keeping the two in one file is how an endpoint
 * ends up public by accident.
 *
 * There is no requireAuth here and there must not be: the gateway has no
 * session, no token and no user. Its credential is the HMAC signature over the
 * request body, checked first thing in the handler.
 *
 * RATE LIMITING
 * ─────────────
 * Generous, and by IP. This has to survive a legitimate burst — a gateway
 * catching up after an outage can deliver hundreds of events in a minute, and
 * throttling those loses payments. It is here to stop an anonymous flood of
 * unsigned requests forcing an HMAC computation each, not to police the
 * gateway. Verification is cheap and happens before any database work, so the
 * cost of a rejected request is already close to nothing.
 */

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const { handleWebhook, handlePayoutWebhook } = require('../controllers/webhooks.payments.controller');

const router = express.Router();

const webhookLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyBy: req => req.ip,
});

router.post('/razorpay', webhookLimit, (req, res, next) => {
  Promise.resolve(handleWebhook(req, res)).catch(next);
});

/**
 * Money OUT. A separate path because it is a separate product with a separate
 * webhook secret — the handler cannot know which secret to verify with unless
 * the URL says so.
 *
 * This URL goes in the RazorpayX dashboard, NOT the Razorpay one. Pasting the
 * collections URL here (or vice versa) produces a stream of 401s that look like
 * an attack in the log and are in fact a typo — worth knowing before spending an
 * afternoon on it.
 */
router.post('/razorpayx', webhookLimit, (req, res, next) => {
  Promise.resolve(handlePayoutWebhook(req, res)).catch(next);
});

module.exports = router;
