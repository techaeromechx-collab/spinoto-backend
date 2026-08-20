/**
 * Phase 1 — the gateway adapter layer.
 *
 * This is the security core of the payments module: if signature verification
 * is wrong, anyone on the internet can mark any invoice paid. Every assertion
 * here exercises the REAL module, with real HMACs, not a description of it.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BE = require('path').resolve(__dirname, '..');
let n = 0;

// Real keys, set BEFORE the adapter is required — it reads the environment at
// module load, which is itself worth pinning.
process.env.RAZORPAY_KEY_ID = 'rzp_live_TESTKEY123456';
process.env.RAZORPAY_KEY_SECRET = 'secret_abcdef0123456789';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_fedcba9876543210';

const types = require(`${BE}/src/services/gateway/types.js`);
const rzp   = require(`${BE}/src/services/gateway/razorpay.adapter.js`);
const reg   = require(`${BE}/src/services/gateway/index.js`);

// ── Money conversion ────────────────────────────────────────────────────────
// The float bug this exists to prevent, demonstrated rather than asserted from
// memory: 19.99 * 100 is 1998.9999999999998, so truncation charges ₹19.98 and
// the invoice lands one paisa short — which flips it from 'paid' to
// 'partially_paid' and blocks the hub payout. 18,351 of the first 200,000
// rupee-and-paise values are affected, so this is a common case, not a corner.
assert.strictEqual(19.99 * 100 === 1999, false, 'the float trap is real'); n++;
assert.strictEqual(Math.trunc(19.99 * 100), 1998, 'truncation really does undercharge'); n++;
assert.strictEqual(types.toMinorUnit(19.99), 1999, 'toMinorUnit must round, not truncate'); n++;
assert.strictEqual(types.toMinorUnit(1234.56), 123456); n++;
// A spread of the known-bad values, all of which must come out exact.
for (const [r, p] of [[0.07, 7], [0.29, 29], [0.55, 55], [0.57, 57], [1.15, 115], [8.16, 816]]) {
  assert.strictEqual(types.toMinorUnit(r), p, `toMinorUnit(${r}) must be ${p}`); n++;
}
assert.strictEqual(types.toMinorUnit(0.1 + 0.2), 30, '0.30000000000000004 → 30'); n++;
assert.strictEqual(types.toMinorUnit(1), 100); n++;
assert.strictEqual(types.toMinorUnit('2499.99'), 249999, 'numeric strings from pg'); n++;
assert.strictEqual(types.fromMinorUnit(123456), 1234.56); n++;
// Round trip on a spread of awkward values.
for (const r of [0.01, 1, 9.99, 100.05, 4999.95, 123456.78]) {
  assert.strictEqual(types.fromMinorUnit(types.toMinorUnit(r)), r, `round trip ${r}`); n++;
}
// Number(null), Number('') and Number(false) are all 0 — finite, so a naive
// isFinite guard turns a missing amount into a ₹0 charge. Each of these must
// throw rather than quietly become zero.
for (const bad of [null, undefined, '', false, true, 'abc', NaN, Infinity, -Infinity, 0, -5, {}, []]) {
  assert.throws(() => types.toMinorUnit(bad),
    `toMinorUnit(${JSON.stringify(bad)}) must throw, not become a zero-rupee charge`); n++;
}

// ── Ledger method mapping ───────────────────────────────────────────────────
// Must only ever produce values the existing CHECK constraint allows
// (migration 065 + 078), or every gateway capture fails on insert.
const ALLOWED = new Set(['cash', 'upi', 'card', 'bank_transfer', 'other', 'app_payment']);
for (const g of ['upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater',
                 'cardless_emi', 'bank_transfer', '', null, undefined, 'SOMETHING_NEW']) {
  const m = types.toLedgerMethod(g);
  assert.ok(ALLOWED.has(m), `toLedgerMethod(${g}) → '${m}' violates the CHECK constraint`); n++;
}
assert.strictEqual(types.toLedgerMethod('UPI'), 'upi', 'case insensitive'); n++;
assert.strictEqual(types.toLedgerMethod('netbanking'), 'bank_transfer'); n++;
assert.strictEqual(types.toLedgerMethod('unknown_future_method'), 'other',
  'an unrecognised method must fall back, never leak through'); n++;

// ── raw_response scrubbing ──────────────────────────────────────────────────
const dirty = {
  id: 'pay_ABC', amount: 250000, status: 'captured', method: 'card',
  email: 'customer@example.com',           // personal
  contact: '+919876543210',                // personal — masked elsewhere
  card: { number: '4111111111111111', name: 'A Customer' },
  token: 'tok_secret', notes: { mobile: '9876543210' },
  acquirer_data: { rrn: '123', bank: 'HDFC', vpa: 'x@ybl', auth_code: 'zz' },
};
const clean = types.scrubRaw(dirty);
for (const leak of ['email', 'contact', 'card', 'token', 'notes']) {
  assert.ok(!(leak in clean), `scrubRaw leaked '${leak}' into raw_response`); n++;
}
assert.strictEqual(clean.id, 'pay_ABC'); n++;
assert.strictEqual(clean.status, 'captured'); n++;
// Nested objects get the same allow-list, not a free pass.
assert.ok(!('auth_code' in clean.acquirer_data), 'nested keys bypassed the allow-list'); n++;
assert.ok(!('rrn' in clean.acquirer_data), 'nested rrn survived'); n++;
assert.strictEqual(clean.acquirer_data.bank, 'HDFC'); n++;
assert.strictEqual(types.scrubRaw(null), null); n++;
assert.strictEqual(types.scrubRaw('a string'), null); n++;

// ── safeEqual ───────────────────────────────────────────────────────────────
assert.strictEqual(types.safeEqual('abc', 'abc'), true); n++;
assert.strictEqual(types.safeEqual('abc', 'abd'), false); n++;
assert.strictEqual(types.safeEqual('abc', 'abcd'), false, 'length mismatch must not throw'); n++;
assert.strictEqual(types.safeEqual('', ''), true); n++;
assert.strictEqual(types.safeEqual(null, undefined), true, 'both empty — same string'); n++;
assert.strictEqual(types.safeEqual('abc', null), false); n++;

// ── Payment-callback signature: the whole point ─────────────────────────────
const ORDER = 'order_XYZ123';
const PAYMENT = 'pay_ABC456';
function sign(order, payment, secret = process.env.RAZORPAY_KEY_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${order}|${payment}`).digest('hex');
}
const good = sign(ORDER, PAYMENT);

assert.strictEqual(rzp.isConfigured(), true, 'real keys were set before require'); n++;
assert.strictEqual(rzp.mode(), 'live', 'rzp_live_ prefix must resolve to live mode'); n++;
assert.strictEqual(rzp.verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature: good }), true); n++;

// Every way of getting it wrong.
const forgeries = [
  ['tampered last char',  good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a')],
  ['tampered first char', (good.startsWith('a') ? 'b' : 'a') + good.slice(1)],
  ['truncated',           good.slice(0, 32)],
  ['empty',               ''],
  ['null',                null],
  ['undefined',           undefined],
  ['uppercased',          good.toUpperCase()],
  ['whitespace padded',   ` ${good} `],
  ['wrong secret',        crypto.createHmac('sha256', 'not_the_secret').update(`${ORDER}|${PAYMENT}`).digest('hex')],
];
for (const [why, sig] of forgeries) {
  assert.strictEqual(
    rzp.verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature: sig }), false,
    `a ${why} signature was ACCEPTED`); n++;
}
// A signature valid for one order must not validate another — the order id is
// inside the HMAC, so swapping ids is the natural attack.
assert.strictEqual(
  rzp.verifyPaymentSignature({ orderId: 'order_OTHER', paymentId: PAYMENT, signature: good }), false,
  'a signature was replayed onto a different order'); n++;
assert.strictEqual(
  rzp.verifyPaymentSignature({ orderId: ORDER, paymentId: 'pay_OTHER', signature: good }), false,
  'a signature was replayed onto a different payment'); n++;
// Missing ids must fail closed, not throw.
assert.strictEqual(rzp.verifyPaymentSignature({ orderId: null, paymentId: PAYMENT, signature: good }), false); n++;
assert.strictEqual(rzp.verifyPaymentSignature({}), false); n++;

// ── Webhook signature ───────────────────────────────────────────────────────
const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } });
const wsig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');

assert.strictEqual(rzp.verifyWebhookSignature({ rawBody: body, signature: wsig }), true); n++;
assert.strictEqual(rzp.verifyWebhookSignature({ rawBody: Buffer.from(body), signature: wsig }), true,
  'a Buffer rawBody (what express gives us) must verify identically'); n++;

// The API secret is NOT the webhook secret. Signing with the wrong one is the
// classic misconfiguration and it must fail.
const wrongSecretSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
assert.strictEqual(rzp.verifyWebhookSignature({ rawBody: body, signature: wrongSecretSig }), false,
  'the API secret was accepted as the webhook secret'); n++;

// Re-serialised body: same JSON, different bytes. This is why rawBody exists.
const reserialised = JSON.stringify(JSON.parse(body).payload ? JSON.parse(body) : {});
const reordered = '{"payload":{"payment":{"entity":{"id":"pay_1"}}},"event":"payment.captured"}';
assert.strictEqual(JSON.parse(reordered).event, 'payment.captured', 'same object'); n++;
assert.notStrictEqual(reordered, body, 'key order really does change the bytes'); n++;
assert.strictEqual(rzp.verifyWebhookSignature({ rawBody: reordered, signature: wsig }), false,
  'a re-serialised body verified — rawBody is not being used'); n++;

for (const [why, args] of [
  ['tampered body',   { rawBody: body + ' ', signature: wsig }],
  ['no signature',    { rawBody: body, signature: '' }],
  ['null signature',  { rawBody: body, signature: null }],
  ['no body',         { rawBody: '', signature: wsig }],
  ['nothing',         {}],
]) {
  assert.strictEqual(rzp.verifyWebhookSignature(args), false, `webhook accepted with ${why}`); n++;
}

// ── The secret never escapes ────────────────────────────────────────────────
const status = reg.gatewayStatus();
const flat = JSON.stringify(status);
assert.ok(!flat.includes(process.env.RAZORPAY_KEY_SECRET), 'gatewayStatus leaked the API secret'); n++;
assert.ok(!flat.includes(process.env.RAZORPAY_WEBHOOK_SECRET), 'gatewayStatus leaked the webhook secret'); n++;
assert.ok(!flat.includes(process.env.RAZORPAY_KEY_ID), 'gatewayStatus returned the key id unmasked'); n++;
assert.strictEqual(status.webhook_configured, true, 'must be a boolean, and it must be right'); n++;
assert.strictEqual(typeof status.webhook_configured, 'boolean',
  'webhook_configured must be a boolean, never the secret'); n++;
assert.ok(/…/.test(status.key_id_masked), 'the key id is not masked'); n++;
assert.strictEqual(status.mode, 'live'); n++;
// Nothing the adapter EXPORTS may hand back a secret.
for (const key of Object.keys(rzp)) {
  const v = rzp[key];
  if (typeof v === 'string') {
    assert.ok(!v.includes('secret_'), `adapter exports a string containing a secret: ${key}`); n++;
  }
}
assert.ok(!('KEY_SECRET' in rzp) && !('keySecret' in rzp), 'the adapter exports its secret'); n++;

// ── No provider name outside services/gateway/ ──────────────────────────────
// The rule that keeps a second gateway cheap. Scoped to source, and the
// booking controller's remaining mentions are prose in comments.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
// The rule is about gateway LOGIC, not about every string containing the
// provider's name. `razorpay_order_id` survives in booking_orders' column names
// (migration 102) and in the booking SPA's wire contract — renaming those needs
// a migration plus a frontend release and buys nothing, because they carry no
// credential handling. What must NOT exist outside services/gateway/ is any
// code that reads a credential, calls the provider's API, or implements the
// signature check. Those are the things that rot when duplicated.
const FORBIDDEN = [
  [/process\.env\.RAZORPAY/,      'reads a gateway credential from the environment'],
  [/api\.razorpay\.com/,          'calls the gateway API directly'],
  [/createHmac\(\s*['"]sha256['"]\s*,\s*(RZP|KEY_SECRET|WEBHOOK_SECRET)/, 'implements its own gateway signature check'],
];
const offenders = [];
for (const f of walk(`${BE}/src`)) {
  if (f.includes('/services/gateway/')) continue;
  const src = fs.readFileSync(f, 'utf8');
  // Strip comments — the prohibition is on CODE, and these files explain
  // themselves in prose that legitimately names the provider.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [re, why] of FORBIDDEN) {
    if (re.test(code)) offenders.push(`${f.replace(BE, '')} ${why}`);
  }
}
assert.deepStrictEqual(offenders, [],
  `gateway logic exists outside services/gateway/:\n${offenders.join('\n')}`); n++;

// Prove the check can actually fail, rather than passing because the regexes
// never match anything — the mistake I have made before with source-scanning
// assertions.
assert.ok(FORBIDDEN.some(([re]) => re.test(
  fs.readFileSync(`${BE}/src/services/gateway/razorpay.adapter.js`, 'utf8'))),
  'the FORBIDDEN patterns match nothing even in the adapter — they are broken'); n++;

// And the NEW schema is provider-neutral in its IDENTIFIERS: gateway_order_id,
// never razorpay_order_id. `DEFAULT 'razorpay'` is fine — that is a data value
// in a `gateway` column, and naming the current provider as data is the whole
// point of having that column.
const MIGRATIONS = ['122_payment_transactions', '123_payment_links',
                    '124_payment_refunds', '125_payment_ledger_source'];
for (const m of MIGRATIONS) {
  const sql = fs.readFileSync(`${BE}/db/migrations/${m}.sql`, 'utf8');
  const ddl = sql
    .replace(/^\s*--.*$/gm, '')                      // line comments
    .replace(/COMMENT ON[\s\S]*?;/g, '')             // COMMENT ON ... IS '...';
    .replace(/'[^']*'/g, "''");                      // string literals (DEFAULTs)
  assert.ok(!/razorpay/i.test(ddl),
    `migration ${m} uses a provider-specific identifier: ${(ddl.match(/.*razorpay.*/i) || [])[0]?.trim()}`); n++;
}
// Positive check, scoped to the two migrations that actually store gateway ids.
// payment_links holds none — it is a link to an invoice, not to a provider — so
// asserting the word there would be an assertion about nothing.
for (const m of ['122_payment_transactions', '124_payment_refunds']) {
  const sql = fs.readFileSync(`${BE}/db/migrations/${m}.sql`, 'utf8');
  assert.ok(/gateway_\w+\s+VARCHAR/.test(sql),
    `migration ${m} has no gateway_* identifier — provider ids are stored under some other name`); n++;
}
// Every migration is idempotent — this project has no down-migrations, so a
// half-applied file must be re-runnable rather than needing hand repair.
for (const m of MIGRATIONS) {
  const sql = fs.readFileSync(`${BE}/db/migrations/${m}.sql`, 'utf8');
  for (const [re, what] of [
    [/CREATE TABLE(?! IF NOT EXISTS)/, 'CREATE TABLE without IF NOT EXISTS'],
    [/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/, 'CREATE INDEX without IF NOT EXISTS'],
    [/ADD COLUMN(?! IF NOT EXISTS)/, 'ADD COLUMN without IF NOT EXISTS'],
  ]) {
    assert.ok(!re.test(sql), `migration ${m} has ${what} — not re-runnable`); n++;
  }
  // Every ADD CONSTRAINT is preceded by a DROP CONSTRAINT IF EXISTS, which is
  // the only way to make one idempotent in Postgres.
  const adds  = (sql.match(/ADD CONSTRAINT/g) || []).length;
  const drops = (sql.match(/DROP CONSTRAINT IF EXISTS/g) || []).length;
  assert.ok(drops >= adds,
    `migration ${m}: ${adds} ADD CONSTRAINT but only ${drops} DROP CONSTRAINT IF EXISTS`); n++;
  // migrate.js already wraps each file in BEGIN/COMMIT — a nested transaction
  // here would emit warnings and, worse, a stray COMMIT would end the wrapper's
  // transaction early and defeat the rollback on failure.
  assert.ok(!/^\s*(BEGIN|COMMIT)\s*;/mi.test(sql),
    `migration ${m} opens its own transaction — migrate.js already wraps it`); n++;
}

// And the credential reads really are gone from the booking controller.
const booking = fs.readFileSync(`${BE}/src/controllers/public.booking.controller.js`, 'utf8');
const bookingCode = booking.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/process\.env\.RAZORPAY/.test(bookingCode),
  'the booking controller still reads Razorpay credentials directly'); n++;
// Narrowly: no HMAC over the "order|payment" string, which IS the gateway
// signature. The file legitimately keeps one other createHmac — hashOtp, which
// peppers the booking OTP with JWT_SECRET and has nothing to do with payments.
// Asserting "no createHmac at all" would have demanded deleting working,
// unrelated security code.
assert.ok(!/\$\{orderId\}\|\$\{paymentId\}/.test(bookingCode),
  'the booking controller still builds the gateway signature payload itself'); n++;
const hmacs = (bookingCode.match(/createHmac/g) || []).length;
assert.strictEqual(hmacs, 1,
  `expected exactly one createHmac to survive (hashOtp); found ${hmacs}`); n++;
assert.ok(/function hashOtp/.test(bookingCode), 'the surviving createHmac is not hashOtp'); n++;
// Same care with timingSafeEqual: one use survives, comparing the OTP hash.
// That is a different secret (JWT_SECRET), a different threat, and it must not
// be deleted in the name of tidying up the gateway.
const tse = (bookingCode.match(/timingSafeEqual/g) || []).length;
assert.strictEqual(tse, 1, `expected exactly one timingSafeEqual to survive (the OTP check); found ${tse}`); n++;
const tseLine = bookingCode.split('\n').findIndex(l => l.includes('timingSafeEqual'));
const nearby = bookingCode.split('\n').slice(Math.max(0, tseLine - 4), tseLine + 1).join('\n');
assert.ok(/hashOtp/.test(nearby),
  'the surviving timingSafeEqual is not the OTP comparison'); n++;
assert.ok(!/api\.razorpay\.com/.test(bookingCode),
  'the booking controller still calls the gateway API directly'); n++;
assert.ok(/getGateway\(\)/.test(bookingCode),
  'the booking controller does not use the shared gateway'); n++;

// ── Mock mode: the booking SPA contract ─────────────────────────────────────
// Cleared keys, fresh module registry — the SPA matches on these exact strings.
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) delete process.env[k];
for (const k of Object.keys(require.cache)) if (k.includes('/services/gateway/')) delete require.cache[k];
const mock = require(`${BE}/src/services/gateway/razorpay.adapter.js`);

assert.strictEqual(mock.isConfigured(), false); n++;
assert.strictEqual(mock.publicKey(), 'rzp_test_mock', 'the booking SPA matches this literal'); n++;
assert.strictEqual(mock.mode(), 'test'); n++;
mock.createOrder({ amount: 1999, receipt: 'bk_abc' }).then(o => {
  assert.strictEqual(o.id, 'order_mock_bk_abc', 'mock order id shape changed — booking SPA breaks'); n++;
  assert.strictEqual(o.key_id, 'rzp_test_mock'); n++;

  // Mock accepts any callback (nothing was charged) …
  assert.strictEqual(mock.verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'anything' }), true); n++;
  // … but a WEBHOOK is an unauthenticated POST from the internet. It must be
  // refused when there is no secret to verify it with, mock mode or not.
  assert.strictEqual(mock.verifyWebhookSignature({ rawBody: 'x', signature: 'y' }), false,
    'an unverifiable webhook was accepted — anyone could mark an invoice paid'); n++;
  assert.strictEqual(mock.isWebhookConfigured(), false); n++;

  // Below the ₹1 floor, before the customer reaches checkout.
  return mock.createOrder({ amount: 0.5, receipt: 'x' }).then(
    () => { throw new Error('a sub-₹1 order was accepted'); },
    (e) => { assert.strictEqual(e.status, 400); n++; }
  );
}).then(() => {
  // ── Registry ──────────────────────────────────────────────────────────────
  assert.strictEqual(reg.getGateway().name, 'razorpay'); n++;
  assert.strictEqual(reg.getGateway('razorpay').name, 'razorpay'); n++;
  assert.throws(() => reg.getGateway('paypal'), /not supported/, 'an unknown gateway must fail loudly'); n++;
  console.log(`gateway adapter: ${n} checks passed`);
}).catch(e => { console.error(e); process.exit(1); });
