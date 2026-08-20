'use strict';

/**
 * RazorpayX adapter — money OUT. The only file outside razorpay.adapter.js that
 * knows a provider's name.
 *
 * ⚠ THIS IS A DIFFERENT PRODUCT FROM THE RAZORPAY YOU ALREADY USE
 *   Different credentials, separate onboarding, a separate webhook secret, and a
 *   source bank account of its own. RAZORPAY_KEY_ID will not work here, and
 *   quietly falling back to it would mean payouts signed with the collections
 *   account — which either fails or, worse, succeeds against the wrong balance.
 *   So the variables are separate and there is no fallback.
 *
 * ⚠ SECRETS
 *   RAZORPAYX_KEY_SECRET and RAZORPAYX_WEBHOOK_SECRET are read from the
 *   environment and never leave this module — not returned, not logged, not put
 *   in an error message. Same reasoning as the collections adapter: a signing
 *   secret must be recoverable in plain form to sign with, so storing it in
 *   Postgres just adds a copy to every backup.
 *
 * MOCK MODE — AND THE TRAP IN IT
 *   With no keys configured this returns a fake `processed` payout, so the whole
 *   flow (press Pay → hub_payouts row → confirmation → hub_payments row →
 *   invoice paid down) is exercisable before a RazorpayX account exists.
 *
 *   That is exactly as dangerous as it is useful: on a staging server with real
 *   hub data and no keys, every payout will report success and every purchase
 *   invoice will read PAID, with not one rupee moved. The mock ids are prefixed
 *   `pout_mock_` and mode() returns 'test' so the rows are identifiable for
 *   ever — check that before believing a payout screen.
 *
 * NO AUTOMATIC PAYOUTS
 *   Nothing in this file is called on a timer. Every function here runs because
 *   a person pressed a button. `purpose` is fixed to 'payout' and there is no
 *   scheduling parameter, deliberately — see services/payouts.service.js.
 */

const crypto = require('crypto');
const {
  toMinorUnit, fromMinorUnit, scrubRaw, safeEqual, gatewayError,
} = require('./types');

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = Number(process.env.RAZORPAYX_TIMEOUT_MS || 20000);

const KEY_ID         = process.env.RAZORPAYX_KEY_ID || '';
const KEY_SECRET     = process.env.RAZORPAYX_KEY_SECRET || '';
const ACCOUNT_NUMBER = process.env.RAZORPAYX_ACCOUNT_NUMBER || '';
const WEBHOOK_SECRET = process.env.RAZORPAYX_WEBHOOK_SECRET || '';

/**
 * All THREE are required, not just the key pair.
 *
 * The source account number is not a nicety: RazorpayX takes it on every payout
 * to say which balance the money comes out of, and a payout without it is a 400
 * from the provider at the worst possible moment. Treating a missing account
 * number as "configured" would put the failure at press time instead of at
 * boot, where a missing setting belongs.
 */
function isConfigured() {
  return Boolean(KEY_ID && KEY_SECRET && ACCOUNT_NUMBER);
}

/**
 * Mock mode is a development tool. On a production server it is a liability.
 *
 * The trap is described at the top of this file: with no keys, every payout
 * reports `processed`, a hub_payments row is written, and the purchase invoice
 * reads PAID — with no money moved. On a laptop that is exactly what you want.
 * On a live server with real hub data it silently falsifies the books, and the
 * only trace is a `pout_mock_` prefix nobody is looking at.
 *
 * So mock mode is REFUSED in production. Every mock return site calls this
 * first. The refusal is a gatewayError, which payouts.service.js already
 * surfaces as "the gateway is not available" rather than a crash.
 *
 * A payouts screen that says it cannot pay is fixed in a minute by setting
 * three variables. A payouts screen that says it paid, when it did not, is
 * discovered at the end of the month by a hub that was not paid.
 *
 * PAYOUT_ALLOW_MOCK=true is the escape hatch, for deliberately exercising the
 * flow on a production build. It warns on every call, because someone who set
 * it three weeks ago has forgotten.
 */
function assertMockAllowed(what) {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.PAYOUT_ALLOW_MOCK === 'true') {
    console.warn(
      `[razorpayx] ⚠ mock ${what} in production (PAYOUT_ALLOW_MOCK=true) — ` +
      'reports success without moving money.'
    );
    return;
  }
  console.error(
    `[razorpayx] refusing to mock ${what} in production. Set RAZORPAYX_KEY_ID, ` +
    'RAZORPAYX_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER, or leave payouts off.'
  );
  throw gatewayError(
    503,
    'Payouts are not configured on this server. No money has been sent.'
  );
}

/** Payout status arrives ONLY by webhook — there is no browser callback for money leaving. */
function isWebhookConfigured() {
  return Boolean(WEBHOOK_SECRET);
}

function mode() {
  if (!isConfigured()) return 'test';
  return KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
}

/** What a settings screen may know. No secret, and no way to derive one. */
function publicKey() {
  return isConfigured() ? KEY_ID : 'rzpx_test_mock';
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
}

/**
 * One place for every outbound call.
 *
 * `idempotencyKey` maps to RazorpayX's own X-Payout-Idempotency header, and it
 * is the most valuable thing in this file. A payout request that times out has
 * not necessarily failed — the money may already be moving — and a naive retry
 * is how a hub gets paid twice. With the header, a repeat of the same key
 * returns the ORIGINAL payout instead of creating a second one, so a retry is
 * safe at the provider rather than merely careful here.
 */
async function call(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    };
    if (idempotencyKey) headers['X-Payout-Idempotency'] = String(idempotencyKey).slice(0, 60);

    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Status and error CODE only in the log. The description can echo request
      // content, which on this side of the system includes bank details.
      console.error('[gateway:razorpayx]', method, path, res.status,
        data?.error?.code || '(no code)');
      throw gatewayError(502, 'The payout service did not respond as expected. No money has been sent — check the payout list before trying again.', {
        gateway_error_code: data?.error?.code || null,
        gateway_error_description: data?.error?.description || null,
      });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[gateway:razorpayx] timeout', method, path);
      // Deliberately NOT "please try again". A timed-out payout may well have
      // been accepted, and the honest instruction is to look before re-sending.
      throw gatewayError(504, 'The payout service did not answer in time. The transfer may still have been accepted — refresh the payout before sending it again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registering a hub as a payee
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A contact is the hub as a PAYEE — a name and our own reference. It is not a
 * bank account; that is the fund account below.
 *
 * `reference_id` carries our hub id so a person looking at the RazorpayX
 * dashboard can tell which of two similarly-named workshops they are looking at.
 * It carries nothing else: contacts are visible in that dashboard and echoed in
 * webhook payloads, so the same rule as the collections adapter's `notes`
 * applies — our own references only, never a customer's details.
 */
async function createContact({ name, referenceId, email = null, contact = null }) {
  if (!name) throw gatewayError(400, 'A payee name is required.');

  if (!isConfigured()) {
    assertMockAllowed('contact creation');
    return { id: `cont_mock_${referenceId || 'x'}`, mock: true };
  }

  const body = {
    name: String(name).slice(0, 50),
    type: 'vendor',
    reference_id: referenceId ? String(referenceId).slice(0, 40) : undefined,
  };
  if (email)   body.email   = String(email).slice(0, 120);
  if (contact) body.contact = String(contact).slice(0, 20);

  const data = await call('/contacts', { method: 'POST', body });
  if (!data.id) throw gatewayError(502, 'Could not register the hub as a payee.');
  return { id: data.id, mock: false };
}

/**
 * A fund account is the bank account itself, bound to a contact.
 *
 * NOT IDEMPOTENT AT THE PROVIDER. Calling this twice creates two fund accounts
 * on the same contact, both valid, both payable, and there is no way to tell
 * from here which one a future lookup would choose. That is the entire reason
 * hubs.payout_fund_account_id is a stored column rather than a lookup, and the
 * reason migration 144 clears it by trigger when the account changes.
 */
async function createFundAccount({ contactId, name, ifsc, accountNumber }) {
  if (!contactId) throw gatewayError(400, 'Register the hub as a payee first.');
  if (!name || !ifsc || !accountNumber) {
    throw gatewayError(400, 'Account holder name, IFSC and account number are all required.');
  }

  if (!isConfigured()) {
    assertMockAllowed('fund account creation');
    return { id: `fa_mock_${String(accountNumber).slice(-4)}`, mock: true };
  }

  const data = await call('/fund_accounts', {
    method: 'POST',
    body: {
      contact_id: contactId,
      account_type: 'bank_account',
      bank_account: {
        name: String(name).slice(0, 120),
        ifsc: String(ifsc).toUpperCase().trim(),
        account_number: String(accountNumber).trim(),
      },
    },
  });
  if (!data.id) throw gatewayError(502, 'Could not register the hub bank account.');
  return { id: data.id, mock: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RazorpayX's own vocabulary → the seven statuses hub_payouts allows.
 *
 * Mapped rather than stored verbatim so the rest of the system never has to
 * learn a provider's words, and so a provider adding an eighth status cannot
 * violate the CHECK constraint on a table nobody was editing that day.
 *
 * 'rejected' folds into 'cancelled' on purpose: from the ledger's point of view
 * both mean the same thing — no money left, and none is going to.
 */
function toPayoutStatus(providerStatus) {
  switch (String(providerStatus || '').toLowerCase()) {
    case 'queued':
    case 'pending':     return 'queued';
    case 'processing':  return 'processing';
    case 'processed':   return 'processed';
    case 'reversed':    return 'reversed';
    case 'cancelled':
    case 'rejected':    return 'cancelled';
    case 'failed':      return 'failed';
    default:            return 'queued';
  }
}

/**
 * Chooses the rail. IMPS under ₹2,00,000, NEFT above it.
 *
 * IMPS is instant but capped at ₹2 lakh per transfer by NPCI — a larger amount
 * is rejected by the bank, not by us, which reads as a mysterious failure hours
 * later. NEFT has no such cap and settles in batches on the same working day.
 * Picking automatically means nobody has to know this to pay a hub.
 */
function railFor(amount) {
  return Number(amount) >= 200000 ? 'NEFT' : 'IMPS';
}

function normalisePayout(p = {}) {
  return {
    gateway_payout_id: p.id || null,
    fund_account_id:   p.fund_account_id || null,
    amount:            fromMinorUnit(p.amount),
    currency:          p.currency || 'INR',
    status:            toPayoutStatus(p.status),
    provider_status:   p.status || null,
    utr:               p.utr || null,
    failure_reason:    p.failure_reason || p.status_details?.description || null,
    raw:               scrubRaw(p),
  };
}

/**
 * Sends money.
 *
 * Returns as soon as the request is ACCEPTED. The money moves over the following
 * minutes-to-days and the payout.processed webhook is what confirms it — the
 * caller must not treat this return value as "the hub has been paid". That rule
 * is enforced one level up, in services/payouts.service.js, which writes nothing
 * to hub_payments here.
 *
 * @param reference our payout_ref — becomes both the provider's narration and
 *                  the idempotency key
 */
async function createPayout({ fundAccountId, amount, reference, mode: rail = null, notes = {} }) {
  if (!fundAccountId) throw gatewayError(400, 'This hub has no registered bank account to pay.');
  const paise = toMinorUnit(amount);
  if (paise < 100) throw gatewayError(400, 'The minimum amount that can be transferred is ₹1.');

  if (!isConfigured()) {
    assertMockAllowed('a payout');
    return {
      id: `pout_mock_${reference || Date.now().toString(36)}`,
      status: 'processed',
      utr: `MOCKUTR${String(reference || '').replace(/\W/g, '').slice(-8)}`,
      fund_account_id: fundAccountId,
      raw: { mock: true },
      mock: true,
    };
  }

  const data = await call('/payouts', {
    method: 'POST',
    // The reference doubles as the idempotency key. A timed-out request retried
    // with the same payout_ref returns the original payout instead of sending
    // the money twice — the one failure mode in this whole feature that cannot
    // be corrected from inside the application.
    idempotencyKey: reference,
    body: {
      account_number: ACCOUNT_NUMBER,
      fund_account_id: fundAccountId,
      amount: paise,
      currency: 'INR',
      mode: rail || railFor(amount),
      purpose: 'payout',
      // 30 characters, alphanumeric — the bank truncates anything longer, and
      // what survives is what the hub sees on its statement.
      narration: String(reference || 'HUB PAYOUT').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30),
      queue_if_low_balance: true,
      reference_id: reference ? String(reference).slice(0, 40) : undefined,
      notes,
    },
  });
  if (!data.id) throw gatewayError(502, 'Could not start the transfer.');

  const n = normalisePayout(data);
  return { id: n.gateway_payout_id, status: n.status, utr: n.utr,
           fund_account_id: n.fund_account_id, raw: n.raw, mock: false };
}

/**
 * The source of truth when a webhook never arrived.
 *
 * Money leaving has no browser callback and no second channel — if the webhook
 * is missed, an in-flight payout stays in-flight for ever unless someone asks.
 * This is what the Refresh button on the payouts screen calls.
 */
async function fetchPayout(payoutId) {
  if (!isConfigured()) {
    assertMockAllowed('a payout status read');
    return {
      gateway_payout_id: payoutId, fund_account_id: null,
      amount: 0, currency: 'INR', status: 'processed', provider_status: 'processed',
      utr: 'MOCKUTR000000', failure_reason: null, raw: { mock: true },
    };
  }
  return normalisePayout(await call(`/payouts/${encodeURIComponent(payoutId)}`));
}

/**
 * Balance on the source account, in rupees.
 *
 * Shown before a batch so "queued for low balance" is a decision rather than a
 * surprise. Never throws at the caller: a balance we could not read is a missing
 * number on a screen, and it must not stop a payout that would have worked.
 */
async function fetchBalance() {
  if (!isConfigured()) return { balance: null, mock: true };
  try {
    const data = await call(`/banking_accounts?account_number=${encodeURIComponent(ACCOUNT_NUMBER)}`);
    const acct = (data.items || [])[0];
    return { balance: acct ? fromMinorUnit(acct.balance) : null, mock: false };
  } catch (err) {
    console.error('[gateway:razorpayx] could not read balance', err.message);
    return { balance: null, error: true };
  }
}

/**
 * Verifies a payout webhook.
 *
 * Same HMAC-over-raw-bytes construction as the collections webhook, keyed with a
 * DIFFERENT secret. Returns FALSE when no secret is configured — never true.
 * This endpoint is an unauthenticated POST from the open internet, and accepting
 * one unverified would let anyone mark a hub paid and close out a real debt.
 */
function verifyWebhookSignature({ rawBody, signature }) {
  if (!WEBHOOK_SECRET) return false;
  if (!rawBody || !signature) return false;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(buf).digest('hex');
  return safeEqual(expected, signature);
}

module.exports = {
  name: 'razorpayx',
  isConfigured,
  isWebhookConfigured,
  publicKey,
  mode,
  createContact,
  createFundAccount,
  createPayout,
  fetchPayout,
  fetchBalance,
  verifyWebhookSignature,
  normalisePayout,
  toPayoutStatus,
  railFor,
};
