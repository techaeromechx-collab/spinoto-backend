/**
 * UPI QR payments.
 *
 * The feature has one failure mode that matters more than every other one
 * combined: a customer scans, pays, and Spinoto never records it. There is no
 * browser callback to fall back on — the webhook is the ONLY notification — so
 * most of what is pinned here is the chain that makes the webhook able to find
 * its own transaction, and the guard that refuses to create a QR when that
 * chain is not connected.
 *
 * Service behaviour is exercised against a stubbed pg pool: the assertions are
 * about what the code does, not what its comments claim.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripSql = s => s.replace(/^\s*--.*$/gm, '');

process.env.RAZORPAY_KEY_ID = 'rzp_live_TESTKEY123456';
process.env.RAZORPAY_KEY_SECRET = 'secret_abcdef0123456789';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_0123456789';

// ── Fake database ───────────────────────────────────────────────────────────
const db = {
  log: [], invoice: null, txn: null, updates: [],
  reset() { this.log = []; this.updates = []; this.txn = null; },
};

function route(sql, params) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  db.log.push(flat.slice(0, 110));

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };

  if (/FROM customer_invoices ci\s+LEFT JOIN appointments/.test(sql)) {
    return { rows: db.invoice ? [db.invoice] : [], rowCount: db.invoice ? 1 : 0 };
  }
  if (/INSERT INTO payment_transactions/.test(sql)) {
    db.txn = {
      id: 88, txn_ref: params[0], gateway: params[1], mode: params[2],
      entity_type: 'customer_invoice', entity_id: params[3], hub_id: params[4],
      mobile: params[5], amount: params[6], status: 'created',
      gateway_qr_id: params[7], qr_image_url: params[8], qr_expires_at: params[9],
      created_by: params[10], gateway_order_id: null, gateway_payment_id: null,
      _insertSql: flat, _insertParams: params,
    };
    return { rows: [db.txn], rowCount: 1 };
  }
  if (/SELECT \* FROM payment_transactions WHERE txn_ref/.test(flat)) {
    return { rows: db.txn && db.txn.txn_ref === params[0] ? [db.txn] : [], rowCount: db.txn ? 1 : 0 };
  }
  if (/SELECT \* FROM payment_transactions WHERE id = \$1$/.test(flat)) {
    return { rows: db.txn ? [db.txn] : [], rowCount: db.txn ? 1 : 0 };
  }
  if (/UPDATE payment_transactions/.test(sql)) {
    db.updates.push({ sql: flat, params });
    // Honour the WHERE clause rather than always reporting success — the whole
    // point of the 'created' guard is that it does NOT fire on a captured row.
    if (/AND status = 'created'/.test(flat) && db.txn.status !== 'created') {
      return { rows: [], rowCount: 0 };
    }
    if (/status = 'expired'/.test(flat)) db.txn.status = 'expired';
    return { rows: [db.txn], rowCount: 1 };
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
})) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}

const svc = require(`${BE}/src/services/payments.service.js`);
const gateway = require(`${BE}/src/services/gateway/razorpay.adapter.js`);

function seedInvoice(over = {}) {
  db.reset();
  db.invoice = {
    id: 42, public_token: 'tok_abc', status: 'approved', hub_id: 5,
    grand_total: '2000.00', paid_gross: '0', refunded: '0',
    customer_name: 'A Customer', mobile: '9876543210',
    appointment_id: 11, estimate_id: 22, vehicle_number: 'GJ01AB1234',
    amount_paid: '0', ...over,
  };
  return db.invoice;
}

// ── The real adapter's outbound call, intercepted ──────────────────────────
let lastCallPath = null, lastCallBody = null;
let callImpl = async (path, opts) => {
  lastCallPath = path; lastCallBody = opts?.body || null;
  return {
    id: 'qr_STUB1',
    // The hosted poster — branded, non-square, carrying the Razorpay account's
    // legal name. Present in every real response, and the thing we must NOT be
    // showing when a raw intent is available.
    image_url: 'https://rzp.io/i/qrSTUB1',
    image_content: 'upi://pay?pa=test.razorpay@hdfcbank&pn=TestAccount&am=1497.50',
    close_by: opts?.body?.close_by, status: 'active',
  };
};

(async () => {

  // ══ ADAPTER ═══════════════════════════════════════════════════════════════
  const adapterSrc = fs.readFileSync(`${BE}/src/services/gateway/razorpay.adapter.js`, 'utf8');
  const adapterCode = strip(adapterSrc);

  assert.strictEqual(typeof gateway.createQrCode, 'function', 'createQrCode is not exported'); n++;
  assert.strictEqual(typeof gateway.closeQrCode, 'function', 'closeQrCode is not exported'); n++;

  // Exercise the real createQrCode with only the HTTP layer replaced.
  {
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      const path = String(url).replace('https://api.razorpay.com/v1', '');
      const data = await callImpl(path, { body: JSON.parse(init.body || '{}') });
      return { ok: true, json: async () => data };
    };
    try {
      const before = Math.floor(Date.now() / 1000);
      const qr = await gateway.createQrCode({ amount: 1497.5, receipt: 'PYTEST1', notes: { txn_ref: 'PYTEST1' } });

      assert.strictEqual(lastCallPath, '/payments/qr_codes', 'createQrCode does not POST to the QR endpoint'); n++;
      assert.strictEqual(lastCallBody.type, 'upi_qr', 'the QR is not a UPI QR'); n++;

      // fixed_amount WITHOUT payment_amount is an open collection point.
      assert.strictEqual(lastCallBody.fixed_amount, true,
        'fixed_amount is not true — the customer could type any amount they liked'); n++;
      assert.strictEqual(lastCallBody.payment_amount, 149750,
        'payment_amount is wrong or missing — ₹1497.50 must be 149750 paise'); n++;

      // single_use, or one QR can settle the same balance twice.
      assert.strictEqual(lastCallBody.usage, 'single_use',
        'the QR is reusable — a second customer could pay the same invoice'); n++;

      // Razorpay caps close_by at 2 hours. Past it the API rejects the call.
      const ttl = lastCallBody.close_by - before;
      assert.ok(ttl > 0 && ttl <= 2 * 60 * 60,
        `close_by is ${ttl}s away — outside Razorpay's 2-minute-to-2-hour window`); n++;

      assert.strictEqual(qr.id, 'qr_STUB1', 'the QR id is not returned'); n++;
      assert.ok(qr.image_url, 'no image url is returned — there is nothing to show'); n++;

      // ── The code we show is one WE drew ────────────────────────────────────
      // Razorpay's image_url is a poster: non-square, branded, and printed with
      // the Razorpay account's registered legal name rather than the name the
      // workshop trades under. Squeezed into a modal the scannable part becomes
      // too small to read, which is exactly what shipped first.
      assert.ok(qr.image_url.startsWith('data:image/'),
        'the hosted Razorpay poster is being shown instead of a QR drawn from image_content'); n++;
      assert.notStrictEqual(qr.image_url, 'https://rzp.io/i/qrSTUB1',
        'image_url is passed straight through'); n++;
      assert.strictEqual(qr.hosted_url, 'https://rzp.io/i/qrSTUB1',
        'the hosted poster is not kept as a fallback'); n++;

      // The rendered code must encode the gateway's OWN intent, unchanged — a
      // QR we invented the contents of would take money nowhere.
      {
        const QRCode = require('qrcode');
        const expected = await QRCode.toDataURL(
          'upi://pay?pa=test.razorpay@hdfcbank&pn=TestAccount&am=1497.50',
          { width: 420, margin: 0, errorCorrectionLevel: 'M',
            color: { dark: '#000000ff', light: '#ffffffff' } });
        assert.strictEqual(qr.image_url, expected,
          'the QR does not encode the gateway\'s upi:// intent verbatim'); n++;
      }

      // No image_content (an older account, a changed API) must still work.
      {
        const saved = callImpl;
        callImpl = async (path, opts) => {
          lastCallBody = opts?.body || null;
          return { id: 'qr_STUB2', image_url: 'https://rzp.io/i/qrSTUB2', close_by: opts?.body?.close_by };
        };
        const fallback = await gateway.createQrCode({ amount: 100, receipt: 'PYFALLBACK' });
        assert.strictEqual(fallback.image_url, 'https://rzp.io/i/qrSTUB2',
          'with no image_content the hosted image is not used — the panel would show nothing'); n++;
        callImpl = saved;
      }

      // A caller asking for a week gets clamped, not a gateway 400.
      await gateway.createQrCode({ amount: 100, receipt: 'PYTEST2', ttlSeconds: 7 * 24 * 3600 });
      const longTtl = lastCallBody.close_by - Math.floor(Date.now() / 1000);
      assert.ok(longTtl <= 2 * 60 * 60,
        'a long ttl is passed straight through — Razorpay rejects anything over 2 hours'); n++;

      // Notes are echoed in the dashboard and the webhook: our refs only.
      await gateway.createQrCode({ amount: 100, receipt: 'PYTEST3', notes: { txn_ref: 'PYTEST3', invoice_id: '42' } });
      const noteBlob = JSON.stringify(lastCallBody.notes || {});
      assert.ok(!/98\d{8}/.test(noteBlob), 'a mobile number is being written into the QR notes'); n++;

      // The ₹1 floor, before the gateway sees it.
      await assert.rejects(
        () => gateway.createQrCode({ amount: 0.5, receipt: 'PYTEST4' }),
        /minimum/i, 'a sub-₹1 QR is sent to the gateway instead of being refused'); n++;
    } finally {
      global.fetch = realFetch;
    }
  }

  // The mock QR must NOT be a payable UPI intent.
  assert.ok(!/upi:\/\/pay/.test(adapterCode),
    'the adapter builds a upi:// intent — a mock QR that takes real money into a void'); n++;
  assert.ok(/qr_mock_/.test(adapterCode), 'mock mode does not produce a distinguishable QR id'); n++;

  // The QR path must not have invented a second place that reads credentials.
  //
  // The count used to be 4 — KEY_ID, KEY_SECRET, WEBHOOK_SECRET and the
  // timeout, all read straight from process.env. The three credentials now come
  // from getSetting(), so an admin can set them from the Gateway screen and the
  // environment variable stays as the fallback; only the timeout is still read
  // directly, because it is a tuning knob and not a credential.
  //
  // So the guard changed shape rather than being deleted. What it protects is
  // the same thing it always protected: exactly ONE place in this file decides
  // where each credential comes from.
  const envReads = (adapterCode.match(/process\.env\.RAZORPAY_/g) || []).length;
  assert.strictEqual(envReads, 1,
    `${envReads} RAZORPAY_ env reads in the adapter — expected only RAZORPAY_TIMEOUT_MS`); n++;
  assert.ok(/process\.env\.RAZORPAY_TIMEOUT_MS/.test(adapterCode),
    'the one surviving env read is not the timeout — a credential is being read directly'); n++;

  // And each credential is fetched in exactly one place, so there is no second
  // accessor that could disagree with the first.
  for (const key of ['razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret']) {
    const hits = (adapterCode.match(new RegExp(`getSetting\\('${key}'\\)`, 'g')) || []).length;
    assert.strictEqual(hits, 1,
      `${key} is read from ${hits} places in the adapter — there must be exactly one`); n++;
  }

  // Read at CALL time, not at import time. A credential captured into a
  // module-level constant would mean a value saved from the Gateway screen did
  // nothing until the next restart, while the screen reported it as live.
  assert.ok(!/^const\s+\w+\s*=\s*getSetting\(/m.test(adapterCode),
    'a credential is captured into a module constant — saving from the UI would need a restart'); n++;
  // process.env.RAZORPAY_*, not the mere string: payments.service.js names
  // RAZORPAY_WEBHOOK_SECRET in an error message telling an admin what to set,
  // which is the opposite of a leak. Matching the bare name would ban that.
  for (const f of ['payments.service.js', 'controllers/payments.controller.js',
                   'controllers/webhooks.payments.controller.js']) {
    const p = f.includes('/') ? `${BE}/src/${f}` : `${BE}/src/services/${f}`;
    assert.ok(!/process\.env\.RAZORPAY_/.test(strip(fs.readFileSync(p, 'utf8'))),
      `${f} reads a gateway credential — only the adapter may`); n++;
  }

  // ══ SERVICE ═══════════════════════════════════════════════════════════════
  const svcSrc = fs.readFileSync(`${BE}/src/services/payments.service.js`, 'utf8');
  const svcCode = strip(svcSrc);

  // Stub the adapter surface the service uses.
  let qrCreateArgs = null;
  gateway.createQrCode = async (args) => {
    qrCreateArgs = args;
    return { id: 'qr_STUB1', image_url: 'https://rzp.io/i/qrSTUB1',
             close_by: Math.floor(Date.now() / 1000) + 1800, mock: false };
  };
  let closedQrIds = [];
  gateway.closeQrCode = async (id) => { closedQrIds.push(id); return { id, status: 'closed' }; };

  // ── The refusal that prevents silent money loss ───────────────────────────
  {
    seedInvoice();
    const realCheck = gateway.isWebhookConfigured;
    gateway.isWebhookConfigured = () => false;
    try {
      await assert.rejects(
        () => svc.createInvoiceQr({ customerInvoiceId: 42 }),
        (err) => err.status === 503 && /webhook/i.test(err.message),
        'a QR is created with no webhook configured — a customer can pay and it is never recorded'); n++;
      assert.strictEqual(db.txn, null, 'a transaction row was written before the webhook check'); n++;
      assert.strictEqual(qrCreateArgs, null, 'the gateway was called before the webhook check'); n++;
    } finally {
      gateway.isWebhookConfigured = realCheck;
    }
  }

  // ── The amount is the server's, and it is the SAME rule as checkout ───────
  {
    seedInvoice();
    qrCreateArgs = null;
    const { qr, txn } = await svc.createInvoiceQr({ customerInvoiceId: 42 });
    assert.strictEqual(qr.amount, 2000, 'the QR is not for the full balance'); n++;
    assert.strictEqual(qrCreateArgs.amount, 2000, 'the gateway was asked for the wrong amount'); n++;
    assert.strictEqual(txn.gateway_qr_id, 'qr_STUB1', 'gateway_qr_id is not stored'); n++;
    assert.strictEqual(txn.gateway_order_id, null, 'a QR transaction carries an order id'); n++;
    assert.ok(txn.qr_expires_at instanceof Date, 'qr_expires_at is not stored as a timestamp'); n++;
    assert.strictEqual(txn.status, 'created', 'a QR starts at a status other than created'); n++;
    // The insert must set gateway_qr_id, not smuggle it into gateway_order_id.
    assert.ok(/gateway_qr_id/.test(db.txn._insertSql), 'the insert does not name gateway_qr_id'); n++;
  }
  {
    // A client asking for MORE than the balance is clamped down, never up.
    seedInvoice();
    const { qr } = await svc.createInvoiceQr({ customerInvoiceId: 42, requestedAmount: 999999 });
    assert.strictEqual(qr.amount, 2000, 'a client-supplied amount above the balance was honoured'); n++;
  }
  {
    // A part payment is allowed.
    seedInvoice();
    const { qr } = await svc.createInvoiceQr({ customerInvoiceId: 42, requestedAmount: 500 });
    assert.strictEqual(qr.amount, 500, 'a part-payment QR was not honoured'); n++;
  }
  {
    seedInvoice({ status: 'cancelled' });
    await assert.rejects(() => svc.createInvoiceQr({ customerInvoiceId: 42 }),
      /cancelled/i, 'a QR can be created against a cancelled invoice'); n++;
  }
  {
    seedInvoice({ paid_gross: '2000.00' });
    await assert.rejects(() => svc.createInvoiceQr({ customerInvoiceId: 42 }),
      /already fully paid/i, 'a QR can be created against a settled invoice'); n++;
  }

  // BOTH instruments must go through the one amount resolver. Two copies of
  // this rule is how one of them ends up fixed and the other not.
  assert.ok(/function resolveCollectable/.test(svcCode), 'resolveCollectable does not exist'); n++;
  for (const fn of ['createInvoiceOrder', 'createInvoiceQr']) {
    const body = svcCode.slice(svcCode.indexOf(`async function ${fn}(`));
    const upTo = body.slice(0, body.indexOf('\n}\n') + 1);
    assert.ok(/resolveCollectable\(/.test(upTo),
      `${fn} does not use resolveCollectable — the amount rules have been duplicated`); n++;
    assert.ok(!/readInvoiceBalance\(/.test(upTo),
      `${fn} reads the invoice itself instead of going through resolveCollectable`); n++;
  }
  assert.ok(/Math\.min\(asked, inv\.balance\)/.test(svcCode),
    'the requested amount is not clamped to the balance'); n++;

  // ── Cancelling ────────────────────────────────────────────────────────────
  {
    seedInvoice();
    closedQrIds = [];
    const { txn } = await svc.createInvoiceQr({ customerInvoiceId: 42 });
    const out = await svc.cancelInvoiceQr({ txnRef: txn.txn_ref });
    assert.strictEqual(out.cancelled, true, 'an unpaid QR could not be cancelled'); n++;
    assert.strictEqual(out.captured, false, 'an unpaid QR reports as captured'); n++;
    assert.deepStrictEqual(closedQrIds, ['qr_STUB1'], 'the QR was not closed at the gateway'); n++;
    const upd = db.updates.find(u => /status = 'expired'/.test(u.sql));
    assert.ok(upd, 'nothing marked the transaction expired'); n++;
    assert.ok(/AND status = 'created'/.test(upd.sql),
      "the cancel UPDATE is not guarded on status='created' — it could overwrite a capture"); n++;
    assert.ok(!/status = 'failed'/.test(upd.sql),
      'an abandoned QR is recorded as failed — it lands in the failure numbers'); n++;
  }
  {
    // The race that actually happens: the customer pays while staff close it.
    seedInvoice();
    const { txn } = await svc.createInvoiceQr({ customerInvoiceId: 42 });
    db.txn.status = 'captured';
    const out = await svc.cancelInvoiceQr({ txnRef: txn.txn_ref });
    assert.strictEqual(out.cancelled, false, 'a captured payment was reported as cancelled'); n++;
    assert.strictEqual(out.captured, true, 'a captured payment was not reported as captured'); n++;
    assert.strictEqual(db.txn.status, 'captured', 'cancelling overwrote a captured payment'); n++;
  }

  // ══ WEBHOOK — the only path a QR payment has ══════════════════════════════
  const whSrc = fs.readFileSync(`${BE}/src/controllers/webhooks.payments.controller.js`, 'utf8');
  const whCode = strip(whSrc);

  assert.ok(/'qr_code\.credited'/.test(whCode), 'qr_code.credited is not handled at all'); n++;
  const handledBlock = whCode.slice(whCode.indexOf('const HANDLED'), whCode.indexOf(']);'));
  assert.ok(/qr_code\.credited/.test(handledBlock),
    'qr_code.credited is not in HANDLED — it would be stored and ignored'); n++;
  assert.ok(/case 'qr_code\.credited':\s*return onQrCredited\(/.test(whCode),
    'qr_code.credited is not dispatched to a handler'); n++;

  // Razorpay's payment entity has NO reference to the QR. The qr_code entity is
  // the only way to identify our row, so it must be extracted.
  assert.ok(/body\?\.payload\?\.qr_code\?\.entity/.test(whCode),
    'the qr_code entity is never read — a QR payment cannot be matched to a transaction'); n++;
  assert.ok(/dispatch\(eventType, entity, qrEntity\)/.test(whCode),
    'the qr entity is not passed to dispatch'); n++;

  // findTxn must be able to match on the QR id.
  const findTxnBody = whCode.slice(whCode.indexOf('async function findTxn'),
                                   whCode.indexOf('async function onQrCredited'));
  assert.ok(/gateway_qr_id = \$3/.test(findTxnBody),
    'findTxn cannot match a QR — every QR payment would log "unknown order" and be dropped'); n++;
  assert.ok(/qr_id/.test(findTxnBody), 'findTxn takes no qr_id'); n++;

  // The capture must go through the ONE capture function.
  const qrHandler = whCode.slice(whCode.indexOf('async function onQrCredited'),
                                 whCode.indexOf('async function onPaymentCaptured'));
  assert.ok(/captureVerifiedPayment\(\{/.test(qrHandler),
    'onQrCredited does not use captureVerifiedPayment — a second capture path'); n++;
  assert.ok(!/INSERT INTO customer_invoice_payments/.test(qrHandler),
    'onQrCredited writes the ledger itself, bypassing the duplicate guards'); n++;
  assert.ok(!/UPDATE customer_invoices/.test(qrHandler),
    'onQrCredited sets the invoice status directly'); n++;
  assert.ok(/qr\?\.id/.test(qrHandler), 'onQrCredited does not read the QR id from the qr entity'); n++;

  // Signature verification still gates everything. The QR work must not have
  // moved a database call above it.
  const verifyIdx = whCode.indexOf('verifyWebhookSignature');
  const firstDbIdx = whCode.indexOf('pool.query');
  assert.ok(verifyIdx > 0 && verifyIdx < firstDbIdx,
    'a database call now happens before the signature is verified'); n++;
  assert.ok(/if \(!gateway\.isWebhookConfigured\(\)\)/.test(whCode),
    'the unconfigured-webhook refusal has been removed'); n++;

  // ══ MIGRATION 129 ═════════════════════════════════════════════════════════
  const m129 = fs.readFileSync(`${BE}/db/migrations/129_payment_qr_codes.sql`, 'utf8');
  const m129Sql = stripSql(m129);
  assert.ok(/ADD COLUMN IF NOT EXISTS gateway_qr_id/.test(m129Sql), 'gateway_qr_id is not added'); n++;
  assert.ok(/ADD COLUMN IF NOT EXISTS qr_image_url/.test(m129Sql), 'qr_image_url is not added'); n++;
  assert.ok(/ADD COLUMN IF NOT EXISTS qr_expires_at/.test(m129Sql), 'qr_expires_at is not added'); n++;
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_paytxn_gateway_qr/.test(m129Sql),
    'there is no unique index on gateway_qr_id — a webhook retry could double-capture'); n++;
  assert.ok(/WHERE gateway_qr_id IS NOT NULL/.test(m129Sql),
    'the unique index is not partial — it would allow exactly one QR-less row in the table'); n++;
  assert.ok(!/BEGIN;|COMMIT;/.test(m129Sql), 'the migration opens its own transaction — migrate.js wraps it'); n++;
  assert.ok(!/DROP |ALTER COLUMN|DELETE FROM/.test(m129Sql), 'the migration is destructive'); n++;
  // Old migrations are immutable.
  const m122 = fs.readFileSync(`${BE}/db/migrations/122_payment_transactions.sql`, 'utf8');
  assert.ok(!/gateway_qr_id/.test(m122), 'migration 122 was edited — applied migrations are immutable'); n++;

  // ══ ROUTES + CONTROLLER ═══════════════════════════════════════════════════
  const rt = fs.readFileSync(`${BE}/src/routes/payments.routes.js`, 'utf8');
  // Comments stripped before the middleware assertions: this file's header
  // explicitly names requirePermissionOrHub to explain why it is NOT used, and
  // matching that sentence would fail on the very comment documenting the rule.
  const rtCode = strip(rt);
  const ctrl = fs.readFileSync(`${BE}/src/controllers/payments.controller.js`, 'utf8');
  const ctrlCode = strip(ctrl);

  assert.ok(/router\.post\('\/qr',\s*canCollect/.test(rt),
    'POST /qr is missing or not behind the collect permission'); n++;
  assert.ok(/router\.post\('\/qr\/:ref\/cancel',\s*canCollect/.test(rt),
    'the QR cancel route is missing or unprotected'); n++;
  // Above the catch-all, or 'qr' is read as a transaction reference.
  assert.ok(rtCode.indexOf("router.post('/qr'") < rtCode.indexOf("router.get('/:ref'"),
    "POST /qr is below the /:ref catch-all"); n++;
  assert.ok(!/requirePermissionOrHub/.test(rtCode),
    'the payments router now uses requirePermissionOrHub, which passes any hub login'); n++;

  for (const fn of ['createQr', 'cancelQr']) {
    const body = ctrlCode.slice(ctrlCode.indexOf(`function ${fn}(`));
    const upTo = body.slice(0, body.indexOf('\n}\n') + 1);
    assert.ok(/denyHub\(req/.test(upTo), `${fn} does not reject hub logins`); n++;
  }
  assert.ok(/hubScopeSql\(req, params, 't\.hub_id'\)/.test(
    ctrlCode.slice(ctrlCode.indexOf('function cancelQr('), ctrlCode.indexOf('function verifyPayment('))),
    'cancelQr is not hub-scoped — a hub could cancel another hub\'s QR'); n++;
  // The response must not hand the browser gateway internals.
  const createQrBody = ctrlCode.slice(ctrlCode.indexOf('function createQr('), ctrlCode.indexOf('function cancelQr('));
  assert.ok(!/key_id|KEY_SECRET|gateway_qr_id/.test(createQrBody),
    'the QR response exposes gateway internals'); n++;

  // ══ FRONTEND ══════════════════════════════════════════════════════════════
  const panel = fs.readFileSync(`${FE}/components/UpiQrPanel.jsx`, 'utf8');
  const modal = fs.readFileSync(`${FE}/components/CollectPaymentModal.jsx`, 'utf8');
  const panelCode = strip(panel);

  // Polls on OUR reference, never a gateway id.
  assert.ok(/api\(`\/api\/payments\/\$\{encodeURIComponent\(qr\.txn_ref\)\}`\)/.test(panelCode),
    'the panel does not poll on txn_ref'); n++;
  assert.ok(!/qr_id/.test(panelCode.replace(/qr_code/g, '')),
    'the frontend holds the gateway QR id'); n++;

  // Only a captured status is success. Trusting anything else in a browser is
  // the exact thing the whole payments module refuses to do.
  assert.ok(/item\.status === 'captured'/.test(panelCode),
    'the panel does not gate success on a captured status'); n++;
  assert.ok(!/setPhase\('paid'\)[\s\S]{0,200}catch/.test(panelCode) || /item\.status === 'captured'/.test(panelCode),
    'the panel can reach a paid state without the server saying captured'); n++;

  // Closing must cancel, and a paid QR must NOT be cancelled.
  assert.ok(/\/cancel`, \{ method: 'POST' \}/.test(panelCode), 'closing does not cancel the QR'); n++;
  assert.ok(/if \(!ref \|\| paidRef\.current\) return;/.test(panelCode),
    'a paid QR would be cancelled on close'); n++;
  assert.ok(/registerCleanup/.test(panelCode) && /registerCleanup/.test(modal),
    'the modal cannot cancel the QR when the whole dialog closes'); n++;

  // Intervals are cleaned up — a modal opened and closed ten times must not
  // leave ten pollers running against the API.
  const intervals = (panelCode.match(/setInterval\(/g) || []).length;
  const clears = (panelCode.match(/clearInterval\(/g) || []).length;
  assert.strictEqual(intervals, clears, `${intervals} setInterval vs ${clears} clearInterval — a poller leaks`); n++;

  // One amount field for both instruments.
  assert.ok(!/type="number"/.test(panelCode), 'the QR panel has its own amount input — two places to keep correct'); n++;
  assert.ok(/amount=\{Math\.min\(asked \|\| 0, balance\)\}/.test(modal),
    'the modal does not pass the clamped amount to the QR panel'); n++;

  // The mock warning must survive — an unscannable placeholder that looks real
  // is how a workshop discovers mock mode by asking a customer to scan it.
  assert.ok(/qr\?\.mock/.test(panelCode), 'mock QRs are not labelled as unusable'); n++;

  // ── The image must never be forced to a fixed pair of dimensions ──────────
  // The fallback path serves Razorpay's non-square poster. Pinning width AND
  // height squashes it into something a phone camera cannot lock onto — the
  // bug that shipped first, and the one a screenshot makes obvious but no
  // assertion had caught.
  const imgTag = panelCode.slice(panelCode.indexOf('alt="UPI payment QR code"') - 300,
                                 panelCode.indexOf('alt="UPI payment QR code"') + 300);
  assert.ok(/height: 'auto'/.test(imgTag),
    'the QR image has a fixed height — a non-square fallback would be distorted'); n++;
  assert.ok(!/width=\{\d+\} height=\{\d+\}/.test(panelCode),
    'the QR image still carries fixed width and height attributes'); n++;
  // Width alone is not enough: Razorpay's poster is roughly 2:1, so a 340px
  // width is a ~700px tall image running off the bottom of a laptop screen.
  assert.ok(/maxHeight: '\d+vh'/.test(imgTag),
    'the QR image has no viewport-relative height cap — a tall poster overflows the screen'); n++;

  // ── The QR gets its own popup ─────────────────────────────────────────────
  // A QR is the only thing on this screen a customer looks at, and it has to be
  // big enough to scan without holding a phone still. Inline under the amount
  // field it competes for height with a form the customer has no use for.
  assert.ok(/className="po-backdrop"/.test(panelCode),
    'the QR does not open in its own popup'); n++;
  assert.ok(/zIndex: 70/.test(panelCode),
    'the QR popup does not stack above the collect dialog'); n++;
  // RefundDialog already claims 60; the QR popup opens on top of the collect
  // dialog, so it must be higher than both.
  const refund = fs.readFileSync(`${FE}/components/RefundDialog.jsx`, 'utf8');
  const refundZ = Number((refund.match(/zIndex: (\d+)/) || [])[1] || 0);
  const qrZ = Number((panelCode.match(/zIndex: (\d+)/) || [])[1] || 0);
  assert.ok(qrZ > refundZ, `the QR popup z-index (${qrZ}) does not clear RefundDialog's (${refundZ})`); n++;

  // Cancelling returns to the collect dialog with the typed amount intact —
  // it does not drop the advisor back out to the invoice.
  assert.ok(/const cancelAndReset = useCallback\(/.test(panelCode),
    'there is no cancel-and-return path'); n++;
  const carBody = panelCode.slice(panelCode.indexOf('const cancelAndReset'),
                                  panelCode.indexOf('async function createQr'));
  assert.ok(/cancelServerSide\(\)/.test(carBody),
    'cancelling the popup leaves a live QR at the gateway'); n++;
  assert.ok(/setPhase\('idle'\)/.test(carBody),
    'cancelling does not return to the idle state'); n++;
  assert.ok(!/onClose\(\)|onSuccess\(\)/.test(carBody),
    'cancelling the QR closes the whole collect dialog'); n++;

  console.log(`upi qr payments: ${n} checks passed`);
})().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
