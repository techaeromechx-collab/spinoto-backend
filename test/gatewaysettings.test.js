'use strict';

/**
 * Razorpay credentials set from the CRM — do they actually reach the code that
 * signs, and does the save endpoint refuse the mistakes that fail silently?
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM gateway.test.js ───────────────────
 *
 * gateway.test.js proves the adapter is correct given credentials. This one
 * proves the credentials ARRIVE — a different failure, and a much quieter one.
 *
 * The adapter used to read process.env into module CONSTANTS at import time.
 * Moving the keys into integration_settings without touching that would have
 * produced the worst possible outcome: the Gateway screen reporting
 * "source: database" while every charge kept using the value from boot. So
 * every assertion in part 1 changes the stored value AFTER the adapter is
 * imported, and then checks the CRYPTO rather than a boolean. A test that only
 * asserted isConfigured() would pass against the broken version whenever the
 * environment variable happened to be set — which, on a working server, it is.
 *
 * The webhook secret gets its own assertions for the same reason it gets its
 * own paragraph in the adapter header. Leave it on env while the API keys move
 * to the database and taking payments starts working immediately, while the
 * webhook that MARKS them paid keeps failing. Money arrives, no invoice closes,
 * and nothing anywhere looks broken.
 *
 * ── PART 2 IS SOURCE-EVALUATED, AND SAYS SO ─────────────────────────────────
 *
 * payments.controller.js cannot be required standalone — it pulls in the pg
 * pool, the PDF stack and a dozen services. So saveGatewaySettings' source is
 * lifted out of the file and evaluated in a vm context with the four things it
 * touches stubbed. That is NOT the same as running the server, and nothing here
 * claims it is: what it verifies is that those lines, exactly as they are
 * written in the file today, accept and reject what they should. If the handler
 * is renamed, extract() throws rather than silently testing nothing.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = path.resolve(__dirname, '..');
let n = 0;

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — a saved credential reaches the crypto, with no restart
// ═══════════════════════════════════════════════════════════════════════════

const settings = require(`${BE}/src/services/integrationSettings.service.js`);

// putSetting only ever runs a DELETE or an INSERT … ON CONFLICT. What is under
// test is the in-process cache it updates, so the pool can be a stub.
const pool = { query: async () => ({ rows: [], rowCount: 1 }) };

// Import the adapter with NOTHING configured. This ordering is the whole point:
// if the adapter reads at import time, no later save can fix it.
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
  delete process.env[k];
}
const rz = require(`${BE}/src/services/gateway/razorpay.adapter.js`);

assert.strictEqual(rz.isConfigured(), false); n++;
assert.strictEqual(rz.isWebhookConfigured(), false); n++;
assert.strictEqual(rz.publicKey(), 'rzp_test_mock'); n++;
assert.strictEqual(rz.mode(), 'test'); n++;

(async () => {
  // ── A save AFTER import takes effect immediately ──────────────────────────
  await settings.putSetting(pool, 'razorpay_key_id', 'rzp_live_ABCDEF123456');
  await settings.putSetting(pool, 'razorpay_key_secret', 'sec_from_database');

  assert.strictEqual(rz.isConfigured(), true,
    'still unconfigured after a save — the adapter froze its keys at import'); n++;
  assert.strictEqual(rz.publicKey(), 'rzp_live_ABCDEF123456'); n++;
  assert.strictEqual(rz.mode(), 'live',
    'mode() did not re-read the key id — a live install would report itself as test'); n++;

  // ── The callback HMAC is keyed with the STORED secret ─────────────────────
  const orderId = 'order_Real123';
  const paymentId = 'pay_Real456';
  const sigDb = crypto.createHmac('sha256', 'sec_from_database')
    .update(`${orderId}|${paymentId}`).digest('hex');

  assert.strictEqual(rz.verifyPaymentSignature({ orderId, paymentId, signature: sigDb }), true,
    'a callback signed with the stored secret was refused'); n++;
  assert.strictEqual(rz.verifyPaymentSignature({
    orderId, paymentId,
    signature: crypto.createHmac('sha256', 'wrong').update(`${orderId}|${paymentId}`).digest('hex'),
  }), false, 'a callback signed with the WRONG secret was accepted'); n++;

  // ── Rotation mid-process: the old signature must stop working ─────────────
  await settings.putSetting(pool, 'razorpay_key_secret', 'sec_rotated');
  assert.strictEqual(rz.verifyPaymentSignature({ orderId, paymentId, signature: sigDb }), false,
    'the pre-rotation signature still verifies — the adapter cached the secret'); n++;
  assert.strictEqual(rz.verifyPaymentSignature({
    orderId, paymentId,
    signature: crypto.createHmac('sha256', 'sec_rotated').update(`${orderId}|${paymentId}`).digest('hex'),
  }), true, 'the post-rotation signature does not verify'); n++;

  // ── The webhook secret — the one that must not be forgotten ───────────────
  const rawBody = Buffer.from('{"event":"payment.captured","payload":{}}', 'utf8');

  assert.strictEqual(rz.isWebhookConfigured(), false); n++;
  assert.strictEqual(rz.verifyWebhookSignature({
    rawBody, signature: crypto.createHmac('sha256', 'whsec_db').update(rawBody).digest('hex'),
  }), false, 'a webhook was accepted while no webhook secret was set'); n++;

  await settings.putSetting(pool, 'razorpay_webhook_secret', 'whsec_db');

  assert.strictEqual(rz.isWebhookConfigured(), true); n++;
  assert.strictEqual(rz.verifyWebhookSignature({
    rawBody, signature: crypto.createHmac('sha256', 'whsec_db').update(rawBody).digest('hex'),
  }), true,
    'the webhook secret is still frozen at import — payments would be taken and never recorded'); n++;
  assert.strictEqual(rz.verifyWebhookSignature({
    rawBody, signature: crypto.createHmac('sha256', 'attacker').update(rawBody).digest('hex'),
  }), false, 'a forged webhook was accepted'); n++;
  assert.strictEqual(rz.verifyWebhookSignature({
    rawBody: Buffer.from('{"event":"payment.captured","payload":{"x":1}}', 'utf8'),
    signature: crypto.createHmac('sha256', 'whsec_db').update(rawBody).digest('hex'),
  }), false, 'a tampered body was accepted under a valid signature'); n++;

  // ── Precedence: the database wins, and clearing falls BACK to the env ─────
  process.env.RAZORPAY_KEY_ID = 'rzp_test_FROM_ENV';
  assert.strictEqual(rz.publicKey(), 'rzp_live_ABCDEF123456',
    'the environment variable shadowed the value an admin set from the screen'); n++;
  assert.strictEqual(settings.settingSource('razorpay_key_id'), 'database'); n++;

  await settings.putSetting(pool, 'razorpay_key_id', '');   // the Clear button
  assert.strictEqual(rz.publicKey(), 'rzp_test_FROM_ENV',
    'clearing the stored key did not fall back to the environment'); n++;
  assert.strictEqual(rz.mode(), 'test'); n++;
  assert.strictEqual(settings.settingSource('razorpay_key_id'), 'environment'); n++;

  // ── An unconfigured install still refuses a REAL order ────────────────────
  await settings.putSetting(pool, 'razorpay_key_secret', '');
  delete process.env.RAZORPAY_KEY_ID;
  assert.strictEqual(rz.isConfigured(), false); n++;
  assert.strictEqual(rz.verifyPaymentSignature({
    orderId: 'order_Real123', paymentId: 'p', signature: 'x',
  }), false, 'a real order was verified with no credentials — anyone could mark an invoice paid'); n++;
  assert.strictEqual(rz.verifyPaymentSignature({
    orderId: 'order_mock_abc', paymentId: 'p', signature: 'x',
  }), true, 'the mock flow broke'); n++;

  // Leave nothing behind for a suite sharing this process.
  for (const k of ['razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret']) {
    await settings.putSetting(pool, k, '');
  }

  await partTwo();

  console.log(`PASS  gateway settings (CRM-set Razorpay credentials) — ${n} checks`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — PUT /api/payments/gateway refuses what fails silently
// ═══════════════════════════════════════════════════════════════════════════

async function partTwo() {
  const { z } = require('zod');
  const SRC = fs.readFileSync(`${BE}/src/controllers/payments.controller.js`, 'utf8');

  /** Lift a top-level function out of the controller, braces balanced. */
  function extract(name) {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} not found in payments.controller.js — renamed?`);
    let depth = 0;
    const open = SRC.indexOf('{', start);
    for (let j = open; j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  const stored = Object.create(null);
  const ctx = {
    z, console, URL,
    require: () => ({}),
    pool: {},
    denyHub: () => {},
    logActivity: () => {},
    getSetting: (k) => stored[k] || '',
    putSetting: async (_p, k, v) => { if (v === '') delete stored[k]; else stored[k] = v; },
    linkTtlDays: () => 7,
    describeSetting: (k) => ({ configured: !!stored[k], last4: null, source: stored[k] ? 'database' : null }),
    apiBaseUrl: () => String(stored.public_api_base_url || '').replace(/\/+$/, ''),
    gatewayStatus: () => ({ gateway: 'razorpay', mode: 'test', configured: false, key_id_masked: '', webhook_configured: false }),
    gatewaySettingsPayload: () => ({ ok: true }),
    // Mirrors the real handle()'s ZodError branch: a schema rejection is a 400,
    // a hand-written rejection inside the handler is a 422. The handler does
    // not RETURN handle(...), so the promise is parked here for the caller.
    handle: (req, res, next, fn) => {
      ctx.__pending = Promise.resolve().then(fn).catch((err) => {
        if (err.name === 'ZodError') {
          return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
        }
        throw err;
      });
      return ctx.__pending;
    },
  };
  vm.createContext(ctx);

  const schemaStart = SRC.indexOf('const gatewaySettingsSchema');
  assert.ok(schemaStart > -1, 'gatewaySettingsSchema not found — renamed?');
  vm.runInContext(SRC.slice(schemaStart, SRC.indexOf('function saveGatewaySettings')), ctx);
  vm.runInContext(extract('saveGatewaySettings'), ctx);

  async function put(body) {
    let out = null;
    const res = {
      status(code) { this._code = code; return this; },
      json(payload) { out = { code: this._code || 200, payload }; return this; },
    };
    ctx.__pending = null;
    ctx.saveGatewaySettings({ body, user: { id: 1, name: 'T' } }, res, (e) => { throw e; });
    await ctx.__pending;
    assert.ok(out, 'the handler returned without sending a response');
    return out.code;
  }

  assert.strictEqual(await put({}), 400, 'an empty body was accepted'); n++;

  // ── Key ID shape ──────────────────────────────────────────────────────────
  assert.strictEqual(await put({ key_id: 'rzp_live_ABC123xyz' }), 200); n++;
  assert.strictEqual(stored.razorpay_key_id, 'rzp_live_ABC123xyz'); n++;
  assert.strictEqual(await put({ key_id: 'rzp_test_QQQ999' }), 200); n++;

  // The expensive typo. mode() reads the rzp_test_/rzp_live_ prefix to decide
  // whether this install charges real cards — there is no other switch — so a
  // secret pasted into the ID box would pin it to 'test' forever.
  assert.strictEqual(await put({ key_id: 'someRandomSecretValue' }), 422,
    'a non-Razorpay value was accepted as the Key ID'); n++;
  assert.strictEqual(await put({ key_id: 'rzp_prod_ABC' }), 422,
    'rzp_prod_ is not a Razorpay prefix and must not pass'); n++;

  // Trailing whitespace is STRIPPED, not rejected — a key pasted with a newline
  // on it is the commonest way this field is filled in, and a stored key with a
  // space authenticates as a wrong password.
  assert.strictEqual(await put({ key_id: '  rzp_live_ABC123  ' }), 200); n++;
  assert.strictEqual(stored.razorpay_key_id, 'rzp_live_ABC123',
    'whitespace survived into the stored key'); n++;

  // ── The mirror-image typo: the ID pasted into the SECRET box ─────────────
  assert.strictEqual(await put({ key_secret: 'rzp_live_ABC123' }), 422,
    'the Key ID was accepted as the Key Secret — every callback would fail verification'); n++;
  assert.strictEqual(await put({ key_secret: 'aRealLookingSecret' }), 200); n++;

  // ── The API's public address ─────────────────────────────────────────────
  assert.strictEqual(await put({ api_base_url: 'spinoto-backend.onrender.com' }), 422,
    'a bare host with no scheme was accepted'); n++;
  assert.strictEqual(await put({ api_base_url: 'ftp://x.example' }), 422); n++;
  // The subtle one: Razorpay accepts a webhook URL with a path and then calls a
  // 404 on it forever. Nothing logs, and payments simply never close.
  assert.strictEqual(await put({ api_base_url: 'https://x.example/api' }), 422,
    'a URL with a path was accepted'); n++;
  assert.strictEqual(await put({ api_base_url: 'https://spinoto-backend.onrender.com/' }), 200); n++;
  assert.strictEqual(stored.public_api_base_url, 'https://spinoto-backend.onrender.com',
    'the trailing slash was stored — the webhook URL would carry a double slash'); n++;

  // ── Link lifetime ────────────────────────────────────────────────────────
  for (const bad of ['0', '91', '-1', '7.5']) {
    assert.strictEqual(await put({ link_ttl_days: bad }), 422, `accepted a lifetime of ${bad}`); n++;
  }
  // Too long for the schema, so refused one layer earlier. Asserted separately
  // rather than with a loose >= 400, so a change to either layer is visible.
  assert.strictEqual(await put({ link_ttl_days: 'seven' }), 400); n++;
  assert.strictEqual(await put({ link_ttl_days: '30' }), 200); n++;
  assert.strictEqual(stored.payment_link_ttl_days, '30'); n++;

  // ── Clearing ─────────────────────────────────────────────────────────────
  // '' must reach putSetting and DELETE the row, not be swallowed by a
  // truthiness check that treats it as "field not supplied" and does nothing.
  assert.strictEqual(await put({ key_secret: '' }), 200); n++;
  assert.strictEqual(stored.razorpay_key_secret, undefined,
    'Clear did not remove the stored value'); n++;
}
