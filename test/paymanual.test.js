/**
 * Phase A — the manual Record Payment path, hardened.
 *
 * Nine defects are pinned here. Two of them could destroy the record of real
 * money (a gateway payment deleted through the manual endpoint; a delete that
 * commits without its recalculation), and one — no audit trail at all — meant
 * that when either happened there was nothing left to find out from.
 *
 * The handlers are exercised against a stubbed pg pool, so the assertions are
 * about what the code does rather than what its comments claim.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripSql = s => s.replace(/^\s*--.*$/gm, '');

process.env.JWT_SECRET = 'test';

// ── Fake database ───────────────────────────────────────────────────────────
const db = {
  log: [], invoice: null, payments: [], allocations: [], hubPaid: 0, nextPayId: 500,
  recalcThrows: false,
  reset(over = {}) {
    this.log = [];
    this.payments = [];
    this.allocations = [];
    this.hubPaid = 0;
    this.recalcThrows = false;
    this.invoice = {
      id: 42, status: 'approved', hub_id: null, grand_total: '2000.00',
      appointment_id: 11, estimate_id: 22, amount_paid: '0',
      public_token: 'tok', customer_name: 'A', mobile: '9876543210',
      vehicle_number: 'GJ01AB1234', ...over,
    };
  },
  // ALLOCATIONS, matching migration 133 — an invoice is paid what has been
  // applied to it, not what the customer handed over. Summing payments here
  // would let a handler that writes no allocation still look correct, which is
  // exactly the bug this models.
  seedPayment(row) {
    this.payments.push(row);
    this.allocations.push({
      ledger_payment_id: row.id,
      customer_invoice_id: this.invoice.id,
      amount: row.amount,
    });
    return row;
  },
  paidGross() {
    return this.allocations
      .filter(a => a.customer_invoice_id === this.invoice.id)
      .reduce((s, a) => s + Number(a.amount), 0);
  },
};

function route(sql, params) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  db.log.push(flat.slice(0, 130));

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };

  // The lock on the invoice row.
  if (/SELECT id FROM customer_invoices WHERE id = \$1 FOR UPDATE/.test(flat)) {
    return { rows: db.invoice ? [{ id: db.invoice.id }] : [], rowCount: db.invoice ? 1 : 0 };
  }
  if (/SELECT status FROM customer_invoices WHERE id = \$1 FOR UPDATE/.test(flat)) {
    return { rows: db.invoice ? [{ status: db.invoice.status }] : [], rowCount: db.invoice ? 1 : 0 };
  }
  // _assertCiHub
  if (/SELECT hub_id FROM customer_invoices WHERE id = \$1/.test(flat)) {
    return { rows: [{ hub_id: db.invoice?.hub_id ?? null }], rowCount: 1 };
  }
  // readInvoiceBalance
  if (/FROM customer_invoices ci LEFT JOIN appointments a/.test(flat)) {
    return { rows: [{ ...db.invoice, paid_gross: String(db.paidGross()), refunded: '0' }], rowCount: 1 };
  }
  // _hubPaidFor
  if (/COALESCE\(MAX\(pi\.amount_paid\), 0\) AS hub_paid/.test(flat)) {
    return { rows: [{ hub_paid: String(db.hubPaid) }], rowCount: 1 };
  }
  // WRITES ARE MATCHED FIRST, and the read below is anchored on SELECT.
  //
  // It was not, and `FROM customer_invoice_payments WHERE id = $1 AND
  // customer_invoice_id = $2` is a substring of the DELETE as well as of the
  // SELECT that precedes it — so the fake intercepted the DELETE, returned
  // rows, and the suite reported that a manual payment could not be deleted.
  // A harness that quietly answers the wrong statement invents failures that
  // are not in the code, which is as bad as missing ones that are.
  if (/INSERT INTO customer_invoice_payments/.test(sql)) {
    const row = {
      id: db.nextPayId++, amount: params[1], method: params[2],
      reference_no: params[3], paid_at: params[4] || '2026-08-13T00:00:00Z',
      notes: params[5], created_by: params[6], source: 'manual',
    };
    db.payments.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/INSERT INTO payment_allocations/.test(sql)) {
    db.allocations.push({
      ledger_payment_id: params[0], customer_invoice_id: params[1],
      amount: params[2], created_by: params[3],
    });
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM customer_invoice_payments/.test(sql)) {
    const before = db.payments.length;
    // ON DELETE CASCADE, as migration 133 declares it.
    const goingIds = db.payments.filter(p => p.id === params[0]
      && (!/AND source = 'manual'/.test(flat) || p.source === 'manual')).map(p => p.id);
    db.allocations = db.allocations.filter(a => !goingIds.includes(a.ledger_payment_id));
    // Honour the source filter — the whole point of the guard.
    db.payments = db.payments.filter(p => {
      if (p.id !== params[0]) return true;
      if (/AND source = 'manual'/.test(flat) && p.source !== 'manual') return true;
      return false;
    });
    return { rows: [], rowCount: before - db.payments.length };
  }
  if (/UPDATE customer_invoice_payments SET paid_at/.test(sql)) {
    const row = db.payments.find(p => p.id === params[1]);
    if (row && (!/AND source = 'manual'/.test(flat) || row.source === 'manual')) {
      row.paid_at = params[0];
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  // The pre-delete / pre-update read of the payment row. Anchored on SELECT —
  // see the note above the writes.
  if (/^SELECT /.test(flat)
      && /FROM customer_invoice_payments\s*(p)?\s*WHERE (p\.)?id = \$1 AND (p\.)?customer_invoice_id = \$2/.test(flat)) {
    const row = db.payments.find(p => p.id === params[0]);
    // A COPY, as a real driver returns. Handing back the live object let a
    // later UPDATE mutate a row the handler had already read into a local —
    // so the audit entry recorded the new date as the old one, and the suite
    // blamed the controller for the harness's aliasing.
    return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
  }
  // recalcInvoiceState's read
  if (/paid_gross/.test(flat) && /FROM customer_invoices ci WHERE ci\.id/.test(flat)) {
    if (db.recalcThrows) { const e = new Error('recalc exploded'); throw e; }
    return { rows: [{
      grand_total: db.invoice.grand_total, current_status: db.invoice.status,
      appointment_id: db.invoice.appointment_id, estimate_id: db.invoice.estimate_id,
      paid_gross: String(db.paidGross()), refunded: '0',
    }], rowCount: 1 };
  }
  if (/UPDATE customer_invoices SET amount_paid/.test(sql)) {
    db.invoice.amount_paid = params[0];
    db.invoice.status = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/FROM invoice_payment_lines cip/.test(flat)) {
    return { rows: db.payments, rowCount: db.payments.length };
  }
  if (/^SELECT ci\./.test(flat) || /CI_SELECT/.test(flat)) {
    return { rows: [{ ...db.invoice }], rowCount: 1 };
  }
  return { rows: [{ ...db.invoice }], rowCount: 1 };
}

const fakeClient = { query: async (s, p) => route(s, p), release() {} };
const fakePool = { query: async (s, p) => route(s, p), connect: async () => fakeClient };

// ── Stubs ───────────────────────────────────────────────────────────────────
const audit = [];
let sideEffectThrows = false;
const sideEffects = [];

for (const [p, mod] of Object.entries({
  [`${BE}/src/config/db.js`]: { pool: fakePool },
  [`${BE}/src/services/activityLog.service.js`]: { logActivity: (e) => audit.push(e) },
  [`${BE}/src/helpers/advanceAppointmentStatus.js`]: async (id, slug) => {
    sideEffects.push(`appt:${slug}`);
    if (sideEffectThrows) throw new Error('appointment service down');
  },
  [`${BE}/src/controllers/warranty_claims.controller.js`]: {
    resolveClaimForEstimate: async () => { sideEffects.push('claim:resolve'); },
    unresolveClaimForEstimate: async () => { sideEffects.push('claim:unresolve'); },
  },
  [`${BE}/src/utils/payoutSchedule.js`]: { syncPayoutDueDate: async () => {} },
  [`${BE}/src/services/whatsapp.dispatcher.js`]: { notifyWhatsApp: async () => {} },
  [`${BE}/src/utils/renderDocument.js`]: { loadCompany: async () => ({}), resolveRender: () => ({}), sendPdf: async () => {} },
})) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}

const ctrl = require(`${BE}/src/controllers/customer_invoices.controller.js`);

// ── Minimal express doubles ────────────────────────────────────────────────
function mkRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.set = () => res;
  return res;
}
function call(fn, { params = {}, body = {}, user = { id: 7, name: 'Advisor' } } = {}) {
  const res = mkRes();
  return new Promise((resolve) => {
    const next = (err) => { res.error = err; resolve(res); };
    const orig = res.json.bind(res);
    res.json = (b) => { orig(b); setTimeout(() => resolve(res), 0); return res; };
    Promise.resolve(fn({ params, body, user, get: () => null, query: {} }, res, next))
      .then(() => setTimeout(() => resolve(res), 5));
  });
}

(async () => {
  const src = fs.readFileSync(`${BE}/src/controllers/customer_invoices.controller.js`, 'utf8');
  const code = strip(src);

  // ══ A1 — GATEWAY PAYMENTS ARE NOT DELETABLE FROM HERE ═════════════════════
  {
    db.reset({ status: 'paid', amount_paid: '2000.00' });
    db.seedPayment({ id: 900, amount: '2000.00', method: 'upi', reference_no: null,
                       paid_at: '2026-08-10T10:00:00Z', source: 'gateway', created_by: null });
    audit.length = 0;

    const res = await call(ctrl.deletePayment, { params: { id: '42', payId: '900' } });
    assert.strictEqual(res.statusCode, 409,
      `a gateway payment was deletable through the manual endpoint (got ${res.statusCode})`); n++;
    assert.ok(/refund/i.test(res.body?.error || ''),
      'the refusal does not tell the user to refund it instead'); n++;
    assert.strictEqual(db.payments.length, 1, 'the gateway ledger row was destroyed'); n++;
  }
  {
    // …and its date is not editable either.
    db.reset();
    db.seedPayment({ id: 901, amount: '500.00', method: 'card', paid_at: '2026-08-10',
                       source: 'gateway' });
    const res = await call(ctrl.updatePayment,
      { params: { id: '42', payId: '901' }, body: { paid_at: '2026-08-01' } });
    assert.strictEqual(res.statusCode, 409, 'a gateway payment date was editable'); n++;
    assert.strictEqual(db.payments[0].paid_at, '2026-08-10', 'the gateway payment date was moved'); n++;
  }
  {
    // A manual payment still deletes normally — the guard must not block everything.
    db.reset();
    db.seedPayment({ id: 902, amount: '500.00', method: 'cash', reference_no: 'R1',
                       paid_at: '2026-08-10T00:00:00Z', source: 'manual' });
    const res = await call(ctrl.deletePayment, { params: { id: '42', payId: '902' } });
    assert.strictEqual(res.statusCode, 200, `a manual payment could not be deleted (${res.statusCode})`); n++;
    assert.strictEqual(db.payments.length, 0, 'the manual payment survived the delete'); n++;
  }
  // The SQL states the rule too, so moving an early return cannot lose it.
  assert.ok(/DELETE FROM customer_invoice_payments\s+WHERE id = \$1 AND customer_invoice_id = \$2 AND source = 'manual'/.test(code),
    "the DELETE statement is not scoped to source='manual'"); n++;
  assert.ok(/UPDATE customer_invoice_payments SET paid_at = \$1 WHERE id = \$2 AND source = 'manual'/.test(code),
    "the paid_at UPDATE is not scoped to source='manual'"); n++;

  // ══ A2 — DELETE IS ATOMIC WITH THE RECALC ═════════════════════════════════
  {
    db.reset({ status: 'paid' });
    db.seedPayment({ id: 903, amount: '2000.00', method: 'cash', paid_at: '2026-08-10T00:00:00Z', source: 'manual' });
    db.recalcThrows = true;

    const res = await call(ctrl.deletePayment, { params: { id: '42', payId: '903' } });
    // The row must still be there: the DELETE and the recalc share one
    // transaction, so a failing recalc takes the delete down with it.
    assert.ok(res.statusCode >= 400 || res.error, 'a failing recalc reported success'); n++;
    const order = db.log.join(' | ');
    const beginIdx = order.indexOf('BEGIN');
    const delIdx = order.indexOf('DELETE FROM customer_invoice_payments');
    assert.ok(beginIdx >= 0 && beginIdx < delIdx,
      'the DELETE runs before BEGIN — it commits on its own and cannot be rolled back'); n++;
    assert.ok(/ROLLBACK/.test(order), 'no ROLLBACK was issued when the recalc failed'); n++;
  }
  // Structural: exactly one pool-level DELETE must not exist in this file.
  assert.ok(!/await pool\.query\(`DELETE FROM customer_invoice_payments/.test(code),
    'the payment DELETE still runs on the pool, outside any transaction'); n++;

  // ══ A3 — THE OVERPAYMENT RACE ═════════════════════════════════════════════
  {
    db.reset();
    audit.length = 0;
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 500, method: 'cash' } });
    assert.strictEqual(res.statusCode, 201, `a valid payment was refused (${res.statusCode})`); n++;

    const order = db.log.join(' | ');
    const beginIdx = order.indexOf('BEGIN');
    const lockIdx = order.indexOf('FOR UPDATE');
    const insIdx = order.indexOf('INSERT INTO customer_invoice_payments');
    assert.ok(beginIdx >= 0 && beginIdx < lockIdx,
      'the invoice row is locked outside the transaction'); n++;
    assert.ok(lockIdx > 0 && lockIdx < insIdx,
      'the INSERT happens before the row lock — two tills can both pass the balance check'); n++;
  }
  {
    // Over the balance is refused, and refused from the LEDGER not the cache.
    db.reset({ amount_paid: '0' });               // cache says nothing paid…
    db.seedPayment({ id: 904, amount: '1900.00', method: 'cash', source: 'manual',
                       paid_at: '2026-08-10T00:00:00Z' });  // …ledger says otherwise
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 500, method: 'cash' } });
    assert.strictEqual(res.statusCode, 400,
      'the balance was read from the stale amount_paid cache instead of the ledger'); n++;
    assert.ok(/exceeds outstanding balance/.test(res.body?.error || ''),
      'the refusal does not name the real balance'); n++;
  }
  assert.ok(/FOR UPDATE/.test(code.slice(code.indexOf('function addPayment'), code.indexOf('function updatePayment'))),
    'addPayment does not lock the invoice row'); n++;
  assert.ok(/readInvoiceBalance\(client, id\)/.test(code),
    'addPayment does not read the balance from the ledger'); n++;

  // ══ PHASE 1 — THE PAYMENT AND ITS ALLOCATION ARE ONE ACT ══════════════════
  //
  // Since migration 133 an invoice is paid what has been ALLOCATED to it, not
  // what the customer handed over. A handler that records a payment without an
  // allocation records money that no invoice can see — and because the payment
  // row itself looks perfect, nothing else would ever notice.
  {
    db.reset();
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 1200, method: 'cash' } });
    assert.strictEqual(res.statusCode, 201); n++;

    assert.strictEqual(db.allocations.length, 1,
      'recording a payment wrote no allocation — the money is invisible to the invoice'); n++;
    const a = db.allocations[0];
    assert.strictEqual(a.customer_invoice_id, 42, 'the allocation points at the wrong invoice'); n++;
    assert.strictEqual(Number(a.amount), 1200, 'the allocation is for the wrong amount'); n++;
    assert.strictEqual(a.ledger_payment_id, db.payments[0].id,
      'the allocation does not point at the payment just written'); n++;
    assert.strictEqual(String(db.invoice.amount_paid), '1200.00',
      'the invoice did not pick up the payment'); n++;

    // ORDER MATTERS. recalcInvoiceState reads allocations, so an allocation
    // written after it recalculates a balance that excludes the payment just
    // made — the invoice would stay unpaid until something else recalculated.
    const order = db.log.join(' | ');
    const allocIdx  = order.indexOf('INSERT INTO payment_allocations');
    // `current_status`, not `paid_gross`. readInvoiceBalance selects paid_gross
    // too and runs BEFORE the insert, so matching on it finds the balance check
    // rather than the recalculation — and the assertion fails on correct code.
    // current_status appears only in recalcInvoiceState.
    const recalcIdx = order.indexOf('current_status');
    assert.ok(allocIdx > 0, 'no allocation insert reached the database'); n++;
    assert.ok(recalcIdx > 0, 'the recalculation never ran'); n++;
    assert.ok(allocIdx < recalcIdx,
      'the allocation is written AFTER the recalc — the invoice would not see the payment'); n++;

    // And both inside the same transaction as the payment.
    const beginIdx  = order.indexOf('BEGIN');
    const commitIdx = order.indexOf('COMMIT');
    assert.ok(beginIdx < allocIdx && allocIdx < commitIdx,
      'the allocation is written outside the payment transaction'); n++;
  }
  {
    // Deleting the payment must take the allocation with it, or the invoice
    // keeps counting money that no longer exists.
    db.reset();
    db.seedPayment({ id: 910, amount: '800.00', method: 'cash',
                     paid_at: '2026-08-10T00:00:00Z', source: 'manual' });
    assert.strictEqual(db.allocations.length, 1); n++;
    await call(ctrl.deletePayment, { params: { id: '42', payId: '910' } });
    assert.strictEqual(db.allocations.length, 0,
      'deleting a payment left its allocation — the invoice still counts it'); n++;
    assert.strictEqual(String(db.invoice.amount_paid), '0.00',
      'the invoice still shows a deleted payment as paid'); n++;
  }

  // ══ A4 — AUDIT LOGS ═══════════════════════════════════════════════════════
  {
    db.reset(); audit.length = 0;
    await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 750, method: 'upi', reference_no: 'UTR9' } });
    assert.strictEqual(audit.length, 1, `create wrote ${audit.length} audit entries, expected 1`); n++;
    assert.strictEqual(audit[0].action, 'CREATE'); n++;
    assert.strictEqual(audit[0].entity, 'customer_invoice_payment'); n++;
    assert.ok(/750\.00/.test(audit[0].description), 'the audit entry does not record the amount'); n++;
    assert.ok(/upi/.test(audit[0].description), 'the audit entry does not record the method'); n++;
    assert.ok(/UTR9/.test(audit[0].description), 'the audit entry does not record the reference'); n++;
    assert.strictEqual(audit[0].userId, 7, 'the audit entry does not record who did it'); n++;
  }
  {
    // The delete entry must survive the row it describes.
    db.reset();
    db.seedPayment({ id: 905, amount: '1234.50', method: 'bank_transfer', reference_no: 'NEFT7',
                       paid_at: '2026-08-09T00:00:00Z', source: 'manual' });
    audit.length = 0;
    await call(ctrl.deletePayment, { params: { id: '42', payId: '905' } });
    assert.strictEqual(audit.length, 1, 'delete wrote no audit entry'); n++;
    assert.strictEqual(audit[0].action, 'DELETE'); n++;
    for (const bit of ['1234.50', 'bank_transfer', 'NEFT7', '2026-08-09']) {
      assert.ok(audit[0].description.includes(bit),
        `the delete audit entry loses "${bit}" — the row is gone and this is the only record`); n++;
    }
  }
  {
    db.reset();
    db.seedPayment({ id: 906, amount: '100.00', method: 'cash', paid_at: '2026-08-10', source: 'manual' });
    audit.length = 0;
    await call(ctrl.updatePayment,
      { params: { id: '42', payId: '906' }, body: { paid_at: '2026-08-05' } });
    assert.strictEqual(audit.length, 1, 'the date edit wrote no audit entry'); n++;
    assert.ok(/2026-08-10/.test(audit[0].description) && /2026-08-05/.test(audit[0].description),
      'the audit entry does not record both the old and the new date'); n++;
  }
  // A refused mutation must not be logged as if it happened.
  {
    db.reset();
    db.seedPayment({ id: 907, amount: '50.00', method: 'upi', paid_at: '2026-08-10', source: 'gateway' });
    audit.length = 0;
    await call(ctrl.deletePayment, { params: { id: '42', payId: '907' } });
    assert.strictEqual(audit.length, 0, 'a refused delete was written to the audit log'); n++;
  }

  // ══ A5 — paid_at VALIDATION ═══════════════════════════════════════════════
  for (const bad of ['yesterday', '13-08-2026', '2026-13-45', 'not a date']) {
    db.reset();
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 100, method: 'cash', paid_at: bad } });
    assert.strictEqual(res.statusCode, 400,
      `paid_at "${bad}" produced ${res.statusCode} instead of a 400 — a bad date reads as a server fault`); n++;
  }
  {
    // A future date is refused: paid_at anchors the hub payout schedule.
    db.reset();
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 100, method: 'cash', paid_at: '2099-01-01' } });
    assert.strictEqual(res.statusCode, 400,
      'a future payment date was accepted — it would push a real hub payout out by that much'); n++;
  }
  {
    // Backdating still works — that is the feature this validation must not break.
    db.reset();
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 100, method: 'cash', paid_at: '2026-08-01' } });
    assert.strictEqual(res.statusCode, 201, 'a legitimate backdated payment was refused'); n++;
  }
  {
    // And so does an ISO timestamp, which is what the gateway-era callers send.
    db.reset();
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 100, method: 'cash', paid_at: '2026-08-01T09:30:00Z' } });
    assert.strictEqual(res.statusCode, 201, 'an ISO timestamp paid_at was refused'); n++;
  }

  // ══ A6 — POST-COMMIT SIDE EFFECTS ARE SWALLOWED ═══════════════════════════
  {
    db.reset();
    sideEffects.length = 0;
    sideEffectThrows = true;
    const res = await call(ctrl.addPayment,
      { params: { id: '42' }, body: { amount: 2000, method: 'cash' } });
    sideEffectThrows = false;
    assert.strictEqual(res.statusCode, 201,
      'a failing appointment transition turned a committed payment into a 500 — somebody records it twice'); n++;
    assert.strictEqual(db.payments.length, 1, 'the payment did not commit'); n++;
  }
  {
    // The happy path still fires them.
    db.reset();
    sideEffects.length = 0;
    await call(ctrl.addPayment, { params: { id: '42' }, body: { amount: 2000, method: 'cash' } });
    assert.ok(sideEffects.includes('appt:closed'),
      'a fully-paid invoice no longer closes its appointment'); n++;
    assert.ok(sideEffects.includes('claim:resolve'),
      'a fully-paid invoice no longer resolves its warranty claim'); n++;
  }

  // ══ A8 — THE TWO HUB-PAID GUARDS ASK THE SAME QUESTION ════════════════════
  assert.ok(/async function _hubPaidFor\(/.test(code), '_hubPaidFor does not exist'); n++;
  {
    const delBody = code.slice(code.indexOf('function deletePayment('));
    const updBody = code.slice(code.indexOf('function updatePayment('), code.indexOf('function deletePayment('));
    assert.ok(/_hubPaidFor\(/.test(delBody), 'deletePayment does not use the shared hub-paid guard'); n++;
    assert.ok(/_hubPaidFor\(/.test(updBody), 'updatePayment does not use the shared hub-paid guard'); n++;
    // The narrow query must be gone entirely.
    assert.ok(!/ORDER BY pi\.id DESC LIMIT 1/.test(code),
      'the narrow estimate_id-only hub-paid query is still there'); n++;
  }
  // The shared query matches BOTH links — that is the whole fix.
  {
    const helper = code.slice(code.indexOf('async function _hubPaidFor'), code.indexOf('const paidAtSchema'));
    assert.ok(/pi\.id = ci\.purchase_invoice_id/.test(helper),
      'the hub-paid guard does not match on purchase_invoice_id'); n++;
    assert.ok(/pi\.estimate_id = ci\.estimate_id/.test(helper),
      'the hub-paid guard does not match on estimate_id'); n++;
  }
  {
    // Behaviourally: hub paid ⇒ both refuse.
    db.reset();
    db.hubPaid = 1500;
    db.seedPayment({ id: 908, amount: '100.00', method: 'cash', paid_at: '2026-08-10', source: 'manual' });
    const del = await call(ctrl.deletePayment, { params: { id: '42', payId: '908' } });
    assert.strictEqual(del.statusCode, 409, 'a payment was deletable after the hub was paid'); n++;
    assert.strictEqual(db.payments.length, 1, 'the payment was deleted despite the hub payout'); n++;

    const upd = await call(ctrl.updatePayment,
      { params: { id: '42', payId: '908' }, body: { paid_at: '2026-08-01' } });
    assert.strictEqual(upd.statusCode, 409, 'a payment date was movable after the hub was paid'); n++;
  }

  // ══ A9 — MIGRATION 130 ════════════════════════════════════════════════════
  const m130 = stripSql(fs.readFileSync(`${BE}/db/migrations/130_payment_amount_width.sql`, 'utf8'));
  assert.ok(/ALTER COLUMN amount TYPE NUMERIC\(12,2\)/.test(m130), 'the amount column is not widened'); n++;
  assert.ok(!/BEGIN;|COMMIT;/.test(m130), 'the migration opens its own transaction — migrate.js wraps it'); n++;
  assert.ok(!/NUMERIC\(10,2\)/.test(m130), 'the migration narrows the column somewhere'); n++;
  assert.ok(!/DROP |DELETE FROM/.test(m130), 'the migration is destructive'); n++;
  // Applied migrations are immutable.
  const m065 = fs.readFileSync(`${BE}/db/migrations/065_create_invoicing_tables.sql`, 'utf8');
  assert.ok(/NUMERIC\(10,2\) NOT NULL CHECK \(amount > 0\)/.test(m065),
    'migration 065 was edited — applied migrations are immutable'); n++;

  // ══ A7 — THE LEGACY ROUTES ARE UNMOUNTED ══════════════════════════════════
  const server = strip(fs.readFileSync(`${BE}/src/server.js`, 'utf8'));
  assert.ok(!/app\.use\('\/api\/invoices\/:id\/payments'/.test(server),
    'the legacy /api/invoices/:id/payments router is still mounted — unscoped, and EDIT_INVOICE can delete a payment through it'); n++;
  assert.ok(!/invoicePaymentsRoutes/.test(server),
    'the legacy router is still required — one line from being re-enabled by accident'); n++;
  // The customer-invoice payment routes must NOT have been caught in the sweep.
  const ciRoutes = strip(fs.readFileSync(`${BE}/src/routes/customer_invoices.routes.js`, 'utf8'));
  for (const rt of [`router.post('/:id/payments'`, `router.patch('/:id/payments/:payId'`, `router.delete('/:id/payments/:payId'`]) {
    assert.ok(ciRoutes.includes(rt), `${rt} was removed — the working endpoint is gone`); n++;
  }
  assert.ok(/DELETE_INVOICE_PAYMENT/.test(ciRoutes), 'the delete permission was weakened'); n++;

  // ══ THE LEDGER PROJECTION AND THE UI ══════════════════════════════════════
  assert.ok(/cip\.source/.test(code), '_getPayments does not return source — the UI cannot tell the two apart'); n++;
  const page = strip(fs.readFileSync(`${FE}/pages/CustomerInvoicesPage.jsx`, 'utf8'));
  assert.ok(/const isOnline = pay =>/.test(page), 'the UI has no way to identify a gateway payment'); n++;
  // The condition widened when advances began appearing in this list (they are
  // locked for a different reason — see advanceui.test.js), so this asks that
  // isOnline still decides the branch, not that it is the only thing deciding.
  assert.ok(/canDeletePay &&/.test(page) && /isOnline\(pay\)[^?\n]*\?/.test(page),
    'the delete button is still offered for online payments — it would only ever 409'); n++;
  assert.ok(/canEditPayDate && !isOnline\(pay\)/.test(page),
    'the date-edit pencil is still offered for online payments'); n++;

  console.log(`manual payment path (phase A): ${n} checks passed`);
})().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
