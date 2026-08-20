/**
 * Phase 3 — the gateway webhook.
 *
 * This is the only unauthenticated write path in the payments module. Its whole
 * defence is the signature check, so these tests drive the REAL handler with
 * real HMACs and a stubbed pool, and assert on what reached the database.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
let n = 0;

process.env.RAZORPAY_KEY_ID = 'rzp_live_TESTKEY123456';
process.env.RAZORPAY_KEY_SECRET = 'secret_abcdef0123456789';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_fedcba9876543210';

// ── Fake database ───────────────────────────────────────────────────────────
const db = {
  log: [], events: [], txns: [], captured: [], failed: [],
  reset() { this.log = []; this.events = []; this.captured = []; this.failed = []; },
};

function route(sql, params) {
  db.log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 80));
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };

  if (/INSERT INTO payment_webhook_events/.test(sql)) {
    const [gateway, eventId, eventType] = params;
    // The unique index, modelled: a second delivery of the same event inserts
    // nothing and returns rowCount 0.
    if (db.events.some(e => e.gateway === gateway && e.event_id === eventId)) {
      return { rows: [], rowCount: 0 };
    }
    const row = { id: db.events.length + 1, gateway, event_id: eventId, event_type: eventType, status: 'received' };
    db.events.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/UPDATE payment_webhook_events/.test(sql)) {
    const ev = db.events.find(e => e.id === params[0]);
    if (ev) ev.status = /status='processed'/.test(sql) ? 'processed'
                      : /status='ignored'/.test(sql) ? 'ignored' : 'failed';
    return { rows: [], rowCount: 1 };
  }
  if (/FROM payment_transactions\s+WHERE \(\$1::text IS NOT NULL/.test(sql.replace(/\s+/g, ' '))) {
    const [orderId, payId] = params;
    const hit = db.txns.find(t => (orderId && t.gateway_order_id === orderId) ||
                                  (payId && t.gateway_payment_id === payId));
    return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

const fakeClient = { query: async (s, p) => route(s, p), release() {} };
const fakePool = { query: async (s, p) => route(s, p), connect: async () => fakeClient };

for (const [p, mod] of Object.entries({
  [`${BE}/src/config/db.js`]: { pool: fakePool },
  [`${BE}/src/utils/payoutSchedule.js`]: { syncPayoutDueDate: async () => {} },
  [`${BE}/src/helpers/advanceAppointmentStatus.js`]: async () => {},
  [`${BE}/src/controllers/warranty_claims.controller.js`]: { resolveClaimForEstimate: async () => {} },
  // The controller destructures these at require time, so a later reassignment
  // of the export would have no effect — hence the indirection through
  // db.captureThrows rather than swapping the function out.
  [`${BE}/src/services/payments.service.js`]: {
    captureVerifiedPayment: async (a) => {
      if (db.captureThrows) throw new Error('database on fire');
      db.captured.push(a); return { captured: true, duplicate: false };
    },
    markFailed: async (a) => { db.failed.push(a); },
  },
  [`${BE}/src/services/refunds.service.js`]: {
    applyRefundOutcome: async (a) => { db.refundApplied = a; return {}; },
  },
})) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}

const wh = require(`${BE}/src/controllers/webhooks.payments.controller.js`);

// ── Request/response doubles ────────────────────────────────────────────────
function sign(body, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
function makeReq(bodyStr, { signature, eventId, noRaw = false } = {}) {
  const headers = {};
  if (signature !== null) headers['x-razorpay-signature'] = signature ?? sign(bodyStr);
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  return {
    ip: '203.0.113.9',
    rawBody: noRaw ? undefined : Buffer.from(bodyStr, 'utf8'),
    body: JSON.parse(bodyStr),
    get: h => headers[h.toLowerCase()],
  };
}
function makeRes() {
  const r = { code: 200, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

const capturedEvent = (payId = 'pay_1', orderId = 'order_1') => JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: {
    id: payId, order_id: orderId, amount: 200000, currency: 'INR',
    status: 'captured', method: 'upi',
    email: 'customer@example.com', contact: '+919876543210',
  } } },
});

(async () => {
  // ── A valid, signed capture is processed ──────────────────────────────────
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', gateway_payment_id: null, entity_type: 'customer_invoice', entity_id: 42 }];
  let body = capturedEvent();
  let res = makeRes();
  await wh.handleWebhook(makeReq(body, { eventId: 'evt_A' }), res);
  assert.strictEqual(res.code, 200); n++;
  assert.strictEqual(res.body.ok, true); n++;
  assert.strictEqual(db.captured.length, 1, 'a valid capture event did not capture'); n++;
  assert.strictEqual(db.captured[0].txnId, 7); n++;
  assert.strictEqual(db.captured[0].via, 'webhook', 'the capture path must know where it came from'); n++;
  assert.strictEqual(db.events[0].status, 'processed'); n++;

  // ── Forgeries: nothing is written, and the response says 401 ──────────────
  for (const [why, sig] of [
    ['a wrong signature',        'deadbeef'.repeat(8)],
    ['no signature header',      null],
    ['an empty signature',       ''],
    ['a signature from the API secret', sign(capturedEvent(), process.env.RAZORPAY_KEY_SECRET)],
    ['a truncated signature',    sign(capturedEvent()).slice(0, 32)],
  ]) {
    db.reset();
    db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
    res = makeRes();
    await wh.handleWebhook(makeReq(capturedEvent(), { signature: sig }), res);
    assert.strictEqual(res.code, 401, `${why} was not rejected`); n++;
    assert.strictEqual(db.captured.length, 0, `${why} still captured a payment`); n++;
    assert.strictEqual(db.events.length, 0, `${why} reached the database`); n++;
    assert.ok(db.log.length === 0, `${why} issued ${db.log.length} queries before verification`); n++;
  }

  // A body tampered with AFTER signing — the single attack this defends against.
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  const honest = capturedEvent();
  const tampered = honest.replace('200000', '999999');
  res = makeRes();
  await wh.handleWebhook(makeReq(tampered, { signature: sign(honest) }), res);
  assert.strictEqual(res.code, 401, 'a tampered amount was accepted'); n++;
  assert.strictEqual(db.captured.length, 0); n++;

  // ── Idempotency: the same event delivered twice ───────────────────────────
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  body = capturedEvent();
  await wh.handleWebhook(makeReq(body, { eventId: 'evt_B' }), makeRes());
  res = makeRes();
  await wh.handleWebhook(makeReq(body, { eventId: 'evt_B' }), res);
  assert.strictEqual(res.code, 200, 'a redelivery must be 200 — anything else means infinite retries'); n++;
  assert.strictEqual(res.body.duplicate, true); n++;
  assert.strictEqual(db.captured.length, 1, 'a redelivered event captured the payment TWICE'); n++;
  assert.strictEqual(db.events.length, 1); n++;

  // With no event-id header, the body digest is the identity — deduplication
  // must still work, because that header is not guaranteed.
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  await wh.handleWebhook(makeReq(body), makeRes());
  res = makeRes();
  await wh.handleWebhook(makeReq(body), res);
  assert.strictEqual(res.body.duplicate, true,
    'without an event-id header, redeliveries are not deduplicated at all'); n++;
  assert.strictEqual(db.captured.length, 1); n++;
  assert.ok(db.events[0].event_id.startsWith('sha256:'), 'the fallback identity is not a body digest'); n++;

  // Two DIFFERENT events must not collide.
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 },
             { id: 8, gateway_order_id: 'order_2', entity_type: 'customer_invoice', entity_id: 43 }];
  await wh.handleWebhook(makeReq(capturedEvent('pay_1', 'order_1')), makeRes());
  await wh.handleWebhook(makeReq(capturedEvent('pay_2', 'order_2')), makeRes());
  assert.strictEqual(db.captured.length, 2, 'two distinct events were deduplicated into one'); n++;

  // ── Unknown event types are stored and ignored, not failed ────────────────
  db.reset();
  db.txns = [];
  res = makeRes();
  await wh.handleWebhook(makeReq(JSON.stringify({ event: 'order.paid', payload: {} })), res);
  assert.strictEqual(res.code, 200); n++;
  assert.strictEqual(res.body.ignored, 'order.paid'); n++;
  assert.strictEqual(db.events[0].status, 'ignored'); n++;
  assert.strictEqual(db.captured.length, 0); n++;

  // ── An event for an order we never created ────────────────────────────────
  // Almost always a test webhook pointing at production. Recorded, not fatal.
  db.reset();
  db.txns = [];
  res = makeRes();
  await wh.handleWebhook(makeReq(capturedEvent('pay_x', 'order_unknown')), res);
  assert.strictEqual(res.code, 200); n++;
  assert.strictEqual(db.captured.length, 0, 'an unmatched event captured something'); n++;
  assert.strictEqual(db.events[0].status, 'processed'); n++;

  // ── payment.failed ────────────────────────────────────────────────────────
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  await wh.handleWebhook(makeReq(JSON.stringify({
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_f', order_id: 'order_1', error_code: 'BAD_CARD', error_description: 'Declined' } } },
  })), makeRes());
  assert.strictEqual(db.failed.length, 1, 'payment.failed did not mark the transaction failed'); n++;
  assert.strictEqual(db.failed[0].code, 'BAD_CARD'); n++;
  assert.strictEqual(db.captured.length, 0, 'a failure was captured as a payment'); n++;

  // ── refund.processed reaches the refund service ───────────────────────────
  db.reset(); db.refundApplied = null;
  await wh.handleWebhook(makeReq(JSON.stringify({
    event: 'refund.processed',
    payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 50000 } } },
  })), makeRes());
  assert.ok(db.refundApplied, 'refund.processed was not dispatched'); n++;
  assert.strictEqual(db.refundApplied.outcome, 'processed'); n++;
  // Paise → rupees at the boundary, so no downstream code has to remember.
  assert.strictEqual(db.refundApplied.amount, 500, 'the refund amount was not converted from paise'); n++;

  db.reset(); db.refundApplied = null;
  await wh.handleWebhook(makeReq(JSON.stringify({
    event: 'refund.failed',
    payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_1', amount: 50000 } } },
  })), makeRes());
  assert.strictEqual(db.refundApplied.outcome, 'failed'); n++;

  // ── A handler that throws still answers 200 ──────────────────────────────
  // A 5xx makes the gateway retry a broken handler every few minutes and,
  // eventually, disable the endpoint entirely — losing the events that WOULD
  // have worked. The event row keeps it replayable.
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  db.captureThrows = true;
  res = makeRes();
  await wh.handleWebhook(makeReq(capturedEvent('pay_boom', 'order_1')), res);
  assert.strictEqual(res.code, 200, 'a handler failure returned non-2xx and will be retried forever'); n++;
  assert.strictEqual(res.body.deferred, true); n++;
  assert.strictEqual(db.events[0].status, 'failed', 'a failed handler was not recorded as failed'); n++;
  db.captureThrows = false;

  // ── Malformed and missing input ──────────────────────────────────────────
  db.reset();
  res = makeRes();
  const junk = '{not json';
  await wh.handleWebhook({
    ip: '1.2.3.4', rawBody: Buffer.from(junk), body: {},
    get: h => (h.toLowerCase() === 'x-razorpay-signature' ? sign(junk) : undefined),
  }, res);
  assert.strictEqual(res.code, 400, 'malformed JSON was not rejected'); n++;
  assert.strictEqual(db.events.length, 0); n++;

  // ── No webhook secret configured ⇒ refuse, loudly ────────────────────────
  // The dangerous default. Without a secret nothing can be verified, and an
  // endpoint that accepts anything is a "mark any invoice paid" button.
  const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  for (const k of Object.keys(require.cache)) if (k.includes('/services/gateway/')) delete require.cache[k];
  delete require.cache[`${BE}/src/controllers/webhooks.payments.controller.js`];
  const wh2 = require(`${BE}/src/controllers/webhooks.payments.controller.js`);
  db.reset();
  db.txns = [{ id: 7, gateway_order_id: 'order_1', entity_type: 'customer_invoice', entity_id: 42 }];
  res = makeRes();
  await wh2.handleWebhook(makeReq(capturedEvent(), { signature: 'anything' }), res);
  assert.strictEqual(res.code, 503, 'an unconfigured webhook accepted a request'); n++;
  assert.strictEqual(db.captured.length, 0, 'an unconfigured webhook CAPTURED A PAYMENT'); n++;
  assert.strictEqual(db.events.length, 0); n++;
  process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;

  // ── Source-level guarantees ──────────────────────────────────────────────
  const src = fs.readFileSync(`${BE}/src/controllers/webhooks.payments.controller.js`, 'utf8');
  // Verification must come before the first database call, textually as well as
  // behaviourally — the ordering is the whole security property.
  const verifyAt = src.indexOf('verifyWebhookSignature');
  const firstQuery = src.indexOf('pool.query');
  assert.ok(verifyAt > 0 && verifyAt < firstQuery,
    'a database call appears before signature verification'); n++;
  assert.ok(/ON CONFLICT \(gateway, event_id\) DO NOTHING/.test(src),
    'the event claim is not an atomic upsert — two concurrent deliveries both process'); n++;
  // No console call may pass the raw body or the signature as a VALUE. String
  // literals mentioning the word are fine and unavoidable — the log line
  // "signature verification FAILED" is the one that makes an attack visible.
  // So the check strips literals first and then looks for the identifiers.
  const consoleCalls = [...src.matchAll(/console\.\w+\(([^;]*?)\);/gs)].map(m => m[1]);
  assert.ok(consoleCalls.length >= 3, 'the console-call scan found nothing — the regex is broken'); n++;
  for (const call of consoleCalls) {
    const args = call.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    for (const secret of ['rawBody', 'signature', 'req.body', 'body)']) {
      assert.ok(!args.includes(secret),
        `a console call logs ${secret}: ${call.trim().slice(0, 70)}`); n++;
    }
  }

  const routes = fs.readFileSync(`${BE}/src/routes/webhooks.payments.routes.js`, 'utf8');
  // Comments stripped: the file explains in prose that requireAuth is
  // deliberately absent, and matching that prose is not a finding.
  const routeCode = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/requireAuth/.test(routeCode),
    'the webhook route requires auth — the gateway has no session and every event would be rejected'); n++;
  assert.ok(/rateLimit\(/.test(routeCode), 'the public webhook is not rate limited'); n++;

  // server.js: rawBody must be captured, and the webhook mounted separately
  // from the authenticated payments router.
  const server = fs.readFileSync(`${BE}/src/server.js`, 'utf8');
  assert.ok(/verify:\s*\(req, _res, buf\) => \{ req\.rawBody = buf; \}/.test(server),
    'express.json no longer captures rawBody — every webhook signature will fail'); n++;
  const jsonAt = server.indexOf('express.json');
  const whAt = server.indexOf("app.use('/api/webhooks'");
  assert.ok(jsonAt > 0 && whAt > jsonAt,
    'the webhook is mounted before the body parser that captures rawBody'); n++;
  assert.ok(/app\.use\('\/api\/webhooks',/.test(server), 'the webhook router is not mounted'); n++;

  console.log(`webhook: ${n} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
