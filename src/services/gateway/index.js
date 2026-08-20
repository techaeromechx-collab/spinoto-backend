'use strict';

/**
 * Gateway registry — the single entry point every caller uses.
 *
 *   const gateway = require('../services/gateway').getGateway();
 *
 * Nothing outside this directory requires an adapter file directly. That one
 * habit is what keeps the provider swappable: adding Stripe is a new adapter
 * plus one line in ADAPTERS, and no controller changes.
 *
 * The active provider comes from PAYMENT_GATEWAY (default 'razorpay'). It is
 * resolved per call rather than cached at require time so a test can set the
 * variable before exercising a handler, and so a misconfiguration surfaces as a
 * clear error at the call site instead of a crash on boot.
 */

const razorpay = require('./razorpay.adapter');
const razorpayx = require('./razorpayx.adapter');

const ADAPTERS = {
  razorpay,
  // stripe: require('./stripe.adapter'),   ← the whole cost of a second provider
};

/**
 * Money OUT lives in its own registry, and that separation is deliberate.
 *
 * Collecting and paying are different products with different credentials even
 * at the same provider — RazorpayX is not an extension of Razorpay's keys. One
 * registry would mean getGateway() sometimes returning something that can send
 * money, which is a capability no collections caller should be able to reach by
 * accident.
 *
 * Everything else is identical, including the rule: the provider's name appears
 * only inside this directory.
 */
const PAYOUT_ADAPTERS = {
  razorpayx,
};

const DEFAULT_GATEWAY = 'razorpay';
const DEFAULT_PAYOUT_GATEWAY = 'razorpayx';

function activeName() {
  return String(process.env.PAYMENT_GATEWAY || DEFAULT_GATEWAY).toLowerCase();
}

function getGateway(name) {
  const key = String(name || activeName()).toLowerCase();
  const adapter = ADAPTERS[key];
  if (!adapter) {
    const err = new Error(
      `Payment gateway '${key}' is not supported. Set PAYMENT_GATEWAY to one of: ${Object.keys(ADAPTERS).join(', ')}.`
    );
    err.status = 503;
    throw err;
  }
  return adapter;
}

/**
 * Everything the Gateway Settings screen is allowed to know.
 *
 * Note what is absent: no secret, and no way to derive one. The key id IS
 * returned because it is public by design — it is embedded in the checkout
 * script on every payment page — but it is returned masked anyway, because a
 * settings screen has no reason to display it in full and a screenshot pasted
 * into a support chat is a real thing that happens.
 *
 * `webhook_configured` is a boolean, never the secret. That single flag is what
 * an admin actually needs: it answers "is the webhook going to work?" without
 * anything sensitive crossing the wire.
 */
function gatewayStatus() {
  const g = getGateway();
  const key = g.publicKey();
  return {
    gateway: g.name,
    mode: g.mode(),
    configured: g.isConfigured(),
    // rzp_live_ABC…XYZ → keeps the prefix (which carries the mode) and the last
    // four, enough to tell two accounts apart, not enough to be the key.
    key_id_masked: maskKey(key),
    webhook_configured: g.isWebhookConfigured(),
  };
}

function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 12) return s;                       // 'rzp_test_mock'
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money out
// ─────────────────────────────────────────────────────────────────────────────

function activePayoutName() {
  return String(process.env.PAYOUT_GATEWAY || DEFAULT_PAYOUT_GATEWAY).toLowerCase();
}

function getPayoutGateway(name) {
  const key = String(name || activePayoutName()).toLowerCase();
  const adapter = PAYOUT_ADAPTERS[key];
  if (!adapter) {
    const err = new Error(
      `Payout gateway '${key}' is not supported. Set PAYOUT_GATEWAY to one of: ${Object.keys(PAYOUT_ADAPTERS).join(', ')}.`
    );
    err.status = 503;
    throw err;
  }
  return adapter;
}

/**
 * What the settings screen may know about the payout side.
 *
 * `webhook_configured` matters more here than it does for collections. A
 * collected payment has a second channel — the browser comes back with a signed
 * callback — so a missing webhook secret degrades gracefully. Money leaving has
 * no such channel: without the webhook, every payout stays 'queued' for ever and
 * no purchase invoice is ever marked paid. It is a hard prerequisite, and the
 * screen says so.
 */
function payoutGatewayStatus() {
  const g = getPayoutGateway();
  return {
    gateway: g.name,
    mode: g.mode(),
    configured: g.isConfigured(),
    key_id_masked: maskKey(g.publicKey()),
    webhook_configured: g.isWebhookConfigured(),
  };
}

module.exports = {
  getGateway, gatewayStatus, activeName, ADAPTERS,
  getPayoutGateway, payoutGatewayStatus, activePayoutName, PAYOUT_ADAPTERS,
};
