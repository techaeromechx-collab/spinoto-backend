'use strict';

/**
 * Razorpay adapter — the ONLY file in this codebase that knows the provider.
 *
 * ⚠ SECRETS
 *   RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET never leave this module.
 *   Nothing here returns them, logs them, or puts them in an error message.
 *   `publicKey()` returns the key_id, which is designed to be embedded in a web
 *   page — that one is safe and is the only credential the browser ever sees.
 *
 * ── WHERE THE CREDENTIALS COME FROM ─────────────────────────────────────────
 *
 *   getSetting() — the `integration_settings` row if an admin set one from the
 *   Gateway screen, otherwise the environment variable, otherwise ''.
 *
 *   This module used to read process.env directly, into three module-level
 *   CONSTANTS evaluated at import time. Two things were wrong with that and
 *   both are worth stating, because the obvious "just add a settings table"
 *   change would have reintroduced them:
 *
 *   1. Frozen at boot. A value saved from the UI would not take effect until
 *      someone restarted the API — and the screen would cheerfully report
 *      "source: database" while every charge still used the old key. A
 *      configuration screen that lies about being in effect is worse than no
 *      screen. Hence functions, not constants: every call reads the cache as
 *      it is now.
 *
 *   2. The webhook secret is the one that must not be forgotten. Store the API
 *      keys in the database but leave the webhook secret on env, and taking
 *      payments starts working immediately while the webhook that MARKS them
 *      paid silently keeps failing — money arrives and no invoice closes. All
 *      three move together or none of them do.
 *
 *   getSetting is synchronous by contract (see integrationSettings.service.js):
 *   an in-memory cache, primed at boot and refreshed on a 60s tick. That
 *   matters here more than anywhere — verifyWebhookSignature runs inside the
 *   webhook's 3-second ack budget, where a DB round trip is exactly what the
 *   ack-first design exists to avoid.
 *
 * ── ON STORING A SIGNING SECRET IN POSTGRES ─────────────────────────────────
 *
 *   It is a real trade and it was made deliberately. A signing secret has to be
 *   recoverable in plain form to sign with, so this puts a readable copy in
 *   every database backup and in front of anyone with read access to the table.
 *   The alternative — env only — was costing a redeploy for every key rotation
 *   on a host where the operator does not have a shell, which in practice meant
 *   the webhook secret went unset and payments went unrecorded. A secret that
 *   is in the database and working beats one that is in the environment and
 *   absent. If that calculus ever changes, leave the env var set: it still
 *   wins whenever there is no database row.
 *
 *   The api_keys pattern (migration 103) is NOT applicable here: it stores a
 *   SHA-256 hash, which works only because those keys are verified and never
 *   used to sign.
 *
 * MOCK MODE
 *   With no keys configured, this adapter runs a mock that the booking SPA
 *   already understands (`key_id: 'rzp_test_mock'`, order ids prefixed
 *   `order_mock_`). That is how the flow stays testable before a merchant
 *   account exists, and it is why signature verification returns true in mock
 *   mode: nothing was really charged, so there is nothing to forge. The moment
 *   real keys are present, verification is enforced with no code change.
 *
 * TIMEOUTS
 *   Every outbound call is bounded. A gateway that hangs must surface as a
 *   failed transaction the webhook can later correct, not as a request that
 *   holds a database connection until the reverse proxy gives up.
 */

const crypto = require('crypto');
const {
  toMinorUnit, fromMinorUnit, scrubRaw, safeEqual, gatewayError,
} = require('./types');
const { getSetting } = require('../integrationSettings.service');

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = Number(process.env.RAZORPAY_TIMEOUT_MS || 15000);

// Functions, not constants — see the header. Each returns '' when unset, so
// every truthiness check below reads the same as it did before.
const keyId         = () => getSetting('razorpay_key_id');
const keySecret     = () => getSetting('razorpay_key_secret');
const webhookSecret = () => getSetting('razorpay_webhook_secret');

const MOCK_KEY_ID = 'rzp_test_mock';

/** True when real credentials are present. False ⇒ mock mode. */
function isConfigured() {
  return Boolean(keyId() && keySecret());
}

/** True when webhooks can be verified. Without this, webhooks are refused. */
function isWebhookConfigured() {
  return Boolean(webhookSecret());
}

/**
 * The key the browser is allowed to see.
 *
 * Razorpay key ids are prefixed rzp_test_ or rzp_live_, so the mode is derived
 * from the key itself rather than from a separate variable someone can forget
 * to flip. A PAYMENT_MODE env var that disagreed with the key would be worse
 * than no variable at all.
 */
function publicKey() {
  return isConfigured() ? keyId() : MOCK_KEY_ID;
}

function mode() {
  if (!isConfigured()) return 'test';
  return keyId().startsWith('rzp_live_') ? 'live' : 'test';
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${keyId()}:${keySecret()}`).toString('base64');
}

/**
 * One place for every outbound call, so the timeout, the auth header and the
 * "never log the response body verbatim" rule are applied uniformly.
 *
 * The thrown message is always customer-safe. The gateway's own text can name
 * internal ids and is written for developers, so it goes to the server log and
 * the caller gets a sentence a person can act on.
 */
async function call(path, { method = 'GET', body = null } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Status and error CODE only. The description can echo request content.
      console.error('[gateway:razorpay]', method, path, res.status,
        data?.error?.code || '(no code)');
      throw gatewayError(502, 'The payment service did not respond as expected. Please try again in a moment.', {
        gateway_error_code: data?.error?.code || null,
        gateway_error_description: data?.error?.description || null,
      });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[gateway:razorpay] timeout', method, path);
      throw gatewayError(504, 'The payment service is taking too long to respond. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param amount  RUPEES (converted to paise here — see types.toMinorUnit for
 *                why the rounding matters)
 * @param receipt our own reference; shows up in the Razorpay dashboard
 * @param notes   small key/value map. NEVER put a full mobile, an address or
 *                anything else personal here: notes are visible in the gateway
 *                dashboard and echoed back in webhook payloads.
 */
async function createOrder({ amount, receipt, notes = {} }) {
  const paise = toMinorUnit(amount);
  if (paise < 100) {
    // Razorpay's own floor is ₹1. Catching it here gives a sentence instead of
    // a 400 from the provider halfway through checkout.
    throw gatewayError(400, 'The minimum amount that can be paid online is ₹1.');
  }

  if (!isConfigured()) {
    return { id: `order_mock_${receipt}`, key_id: MOCK_KEY_ID, mock: true };
  }

  const data = await call('/orders', {
    method: 'POST',
    body: { amount: paise, currency: 'INR', receipt, notes },
  });
  if (!data.id) {
    throw gatewayError(502, 'Could not start the payment. Please try again in a moment.');
  }
  return { id: data.id, key_id: keyId(), mock: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPI QR codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Razorpay's own bounds on close_by: not less than 2 minutes and not more than
 * 2 HOURS from creation. The ceiling is the important one and it is not
 * negotiable — it is why a QR cannot be printed on an invoice and left to work
 * for a week. Anything built on top of this has to assume the code dies the
 * same session it was shown.
 */
const QR_MIN_TTL_SEC = 2 * 60;
const QR_MAX_TTL_SEC = 2 * 60 * 60;
const QR_DEFAULT_TTL_SEC = 30 * 60;

/**
 * Creates a fixed-amount, single-use UPI QR.
 *
 * WHY fixed_amount AND single_use, TOGETHER
 * ─────────────────────────────────────────
 * `fixed_amount: true` with `payment_amount` set means the customer's UPI app
 * shows the amount already filled in and will not let them change it. Without
 * it the QR is an open collection point: someone scans it and types whatever
 * they like, and the invoice gets a payment that matches nothing.
 *
 * `single_use` closes the code the moment it is paid. A multiple_use QR against
 * one invoice would let a second customer — or the same one, twice — pay the
 * same balance again, and this system has no path to notice that until a
 * refund is being argued about.
 *
 * NOTES ARE PUBLIC-ISH
 * ────────────────────
 * They appear in the gateway dashboard and are echoed back in webhooks, so the
 * same rule as createOrder applies: our own references only, never a mobile or
 * a name.
 *
 * @param amount      RUPEES
 * @param receipt     our txn_ref
 * @param ttlSeconds  clamped into Razorpay's window
 * @returns { id, image_url, close_by, mock }
 */
async function createQrCode({ amount, receipt, ttlSeconds = QR_DEFAULT_TTL_SEC, notes = {}, description = null }) {
  const paise = toMinorUnit(amount);
  if (paise < 100) {
    throw gatewayError(400, 'The minimum amount that can be collected by UPI QR is ₹1.');
  }

  const ttl = Math.max(QR_MIN_TTL_SEC, Math.min(Number(ttlSeconds) || QR_DEFAULT_TTL_SEC, QR_MAX_TTL_SEC));
  const closeBy = Math.floor(Date.now() / 1000) + ttl;

  if (!isConfigured()) {
    // A placeholder image so the modal, the layout and the polling can all be
    // exercised without a merchant account. It deliberately encodes a string
    // that is NOT a upi:// intent — a mock that produced a scannable payment
    // request would be a way to send real money into a void.
    const { qrDataUri } = require('../../utils/qr');
    return {
      id: `qr_mock_${receipt}`,
      image_url: await qrDataUri(`spinoto-mock-qr:${receipt}`, { size: 300 }),
      close_by: closeBy,
      mock: true,
    };
  }

  const body = {
    type: 'upi_qr',
    usage: 'single_use',
    fixed_amount: true,
    payment_amount: paise,
    close_by: closeBy,
    notes,
  };
  if (description) body.description = String(description).slice(0, 100);

  const data = await call('/payments/qr_codes', { method: 'POST', body });
  if (!data.id) {
    throw gatewayError(502, 'Could not create the payment QR. Please try again in a moment.');
  }

  // WE DRAW THE CODE, NOT THE GATEWAY
  // ─────────────────────────────────
  // `image_url` is a Razorpay-hosted POSTER, not a QR: a tall image with their
  // branding, the payment-app logos, and the merchant's registered legal name
  // printed across the bottom. Three problems with showing it directly —
  //
  //   1. it is not square, so any fixed box either distorts it or shrinks the
  //      actual code inside it to something a phone struggles to read;
  //   2. the name on it is the Razorpay ACCOUNT's legal name, which is not the
  //      name this workshop trades under and not what a customer expects to see;
  //   3. it is a remote fetch on every render, so a slow link means a blank box
  //      where the payment instruction should be.
  //
  // `image_content` is the raw upi:// intent Razorpay built — the same payment,
  // without the poster around it. Drawing it with the qrcode package the
  // invoices already use gives a square, sharp code at whatever size we want.
  //
  // The hosted image stays as the fallback: if the qrcode package is missing,
  // a branded poster is still infinitely better than no QR at all.
  let imageUrl = data.image_url || null;
  if (data.image_content) {
    const { qrDataUri } = require('../../utils/qr');
    const own = await qrDataUri(data.image_content, { size: 420 });
    if (own) imageUrl = own;
  }

  if (!imageUrl) {
    throw gatewayError(502, 'Could not create the payment QR. Please try again in a moment.');
  }

  return {
    id: data.id,
    image_url: imageUrl,
    hosted_url: data.image_url || null,
    close_by: data.close_by || closeBy,
    mock: false,
  };
}

/**
 * Closes a QR early — a cancelled invoice, or staff dismissing the modal.
 *
 * Never throws at the caller. A QR that outlives its reason is a small problem
 * with a two-hour ceiling on it; an exception here would be a large one, in the
 * middle of an unrelated request.
 */
async function closeQrCode(qrId) {
  if (!qrId) return { id: null, status: 'closed', skipped: true };
  if (!isConfigured()) return { id: qrId, status: 'closed', mock: true };
  try {
    const data = await call(`/payments/qr_codes/${encodeURIComponent(qrId)}/close`, { method: 'POST' });
    return { id: data.id || qrId, status: data.status || 'closed' };
  } catch (err) {
    console.error('[gateway:razorpay] could not close QR', qrId, err.message);
    return { id: qrId, status: 'unknown', error: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification — the security core of this module
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the checkout callback: HMAC-SHA256 of "order_id|payment_id" keyed
 * with the API secret.
 *
 * This is what stops a browser from POSTing `{status:'success'}` and marking an
 * invoice paid. Only the gateway and this server know the secret, so only they
 * can produce this digest. Nothing about a payment is believed without it.
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  // ── MOCK MODE ONLY, AND ONLY WHEN THE ORDER IS ALSO A MOCK ────────────────
  //
  // This used to be a bare `if (!isConfigured()) return true`, which made a
  // MISSING credential indistinguishable from a deliberate mock. One blank or
  // mistyped RAZORPAY_KEY_SECRET — a rotation, a secret-manager miss — and the
  // whole install silently became: anyone with a pay link POSTs
  // /verify with any signature they like, and the invoice is marked paid, the
  // ledger row written, the appointment closed and the hub payout scheduled,
  // for ₹0 received. Nothing else looked broken, because webhooks kept working
  // on their own separate secret.
  //
  // The order id is the discriminator. createOrder only ever returns an
  // `order_mock_…` id when it took the mock branch, so a real Razorpay order id
  // arriving here while the keys are missing means the keys were present when
  // the order was made and have since gone — exactly the case that must fail.
  //
  // Everything else stays as it was: with real keys, this is the HMAC that
  // stops a browser from POSTing {status:'success'}.
  if (!isConfigured()) {
    const isMockOrder = typeof orderId === 'string' && orderId.startsWith('order_mock_');
    if (!isMockOrder) {
      console.error('[gateway:razorpay] REFUSED a callback for a real order while '
        + 'RAZORPAY_KEY_ID/SECRET are not configured — check the environment');
    }
    return isMockOrder;
  }
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', keySecret())
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqual(expected, signature);
}

/**
 * Verifies a webhook: HMAC-SHA256 over the EXACT bytes received, keyed with the
 * webhook secret (a different secret from the API one).
 *
 * `rawBody` must be the untouched request body. server.js keeps it on
 * `req.rawBody` via express.json's verify hook — the same mechanism the
 * WhatsApp webhook already relies on. Re-serialising the parsed object produces
 * different bytes (key order, whitespace, number formatting) and every check
 * would fail.
 *
 * Note the asymmetry with the callback above: this returns FALSE when no
 * webhook secret is configured, where the callback returns true in mock mode.
 * A callback arrives inside a session we started; a webhook is an unauthenticated
 * POST from the open internet, and accepting one unverified would let anyone
 * mark any invoice paid.
 */
function verifyWebhookSignature({ rawBody, signature }) {
  // Read ONCE into a local. Not for speed — so the bytes are signed with the
  // same secret the emptiness check passed on, even if the 60s cache refresh
  // lands between the two lines.
  const secret = webhookSecret();
  if (!secret) return false;
  if (!rawBody || !signature) return false;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(buf).digest('hex');
  return safeEqual(expected, signature);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads and refunds
// ─────────────────────────────────────────────────────────────────────────────

/** Normalises a gateway payment object into the shape this module stores. */
function normalisePayment(p) {
  return {
    gateway_payment_id: p.id || null,
    gateway_order_id:   p.order_id || null,
    amount:             fromMinorUnit(p.amount),
    amount_refunded:    fromMinorUnit(p.amount_refunded || 0),
    currency:           p.currency || 'INR',
    captured:           p.status === 'captured',
    status:             p.status || null,
    method_detail:      p.method || null,
    error_code:         p.error_code || null,
    error_description:  p.error_description || null,
    raw:                scrubRaw(p),
  };
}

/**
 * The source of truth when the two client-side signals disagree, and the
 * fallback when the browser never came back at all. Always preferred over
 * anything the client sent.
 */
async function fetchPayment(paymentId) {
  if (!isConfigured()) {
    return {
      gateway_payment_id: paymentId, gateway_order_id: null,
      amount: 0, amount_refunded: 0, currency: 'INR',
      captured: true, status: 'captured', method_detail: 'mock',
      error_code: null, error_description: null, raw: { mock: true },
    };
  }
  return normalisePayment(await call(`/payments/${encodeURIComponent(paymentId)}`));
}

/**
 * Asks the gateway to send money back. Returns as soon as the request is
 * ACCEPTED — the money moves over the following days and the refund.processed
 * webhook is what confirms it. The caller must not treat this return value as
 * "the customer has their money".
 */
async function createRefund({ paymentId, amount, notes = {} }) {
  if (!isConfigured()) {
    return { id: `rfnd_mock_${Date.now().toString(36)}`, status: 'processed', raw: { mock: true } };
  }
  const data = await call(`/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    body: { amount: toMinorUnit(amount), speed: 'normal', notes },
  });
  return {
    id: data.id || null,
    status: data.status || 'pending',   // 'pending' | 'processed' | 'failed'
    raw: scrubRaw(data),
  };
}

/**
 * Settlements — the transfers from the gateway's balance to the company's bank
 * account. A settlement is NOT a payment: it is one lump covering many
 * payments, minus fees, arriving days later. Read-only reconciliation data.
 */
async function listSettlements({ from, to, count = 100 } = {}) {
  if (!isConfigured()) return [];
  const qs = new URLSearchParams({ count: String(Math.min(count, 100)) });
  if (from) qs.set('from', String(Math.floor(new Date(from).getTime() / 1000)));
  if (to)   qs.set('to',   String(Math.floor(new Date(to).getTime() / 1000)));
  const data = await call(`/settlements?${qs}`);
  return (data.items || []).map(s => ({
    gateway_settlement_id: s.id,
    amount: fromMinorUnit(s.amount),
    fees:   fromMinorUnit(s.fees),
    tax:    fromMinorUnit(s.tax),
    utr:    s.utr || null,
    status: s.status || null,
    settled_at: s.created_at ? new Date(s.created_at * 1000).toISOString() : null,
    raw: scrubRaw(s),
  }));
}

/**
 * WHICH PAYMENTS MADE UP A SETTLEMENT.
 *
 * listSettlements above answers "₹9,791 reached the bank on 14 August". This
 * answers "and here are the payments inside it" — which is the only question
 * worth asking when the first number is not what you expected.
 *
 * ── WHY THIS IS KEYED BY DATE AND NOT BY SETTLEMENT ─────────────────────────
 * Because Razorpay's recon endpoint is. There is no "give me the contents of
 * settlement setl_XXX" call; there is a report of everything settled on a given
 * day, and each row names the settlement it belonged to. So the caller walks
 * the distinct dates it just fetched, and every row comes back already carrying
 * the settlement id to match on.
 *
 * ── ONLY type = 'payment' ROWS ──────────────────────────────────────────────
 * The report also carries refunds and adjustments. A refund row's entity_id is
 * an rfnd_… id, which matches no payment_transaction; worse, its payment_id
 * WOULD match one, and linking a transaction to the settlement that carried its
 * refund out would attach a payment to a settlement it was never part of. The
 * filter is what keeps "which payments are in this settlement" literally true.
 *
 * ── PAGINATION IS NOT OPTIONAL ──────────────────────────────────────────────
 * A busy day is more than 100 rows and the API caps a page at 100. Stopping at
 * the first page would silently link the first hundred payments and leave the
 * rest looking unsettled — a wrong answer that looks like a complete one.
 * MAX_PAGES is a runaway guard, not an expected limit; hitting it is logged.
 *
 * @param {number} year   full year, e.g. 2026
 * @param {number} month  1-12
 * @param {number} day    1-31
 * @returns {Promise<Array<{gateway_settlement_id, gateway_payment_id, utr}>>}
 */
const RECON_PAGE = 100;
const RECON_MAX_PAGES = 25;

async function listSettlementRecon({ year, month, day } = {}) {
  if (!isConfigured()) return [];
  if (!year || !month) return [];

  const out = [];
  for (let page = 0; page < RECON_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      year:  String(year),
      month: String(month),
      count: String(RECON_PAGE),
      skip:  String(page * RECON_PAGE),
    });
    if (day) qs.set('day', String(day));

    const data = await call(`/settlements/recon/combined?${qs}`);
    const items = data.items || [];

    for (const r of items) {
      if (r.type && r.type !== 'payment') continue;
      const paymentId = r.entity_id || r.payment_id || null;
      if (!paymentId || !r.settlement_id) continue;
      out.push({
        gateway_settlement_id: r.settlement_id,
        gateway_payment_id: paymentId,
        utr: r.settlement_utr || null,
      });
    }

    // A short page is the last page. Checked against what the API returned, not
    // against what survived the filter above — a day of nothing but refunds
    // would otherwise look like the end of the report on its first page.
    if (items.length < RECON_PAGE) return out;

    if (page === RECON_MAX_PAGES - 1) {
      console.warn(`[gateway:razorpay] settlement recon for ${year}-${month}-${day || 'all'} `
        + `hit the ${RECON_MAX_PAGES}-page cap; some payments were not linked`);
    }
  }
  return out;
}

module.exports = {
  name: 'razorpay',
  isConfigured,
  isWebhookConfigured,
  publicKey,
  mode,
  createOrder,
  createQrCode,
  closeQrCode,
  QR_MIN_TTL_SEC,
  QR_MAX_TTL_SEC,
  QR_DEFAULT_TTL_SEC,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
  createRefund,
  listSettlements,
  listSettlementRecon,
  normalisePayment,
};
