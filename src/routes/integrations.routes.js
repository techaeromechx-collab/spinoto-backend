'use strict';

// Inbound machine-to-machine sync — NOT user-authenticated. Guarded by a
// static API key shared with the booking backend (x-api-key header).
// Set BOOKING_WEBHOOK_KEY in .env on BOTH systems; never reuse it elsewhere.

const express = require('express');
const c = require('../controllers/integrations.controller');

const router = express.Router();

function requireApiKey(req, res, next) {
  const key = process.env.BOOKING_WEBHOOK_KEY;
  if (!key) {
    // Fail closed: integration disabled until the key is configured
    return res.status(503).json({ error: 'Integration not configured (BOOKING_WEBHOOK_KEY missing)' });
  }
  if (req.headers['x-api-key'] !== key) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

router.post('/booking-orders', requireApiKey, c.bookingOrders);

module.exports = router;
