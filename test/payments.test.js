/**
 * Phase 2 — taking a payment against an invoice.
 *
 * Exercises the REAL services/payments.service.js against a stubbed pg pool, so
 * the assertions are about what the code does, not about what it says it does.
 * The fake pool records every statement, which is how the transaction and
 * locking claims are checked rather than assumed.
 */
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

const BE = require('path').resolve(__dirname, '..');
let n = 0;

process.env.RAZORPAY_KEY_ID = 'rzp_live_TESTKEY123456';
process.env.RAZORPAY_KEY_SECRET = 'secret_abcdef0123456789';

// ── The fake database ───────────────────────────────────────────────────────
// A query router keyed on SQL fragments. `log` is the assertion surface: BEGIN,
// FOR UPDATE and COMMIT either appear in the right order or they do not.
const db = {
  log: [],
  invoice: null,
  txn: null,
  ledgerInserted: 0,
  ledgerConflict: false,
  allocations: [],
  updates: [],
  reset() {
    this.log = []; this.ledgerInserted = 0; this.ledgerConflict = false; this.updates = [];
    this.allocations = [];
  },
};

function route(sql, params) {
  db.log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 90));

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };

  // readInvoiceBalance
  if (/FROM customer_invoices ci\s+LEFT JOIN appointments/.test(sql)) {
    return { rows: db.invoice ? [db.invoice] : [], rowCount: db.invoice ? 1 : 0 };
  }
  // INSERT payment_transactions ... RETURNING *
  if (/INSERT INTO payment_transactions/.test(sql)) {
    db.txn = {
      id: 77, txn_ref: params[0], gateway: params[1], mode: params[2],
      entity_type: 'customer_invoice', entity_id: params[3], hub_id: params[4],
      mobile: params[5], amount: params[6], status: 'created',
      gateway_order_id: params[7], payment_link_id: params[8], created_by: params[9],
      gateway_payment_id: null, method_detail: null,
    };
    return { rows: [db.txn], rowCount: 1 };
  }
  // find by order id
  if (/FROM payment_transactions WHERE gateway_order_id/.test(sql)) {
    return { rows: db.txn && db.txn.gateway_order_id === params[0] ? [db.txn] : [], rowCount: db.txn ? 1 : 0 };
  }
  // the locking read
  if (/FROM payment_transactions WHERE id = \$1 FOR UPDATE/.test(sql)) {
    return { rows: db.txn ? [db.txn] : [], rowCount: db.txn ? 1 : 0 };
  }
  if (/UPDATE payment_transactions/.test(sql)) {
    db.updates.push({ sql: sql.replace(/\s+/g, ' '), params });
    if (/status = 'captured'/.test(sql)) db.txn.status = 'captured';
    if (/status = 'failed'/.test(sql)) db.txn.status = 'failed';
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO customer_invoice_payments/.test(sql)) {
    if (db.ledgerConflict) return { rows: [], rowCount: 0 };   // ON CONFLICT DO NOTHING
    db.ledgerInserted++;
    return { rows: [{ id: 900 + db.ledgerInserted }], rowCount: 1 };
  }
  // Since migration 133 it is the ALLOCATION that makes an invoice paid, not
  // the ledger row. Modelling it the old way would let a capture that writes
  // no allocation still settle the invoice — exactly the defect to guard.
  if (/INSERT INTO payment_allocations/.test(sql)) {
    db.allocations.push({ ledger_payment_id: params[0], customer_invoice_id: params[1], amount: params[2] });
    db.invoice.paid_gross = String(Number(db.invoice.paid_gross) + Number(params[2]));
    return { rows: [], rowCount: 1 };
  }
  // recalcInvoiceState's read
  if (/paid_gross/.test(sql) && /FROM customer_invoices ci WHERE ci\.id/.test(sql.replace(/\s+/g, ' '))) {
    return { rows: [{
      grand_total: db.invoice.grand_total,
      current_status: db.invoice.status,
      appointment_id: db.invoice.appointment_id,
      estimate_id: db.invoice.estimate_id,
      paid_gross: db.invoice.paid_gross,
      refunded: db.invoice.refunded,
    }], rowCount: 1 };
  }
  if (/UPDATE customer_invoices SET amount_paid/.test(sql)) {
    db.invoice.amount_paid = params[0];
    db.invoice.status = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE payment_links/.test(sql)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const fakeClient = { query: async (sql, params) => route(sql, params), release() {} };
const fakePool = { query: async (sql, params) => route(sql, params), connect: async () => fakeClient };

// ── Stub the modules the service reaches for ────────────────────────────────
const origResolve = Module._resolveFilename;
const stubs = {
  [`${BE}/src/config/db.js`]: { pool: fakePool },
  [`${BE}/src/utils/payoutSchedule.js`]: { syncPayoutDueDate: async () => {} },
  [`${BE}/src/helpers/advanceAppointmentStatus.js`]: async () => {},
  [`${BE}/src/controllers/warranty_claims.controller.js`]: { resolveClaimForEstimate: async () => {} },
};
for (const [p, mod] of Object.entries(stubs)) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}

const svc = require(`${BE}/src/services/payments.service.js`);
const gateway = require(`${BE}/src/services/gateway/razorpay.adapter.js`);

// Do not let a test reach the real gateway.
let lastOrderArgs = null;
gateway.createOrder = async (args) => { lastOrderArgs = args; return { id: 'order_STUB1', key_id: 'rzp_live_TESTKEY123456' }; };
let fetchPaymentImpl = async () => ({
  gateway_payment_id: 'pay_STUB1', gateway_order_id: 'order_STUB1',
  amount: 0, captured: true, status: 'captured', method_detail: 'upi',
  error_code: null, error_description: null, raw: { id: 'pay_STUB1', status: 'captured' },
});
gateway.fetchPayment = (...a) => fetchPaymentImpl(...a);

function seedInvoice(over = {}) {
  db.reset();
  db.txn = null;
  db.invoice = {
    id: 42, public_token: 'tok_abc', status: 'approved', hub_id: 5,
    grand_total: '2000.00', paid_gross: '0', refunded: '0',
    customer_name: 'A Customer', mobile: '9876543210',
    appointment_id: 11, estimate_id: 22, vehicle_number: 'GJ01AB1234',
    amount_paid: '0',
    ...over,
  };
  // readInvoiceBalance derives these; the fake returns the raw row and the
  // service does the arithmetic, which is what we want to test.
  return db.invoice;
}

(async () => {
  // ── The amount is decided by the SERVER ───────────────────────────────────
  seedInvoice();
  let out = await svc.createInvoiceOrder({ customerInvoiceId: 42, userId: 3 });
  assert.strictEqual(out.order.amount, 2000, 'no amount asked → the full balance'); n++;
  assert.strictEqual(lastOrderArgs.amount, 2000, 'the gateway was asked for the balance'); n++;

  // A client asking for MORE than the balance gets the balance. This is the
  // single most important assertion in this file: it is the overcharge.
  seedInvoice();
  out = await svc.createInvoiceOrder({ customerInvoiceId: 42, requestedAmount: 999999 });
  assert.strictEqual(out.order.amount, 2000, 'a client inflated the charge above the balance'); n++;

  // Asking for LESS is a legitimate part payment and is honoured.
  seedInvoice();
  out = await svc.createInvoiceOrder({ customerInvoiceId: 42, requestedAmount: 500 });
  assert.strictEqual(out.order.amount, 500, 'a part payment was not honoured'); n++;

  // Partly paid already → the order is for what is LEFT, not the total.
  seedInvoice({ paid_gross: '1500' });
  out = await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  assert.strictEqual(out.order.amount, 500, 'the order ignored money already paid'); n++;

  // A processed refund puts money back on the bill.
  seedInvoice({ paid_gross: '2000', refunded: '500' });
  out = await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  assert.strictEqual(out.order.amount, 500, 'a refund did not restore the balance'); n++;

  for (const [why, over] of [
    ['a cancelled invoice',   { status: 'cancelled' }],
    ['a fully paid invoice',  { paid_gross: '2000' }],
  ]) {
    seedInvoice(over);
    await assert.rejects(() => svc.createInvoiceOrder({ customerInvoiceId: 42 }),
      e => e.status === 409, `${why} accepted a new order`); n++;
  }
  for (const bad of [0, -100, 'abc', NaN]) {
    seedInvoice();
    await assert.rejects(() => svc.createInvoiceOrder({ customerInvoiceId: 42, requestedAmount: bad }),
      e => e.status === 400, `requestedAmount ${bad} was accepted`); n++;
  }
  seedInvoice();
  db.invoice = null;
  await assert.rejects(() => svc.createInvoiceOrder({ customerInvoiceId: 999 }), e => e.status === 404); n++;

  // The response to the browser carries the PUBLIC key and no secret.
  seedInvoice();
  out = await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  const wire = JSON.stringify(out.order);
  assert.ok(!wire.includes(process.env.RAZORPAY_KEY_SECRET), 'the order response leaked the secret'); n++;
  assert.strictEqual(out.order.key_id, 'rzp_live_TESTKEY123456', 'the public key must reach the browser'); n++;
  assert.ok(out.order.txn_ref.startsWith('PY'), 'our own reference is missing'); n++;
  // Gateway notes are echoed back in webhooks and shown in the provider's
  // dashboard — no customer identity may be in them.
  assert.ok(!JSON.stringify(lastOrderArgs.notes).includes('9876543210'),
    'the customer mobile was sent to the gateway in notes'); n++;
  assert.ok(!JSON.stringify(lastOrderArgs.notes).includes('A Customer'),
    'the customer name was sent to the gateway in notes'); n++;

  // ── Capture: the transaction shape ────────────────────────────────────────
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  db.log.length = 0;
  const cap = await svc.captureVerifiedPayment({
    txnId: 77, gatewayPaymentId: 'pay_1',
    gatewayPayment: { amount: 2000, method_detail: 'upi', raw: { id: 'pay_1', status: 'captured' } },
  });
  assert.strictEqual(cap.captured, true); n++;
  assert.strictEqual(cap.duplicate, false); n++;
  assert.strictEqual(cap.invoice_status, 'paid', 'a full capture did not mark the invoice paid'); n++;
  // A ledger row with no allocation is money no invoice can see (migration 133).
  assert.strictEqual(db.allocations.length, 1,
    'the capture wrote a ledger row but no allocation — the invoice would stay unpaid'); n++;
  assert.strictEqual(db.allocations[0].customer_invoice_id, 42,
    'the allocation points at the wrong invoice'); n++;
  assert.strictEqual(Number(db.allocations[0].amount), 2000,
    'the allocation is for a different amount than was captured'); n++;
  assert.strictEqual(db.ledgerInserted, 1, 'exactly one ledger row per capture'); n++;

  const first = db.log[0], last = db.log[db.log.length - 1];
  assert.strictEqual(first, 'BEGIN', `capture did not open a transaction (got '${first}')`); n++;
  assert.strictEqual(last, 'COMMIT', `capture did not commit last (got '${last}')`); n++;
  const lockIdx = db.log.findIndex(s => /FOR UPDATE/.test(s));
  const insIdx  = db.log.findIndex(s => /INSERT INTO customer_invoice_payments/.test(s));
  assert.ok(lockIdx > 0, 'the transaction row is read without FOR UPDATE — two captures can race'); n++;
  assert.ok(lockIdx < insIdx, 'the ledger row is written before the lock is taken'); n++;
  // The recompute must be inside the same transaction, not after the commit.
  const recalcIdx = db.log.findIndex(s => /UPDATE customer_invoices SET amount_paid/.test(s));
  assert.ok(recalcIdx > insIdx && recalcIdx < db.log.length - 1,
    'the invoice status recompute is outside the capture transaction'); n++;

  // ── Duplicates: the browser callback and the webhook both arrive ──────────
  // Second call on an already-captured txn: early return, nothing written.
  db.log.length = 0;
  const dupe = await svc.captureVerifiedPayment({ txnId: 77, gatewayPaymentId: 'pay_1' });
  assert.strictEqual(dupe.duplicate, true, 'a repeat capture was not recognised'); n++;
  assert.strictEqual(db.ledgerInserted, 1, 'a repeat capture wrote a SECOND ledger row'); n++;
  assert.ok(!db.log.some(s => /INSERT INTO customer_invoice_payments/.test(s)),
    'a repeat capture attempted a ledger insert'); n++;
  assert.strictEqual(db.allocations.length, 1,
    'a repeat capture wrote a second ALLOCATION — the invoice would count the money twice'); n++;

  // And the backstop: even if the status check were bypassed, the unique index
  // makes the insert a no-op and the caller must notice.
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  db.ledgerConflict = true;
  const conflicted = await svc.captureVerifiedPayment({
    txnId: 77, gatewayPaymentId: 'pay_2', gatewayPayment: { amount: 2000, method_detail: 'card' },
  });
  assert.strictEqual(conflicted.duplicate, true,
    'a unique-index conflict on the ledger was reported as a fresh capture'); n++;
  assert.strictEqual(db.ledgerInserted, 0); n++;
  // THE ONE THAT MATTERS. payment_allocations has no unique index — one payment
  // is legitimately allowed several allocations once advances exist. So when
  // the ledger insert is swallowed by ON CONFLICT, nothing in the database
  // stops a second allocation being written for the same money. The guard has
  // to be `if (led.rows[0])` in the service, and this is what checks it.
  assert.strictEqual(db.allocations.length, 0,
    'a swallowed ledger insert still produced an allocation — the invoice would be paid twice over'); n++;

  // ── Partial capture leaves the invoice partially paid ─────────────────────
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42, requestedAmount: 750 });
  const part = await svc.captureVerifiedPayment({
    txnId: 77, gatewayPaymentId: 'pay_3', gatewayPayment: { amount: 750, method_detail: 'upi' },
  });
  assert.strictEqual(part.invoice_status, 'partially_paid'); n++;
  assert.strictEqual(part.amount, 750); n++;

  // ── The gateway's amount wins over ours ───────────────────────────────────
  // If the two ever disagree, what the bank actually took is the truth. A
  // capture recorded at OUR figure would silently lose or invent money.
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42, requestedAmount: 1000 });
  const differing = await svc.captureVerifiedPayment({
    txnId: 77, gatewayPaymentId: 'pay_4', gatewayPayment: { amount: 900, method_detail: 'card' },
  });
  assert.strictEqual(differing.amount, 900, 'our own figure overrode what the gateway captured'); n++;

  // ── verifyCallback: signature first, and nothing written on a mismatch ────
  function sign(o, p) {
    return crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
  }
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  db.log.length = 0;
  await assert.rejects(
    () => svc.verifyCallback({ gatewayOrderId: 'order_STUB1', gatewayPaymentId: 'pay_9', signature: 'forged' }),
    e => e.status === 400, 'a forged signature was accepted'); n++;
  assert.strictEqual(db.ledgerInserted, 0, 'a forged signature still wrote to the ledger'); n++;
  assert.strictEqual(db.txn.status, 'failed', 'a forged signature was not recorded as a failure'); n++;
  assert.ok(!db.log.some(s => /INSERT INTO customer_invoice_payments/.test(s))); n++;
  // The error message must not echo the signature back.
  try {
    await svc.verifyCallback({ gatewayOrderId: 'order_STUB1', gatewayPaymentId: 'p', signature: 'forged' });
  } catch (e) {
    assert.ok(!e.message.includes('forged'), 'the failure message echoed the submitted signature'); n++;
    assert.ok(e.message.includes('PY'), 'the failure message gives the customer no reference'); n++;
  }

  // An order WE never created is refused before any signature is even checked.
  seedInvoice();
  db.txn = null;
  await assert.rejects(
    () => svc.verifyCallback({ gatewayOrderId: 'order_NEVER_MADE', gatewayPaymentId: 'p', signature: sign('order_NEVER_MADE', 'p') }),
    e => e.status === 404, 'a payment against an unknown order was accepted'); n++;

  // A valid signature captures.
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  fetchPaymentImpl = async () => ({
    gateway_payment_id: 'pay_ok', amount: 2000, captured: true, status: 'captured',
    method_detail: 'upi', error_code: null, error_description: null, raw: { id: 'pay_ok' },
  });
  const ok = await svc.verifyCallback({
    gatewayOrderId: 'order_STUB1', gatewayPaymentId: 'pay_ok', signature: sign('order_STUB1', 'pay_ok'),
  });
  assert.strictEqual(ok.captured, true); n++;
  assert.strictEqual(ok.invoice_status, 'paid'); n++;
  assert.strictEqual(db.ledgerInserted, 1); n++;

  // A valid signature on a payment the GATEWAY says failed must not capture.
  // A signature proves the gateway issued the pair, not that money moved.
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  fetchPaymentImpl = async () => ({
    gateway_payment_id: 'pay_bad', amount: 2000, captured: false, status: 'failed',
    method_detail: 'card', error_code: 'BAD_CARD', error_description: 'Declined', raw: {},
  });
  await assert.rejects(
    () => svc.verifyCallback({ gatewayOrderId: 'order_STUB1', gatewayPaymentId: 'pay_bad', signature: sign('order_STUB1', 'pay_bad') }),
    e => e.status === 402, 'a gateway-reported failure was captured anyway'); n++;
  assert.strictEqual(db.ledgerInserted, 0, 'a failed payment reached the ledger'); n++;

  // An unreachable gateway does NOT undo a verified signature — capture goes
  // ahead on the order amount and the webhook fills in the detail later.
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  fetchPaymentImpl = async () => { throw new Error('network down'); };
  const degraded = await svc.verifyCallback({
    gatewayOrderId: 'order_STUB1', gatewayPaymentId: 'pay_x', signature: sign('order_STUB1', 'pay_x'),
  });
  assert.strictEqual(degraded.captured, true,
    'a momentarily unreachable gateway lost a verified payment'); n++;
  assert.strictEqual(degraded.amount, 2000); n++;

  // ── The ledger row is written correctly ───────────────────────────────────
  // source='gateway' and the transaction link are what make the refund maths
  // and the duplicate guard work at all.
  const insertSql = db.log.find(s => /INSERT INTO customer_invoice_payments/.test(s));
  assert.ok(insertSql, 'no ledger insert was issued'); n++;
  const fullInsert = `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes,
          created_by, payment_transaction_id, source)`;
  const svcSrc = require('fs').readFileSync(`${BE}/src/services/payments.service.js`, 'utf8');
  assert.ok(svcSrc.includes('payment_transaction_id, source'),
    'the ledger insert does not set payment_transaction_id and source'); n++;
  assert.ok(/'gateway'/.test(svcSrc), "the ledger insert does not mark source='gateway'"); n++;
  assert.ok(/ON CONFLICT DO NOTHING/.test(svcSrc),
    'the ledger insert has no ON CONFLICT guard — a race writes two rows'); n++;
  assert.ok(/FOR UPDATE/.test(svcSrc), 'the transaction row is never locked'); n++;

  // ── markFailed never touches a captured payment ───────────────────────────
  seedInvoice();
  await svc.createInvoiceOrder({ customerInvoiceId: 42 });
  db.updates.length = 0;
  await svc.markFailed({ txnId: 77, code: 'X', description: 'y' });
  const failSql = db.updates.find(u => /status = 'failed'/.test(u.sql));
  assert.ok(failSql, 'markFailed issued no update'); n++;
  assert.ok(/status NOT IN \('captured'/.test(failSql.sql),
    'markFailed can overwrite a captured payment — money would vanish from the record'); n++;

  console.log(`payments service: ${n} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
