'use strict';

// PUBLIC, UNAUTHENTICATED routes for booking.spinoto.com.
//
// Nothing here requires a login, so every route carries a rate limit and the
// tighter ones are keyed by mobile as well as IP — otherwise one IP could burn
// through OTPs for arbitrary numbers, or one number could be spammed from many
// IPs. Read the header of public.booking.controller.js before changing any of
// this: the limits are part of how the surface stays safe to expose.
//
// CORS: server.js must include https://booking.spinoto.com in CORS_ORIGIN.

const express = require('express');
const c = require('../controllers/public.booking.controller');
const { rateLimit } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const MIN = 60 * 1000;
const bodyMobile = (req) => (req.body?.mobile || '').toString().slice(0, 20);

// Read-only catalog — generous, it is what the landing page loads on arrival.
const readLimit = rateLimit({ windowMs: 15 * MIN, max: 120 });

// OTP send: costs real money per call. Tight, and per-number as well as per-IP.
const otpSendLimit = rateLimit({ windowMs: 15 * MIN, max: 5, keyBy: bodyMobile });

// OTP verify: brute-force guard on top of the per-challenge attempt counter.
const otpVerifyLimit = rateLimit({ windowMs: 15 * MIN, max: 10, keyBy: bodyMobile });

// Write paths.
const writeLimit = rateLimit({ windowMs: 15 * MIN, max: 20 });

router.get('/services', readLimit, c.getServices);
router.get('/vehicle-options', readLimit, c.getVehicleOptions);
router.get('/check-location', readLimit, c.checkLocation);

router.post('/send-otp', otpSendLimit, c.sendOtp);
router.post('/verify-otp', otpVerifyLimit, c.verifyOtp);
router.post('/notify-request', writeLimit, c.notifyRequest);
router.post('/create-order', writeLimit, c.createOrder);

// Deliberately looser: the customer has already paid. Rate-limiting a retry
// here would strand money with no appointment.
router.post('/verify-payment', rateLimit({ windowMs: 15 * MIN, max: 60 }), c.verifyPayment);

module.exports = router;
