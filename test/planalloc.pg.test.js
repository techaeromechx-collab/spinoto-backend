/**
 * planAllocation and the free-vs-held credit split, against a REAL PostgreSQL.
 *
 * ── What this suite is protecting ───────────────────────────────────────────
 *
 * planAllocation decides where a customer's money goes when nobody picked an
 * invoice. Getting it wrong does not raise an error — it silently settles the
 * wrong invoice, and the only symptom is an ageing report that stops making
 * sense weeks later. So every rule is asserted against real rows: the ordering,
 * the hub boundary, the paise tolerance, and what an override may and may not
 * do.
 *
 * ── And the behaviour it CHANGES ────────────────────────────────────────────
 *
 * creditFor used to answer "how much of this customer's money is unapplied"
 * and that number was treated as spendable. It included deposits taken against
 * jobs that had not been invoiced yet — so applying credit to any invoice could
 * spend the deposit for a different job. HELD_SQL is the fix and the cases
 * below are the proof, including that creditFor's own return value is
 * unchanged so nothing reading it can break.
 *
 * Skips cleanly when no scratch server is running.
 *
 *   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgd \
 *                   -o '-p 5433 -k /tmp' start"
 */
const assert = require('assert');
const path = require('path');
const { Pool } = require('pg');

const BE = path.resolve(__dirname, '..');
const DBNAME = 'spinoto_planalloc_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };
let n = 0;

const SCHEMA = `
CREATE TABLE users        (id SERIAL PRIMARY KEY, name TEXT);
-- hub_name, as migration 016 declares it. A stub table with a
-- convenient "name" column is how h.name reached production.
CREATE TABLE hubs         (id SERIAL PRIMARY KEY, hub_name TEXT);
CREATE TABLE appointments (id SERIAL PRIMARY KEY, customer_name TEXT, mobile TEXT, vehicle_number TEXT);
CREATE TABLE payment_transactions (id SERIAL PRIMARY KEY);

CREATE TABLE estimates (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id),
  hub_id INTEGER NOT NULL REFERENCES hubs(id),
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_name VARCHAR(160), mobile VARCHAR(20), vehicle_number VARCHAR(30),
  estimate_date DATE NOT NULL DEFAULT CURRENT_DATE);

CREATE TABLE customer_invoices (
  id SERIAL PRIMARY KEY,
  estimate_id INTEGER REFERENCES estimates(id),
  appointment_id INTEGER REFERENCES appointments(id),
  hub_id INTEGER REFERENCES hubs(id),
  customer_name VARCHAR(160), mobile VARCHAR(20), vehicle_number VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated','approved','partially_paid','paid','cancelled')),
  grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  public_token VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ci_estimate_id UNIQUE (estimate_id));

CREATE TABLE customer_invoice_payments (
  id SERIAL PRIMARY KEY,
  customer_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method VARCHAR(30) NOT NULL DEFAULT 'cash',
  reference_no VARCHAR(100),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT, created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payment_transaction_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  payment_type VARCHAR(20) NOT NULL DEFAULT 'invoice' CHECK (payment_type IN ('invoice','advance')),
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  booking_id INTEGER, mobile VARCHAR(20), vehicle_number VARCHAR(30),
  voucher_no VARCHAR(30), voucher_fy VARCHAR(9), voucher_seq INTEGER,
  public_token VARCHAR(20), gst_amount NUMERIC(12,2), gst_rate NUMERIC(5,2),
  CONSTRAINT cip_invoice_payment_has_invoice
    CHECK (payment_type <> 'invoice' OR customer_invoice_id IS NOT NULL));

CREATE TABLE payment_allocations (
  id SERIAL PRIMARY KEY,
  ledger_payment_id INTEGER NOT NULL REFERENCES customer_invoice_payments(id) ON DELETE CASCADE,
  customer_invoice_id INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE TABLE payment_refunds (
  id SERIAL PRIMARY KEY,
  payment_transaction_id INTEGER REFERENCES payment_transactions(id),
  ledger_payment_id INTEGER REFERENCES customer_invoice_payments(id) ON DELETE SET NULL,
  customer_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE SET NULL,
  hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE OR REPLACE VIEW invoice_payment_lines AS
SELECT a.id AS allocation_id, a.customer_invoice_id, a.amount, a.created_at AS allocated_at,
       cip.id AS payment_id, cip.amount AS payment_amount, cip.method, cip.reference_no,
       cip.paid_at, cip.notes, cip.created_by, cip.source, cip.hub_id,
       cip.payment_transaction_id, cip.payment_type, cip.voucher_no, cip.estimate_id
  FROM payment_allocations a
  JOIN customer_invoice_payments cip ON cip.id = a.ledger_payment_id;

CREATE TABLE advance_voucher_sequences (
  id SERIAL PRIMARY KEY, hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  fy VARCHAR(9) NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doc_kind VARCHAR(10) NOT NULL DEFAULT 'receipt');
CREATE UNIQUE INDEX uq_avs ON advance_voucher_sequences (fy, doc_kind, COALESCE(hub_id, -1));

CREATE TABLE company_settings (id INTEGER PRIMARY KEY, advance_default_gst_rate NUMERIC(5,2));
INSERT INTO company_settings (id, advance_default_gst_rate) VALUES (1, 18);
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('planalloc (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  // Point the app's pool at the scratch database BEFORE the service is loaded,
  // the same way vouchers.pg.test.js does. Nothing is stubbed: these are the
  // exact queries production runs.
  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;
  const { pool } = require(path.join(BE, 'src/config/db'));
  const svc = require(path.join(BE, 'src/services/advances.service'));

  await pool.query(SCHEMA);

  const MOB = '9712301573';
  let HUB_A, HUB_B;

  async function reset() {
    await pool.query(`TRUNCATE payment_refunds, payment_allocations, customer_invoice_payments,
                               customer_invoices, estimates, appointments, hubs, users,
                               payment_transactions, advance_voucher_sequences
                      RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO users (name) VALUES ('Tester')`);
    HUB_A = (await pool.query(`INSERT INTO hubs (hub_name) VALUES ('Satellite') RETURNING id`)).rows[0].id;
    HUB_B = (await pool.query(`INSERT INTO hubs (hub_name) VALUES ('Bopal') RETURNING id`)).rows[0].id;
  }

  const inv = async ({ total, date, hub = HUB_A, status = 'generated', mobile = MOB, estimateId = null }) =>
    (await pool.query(
      `INSERT INTO customer_invoices (mobile, hub_id, grand_total, invoice_date, status, estimate_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [mobile, hub, total, date, status, estimateId])).rows[0].id;

  async function paid(ciId, amount) {
    const p = await pool.query(
      `INSERT INTO customer_invoice_payments (customer_invoice_id, amount, mobile, payment_type)
       VALUES ($1,$2,$3,'invoice') RETURNING id`, [ciId, amount, MOB]);
    await pool.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
                      VALUES ($1,$2,$3)`, [p.rows[0].id, ciId, amount]);
    return p.rows[0].id;
  }

  const credit = async (amount) => (await pool.query(
    `INSERT INTO customer_invoice_payments (amount, mobile, payment_type, voucher_no)
     VALUES ($1,$2,'advance','ADV-1') RETURNING id`, [amount, MOB])).rows[0].id;

  async function deposit(amount, { hub = HUB_A, invoiced = false, invoiceStatus = 'generated' } = {}) {
    const eid = (await pool.query(
      `INSERT INTO estimates (hub_id, grand_total, mobile, vehicle_number, customer_name)
       VALUES ($1,$2,$3,'GJ01AB1234','Rajesh') RETURNING id`, [hub, amount * 2, MOB])).rows[0].id;
    if (invoiced) await inv({ total: amount * 2, date: '2026-08-10', hub, status: invoiceStatus, estimateId: eid });
    const pid = (await pool.query(
      `INSERT INTO customer_invoice_payments (amount, mobile, payment_type, estimate_id, hub_id, voucher_no)
       VALUES ($1,$2,'advance',$3,$4,'ADV-9') RETURNING id`, [amount, MOB, eid, hub])).rows[0].id;
    return { paymentId: pid, estimateId: eid };
  }

  const takes = p => p.lines.map(l => l.take);
  const eqA = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
  const eqS = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
  const okA = (c, m) => { assert.ok(c, m); n++; };

  // ══ The rule ═══════════════════════════════════════════════════════════════
  await reset();
  await inv({ total: 5000, date: '2026-06-11' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqA(takes(p), [5000], 'one invoice with the exact amount was not paid in full');
    eqS(p.lines[0].settles, true, 'an exactly-covered invoice does not read as settled');
    eqS(p.leftover, 0, 'money was left over that had somewhere to go');
  }

  await reset();
  await inv({ total: 4000, date: '2026-05-25' });
  await inv({ total: 6000, date: '2026-06-02' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqA(takes(p), [4000, 1000], '₹5,000 across ₹4,000 + ₹6,000 did not fill the older one first');
    eqS(p.lines[1].after, 5000, 'the second invoice reports the wrong remaining balance');
    eqS(p.leftover, 0, 'money was left over that had somewhere to go');
  }

  // Oldest means oldest by BUSINESS date. Backdating (migration 100) makes
  // invoice_date and id disagree deliberately, and the ageing report follows
  // the date — so the plan must too.
  await reset();
  await inv({ total: 4000, date: '2026-06-20' });
  await inv({ total: 3000, date: '2026-01-05' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 3000, hubId: HUB_A });
    eqS(Number(p.lines[0].due), 3000, 'the plan ordered by id instead of by invoice date');
    eqA(takes(p), [3000, 0], 'the backdated invoice was not settled first');
  }

  await reset();
  await inv({ total: 4000, date: '2026-05-25' });
  await inv({ total: 6000, date: '2026-06-02' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 2500, hubId: HUB_A });
    eqA(takes(p), [2500, 0], 'a part payment leaked onto the second invoice');
    eqA(p.lines.map(l => l.settles), [false, false], 'a part payment claimed to settle something');
  }

  await reset();
  await inv({ total: 4000, date: '2026-05-25' });
  await inv({ total: 6000, date: '2026-06-02' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 12000, hubId: HUB_A });
    eqA(takes(p), [4000, 6000], 'an overpayment did not settle everything it could');
    eqS(p.leftover, 2000, 'the surplus is not being reported as credit');
  }

  await reset();
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqS(p.lines.length, 0, 'invoices appeared for a customer who has none');
    eqS(p.leftover, 5000, 'with nothing to pay, the whole amount must become credit');
  }

  await reset();
  {
    const a = await inv({ total: 10000, date: '2026-05-25' });
    await paid(a, 7000);
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqS(Number(p.lines[0].due), 3000, 'the plan used the invoice total instead of its balance');
    eqA(takes(p), [3000], 'a part-paid invoice was overpaid');
    eqS(p.leftover, 2000, 'the surplus over a part-paid invoice went missing');
  }

  // A processed refund puts money back on the invoice — same arithmetic as
  // readInvoiceBalance, which is the point.
  await reset();
  {
    const a = await inv({ total: 10000, date: '2026-05-25' });
    const pid = await paid(a, 10000);
    await pool.query(`INSERT INTO payment_refunds (ledger_payment_id, customer_invoice_id, amount, status)
                      VALUES ($1,$2,4000,'processed')`, [pid, a]);
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 4000, hubId: HUB_A });
    eqS(Number(p.lines[0].due), 4000, 'a refunded amount is not owed again');
  }

  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-01' });
    await paid(a, 4000);
    await inv({ total: 3000, date: '2026-05-02', status: 'cancelled' });
    await inv({ total: 2000, date: '2026-05-03' });
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqS(p.lines.length, 1, 'a settled or cancelled invoice was offered money');
    eqA(takes(p), [2000], 'the live invoice was not the one paid');
  }

  await reset();
  await inv({ total: 4000, date: '2026-05-25', mobile: '9999999999' });
  await inv({ total: 6000, date: '2026-06-02' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqS(p.lines.length, 1, "another customer's invoice entered the plan");
    eqS(Number(p.lines[0].due), 6000, 'the wrong invoice was chosen');
  }

  // ══ Hub scoping ════════════════════════════════════════════════════════════
  //
  // Migration 083 starts a hub's payout clock from when its invoice is paid, so
  // an automatic split that crossed hubs would start one hub's payout with
  // another's cash. The older invoice here belongs to the OTHER hub on purpose:
  // oldest-first must lose to the hub rule.
  await reset();
  await inv({ total: 4000, date: '2026-05-25', hub: HUB_A });
  await inv({ total: 6000, date: '2026-06-02', hub: HUB_B });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_B });
    eqS(p.lines.length, 1, "the automatic split crossed into another hub's invoices");
    eqS(p.lines[0].hub_id, HUB_B, 'the wrong hub was chosen');
    eqS(p.skipped_other_hub.length, 1, 'the skipped invoice was hidden rather than reported');
    eqS(p.skipped_other_hub[0].hub_name, 'Satellite', 'the skipped invoice does not name its hub');
    eqS(Number(p.skipped_other_hub[0].due), 4000, 'the skipped invoice does not carry its balance');
  }

  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25', hub: HUB_A });
    await inv({ total: 6000, date: '2026-06-02', hub: HUB_B });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 4000, hubId: HUB_B, onlyInvoiceIds: [a] });
    eqS(p.lines.length, 1, 'an explicit choice did not narrow the plan');
    eqS(p.lines[0].hub_id, HUB_A, 'a deliberately chosen invoice was refused for being at another hub');
  }

  await reset();
  await inv({ total: 4000, date: '2026-05-25', hub: HUB_A });
  await inv({ total: 6000, date: '2026-06-02', hub: HUB_B });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 10000, hubId: null });
    eqS(p.lines.length, 2, 'a payment with no hub should be scoped to nothing');
    eqS(p.skipped_other_hub.length, 0, 'nothing can be out of scope when there is no scope');
  }

  // ══ Free credit vs a held deposit ══════════════════════════════════════════
  await reset();
  await credit(3000);
  {
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held, b.total], [3000, 0, 3000], 'loose money is not being counted as free credit');
  }

  await reset();
  await deposit(9000);
  {
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held, b.total], [0, 9000, 9000],
      'a deposit on an un-invoiced job is being offered as free credit');
    eqS(b.held_items[0].label, 'GJ01AB1234 · Rajesh', 'the held deposit does not name its job');
  }

  // creditFor is read elsewhere. Its answer must not move.
  await reset();
  await credit(2000); await deposit(9000);
  {
    eqS(await svc.creditFor(pool, MOB), 11000, 'creditFor changed its answer and will break its callers');
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held], [2000, 9000], 'the split does not add back up to creditFor');
  }

  await reset();
  await deposit(9000, { invoiced: true });
  {
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held], [9000, 0], 'a deposit stayed held after its job was invoiced');
  }

  await reset();
  await deposit(9000, { invoiced: true, invoiceStatus: 'cancelled' });
  {
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held], [0, 9000], 'cancelling an invoice quietly released the deposit');
  }

  await reset();
  await credit(3000); await deposit(9000);
  await inv({ total: 20000, date: '2026-06-01' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A, useCredit: true });
    eqS(p.credit_available, 3000, 'the plan offered the wrong amount of free credit');
    eqS(p.credit_held, 9000, 'the plan does not report the held deposit separately');
    eqS(p.pot, 8000, 'the held deposit was spent');
    eqA(takes(p), [8000], 'the pot did not reach the invoice');
  }

  await reset();
  await credit(3000);
  await inv({ total: 20000, date: '2026-06-01' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 5000, hubId: HUB_A });
    eqS(p.pot, 5000, 'credit was spent without being asked for');
    eqS(p.credit_available, 3000, 'available credit is not reported when unused');
  }

  await reset();
  await credit(2000); await deposit(9000);
  {
    const target = await inv({ total: 20000, date: '2026-06-01' });
    const r = await svc.applyCustomerCredit({ mobile: MOB, customerInvoiceId: target, userId: 1 });
    eqS(r.total, 2000, 'applying credit spent more than the free portion');
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held], [0, 9000], "the customer's job deposit was spent on an unrelated invoice");
  }

  await reset();
  await deposit(9000);
  {
    const target = await inv({ total: 20000, date: '2026-06-01' });
    let msg = '';
    try { await svc.applyCustomerCredit({ mobile: MOB, customerInvoiceId: target, userId: 1 }); }
    catch (e) { msg = e.message; }
    okA(/deposit held against a job/.test(msg),
      `refusing to spend a deposit must say why (message: ${msg})`);
    okA(/9000/.test(msg), `the refusal must say how much is held (message: ${msg})`);
  }

  // ══ Against the real production writer ═════════════════════════════════════
  //
  // Everything above builds rows by hand, which proves the SQL but not that
  // production writes rows the SQL classifies correctly. If createAccountCredit
  // ever started stamping an estimate_id, every customer's credit would freeze
  // and only this check would notice.
  await reset();
  {
    const r = await svc.createAccountCredit({ mobile: MOB, amount: 3000, method: 'cash', userId: 1 });
    eqS(r.advance.estimate_id, null, 'account credit is being written with a job attached to it');
    const b = await svc.creditBreakdown(pool, MOB);
    eqA([b.free, b.held], [3000, 0], 'money taken on account is not free credit');
  }

  // The oldest-receipt-first rule this change edits the WHERE clause of.
  await reset();
  {
    const older = await svc.createAccountCredit({ mobile: MOB, amount: 236, method: 'cash', userId: 1 });
    const newer = await svc.createAccountCredit({ mobile: MOB, amount: 590, method: 'cash', userId: 1 });
    await pool.query(`UPDATE customer_invoice_payments SET paid_at = CURRENT_DATE - 5 WHERE id = $1`,
      [older.advance.id]);
    await pool.query(`UPDATE customer_invoice_payments SET paid_at = CURRENT_DATE WHERE id = $1`,
      [newer.advance.id]);
    const target = await inv({ total: 400, date: '2026-06-01' });
    const applied = await svc.applyCustomerCredit({ mobile: MOB, customerInvoiceId: target, userId: 1 });
    eqS(applied.total, 400, 'credit was not capped at what the invoice owes');
    eqS(applied.applied[0].payment_id, older.advance.id,
      'credit was consumed newest-first, leaving a trail of half-spent receipts');
    eqS(applied.applied[0].amount, 236, 'the older receipt was not drained first');
    eqS(applied.applied[1].amount, 164, 'the newer receipt gave the wrong remainder');
  }

  // ══ Overrides ══════════════════════════════════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    await inv({ total: 6000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 5000, hubId: HUB_A, overrides: { [a]: 1000 } });
    eqA(takes(p), [1000, 4000],
      'cutting one invoice by hand stranded the money instead of passing it on');
    eqA(p.lines.map(l => l.pinned), [true, false],
      'the wrong invoices are marked as fixed by hand');
  }

  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    await inv({ total: 6000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 10000, hubId: HUB_A, overrides: { [a]: 99999 } });
    eqA(takes(p), [4000, 6000], 'an override was allowed to overpay an invoice');
  }

  await reset();
  {
    const a = await inv({ total: 8000, date: '2026-05-25' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 1000, hubId: HUB_A, overrides: { [a]: 8000 } });
    eqA(takes(p), [1000], 'an override invented money that was never received');
  }

  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    await inv({ total: 6000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 5000, hubId: HUB_A, overrides: { [a]: 0 } });
    eqA(takes(p), [0, 5000], 'an invoice deliberately set to zero still took money');
  }

  // ══ Paise ══════════════════════════════════════════════════════════════════
  //
  // recalcInvoiceState calls an invoice paid at grand_total - 0.011. Anything
  // looser here and the planner offers money to invoices it thinks are settled.
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    await paid(a, 3999.99);
    await inv({ total: 2000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 2000, hubId: HUB_A });
    eqS(p.lines.length, 1, 'an invoice one paisa short was offered money');
    eqS(Number(p.lines[0].due), 2000, 'the wrong invoice survived the tolerance filter');
  }

  await reset();
  await inv({ total: 1234.56, date: '2026-05-25' });
  await inv({ total: 2000, date: '2026-06-02' });
  {
    const p = await svc.planAllocation(pool, { mobile: MOB, amount: 1500.10, hubId: HUB_A });
    eqA(takes(p), [1234.56, 265.54], 'paise were lost splitting across two invoices');
    const sum = Math.round(p.lines.reduce((s, l) => s + l.take, 0) * 100) / 100;
    eqS(sum, 1500.10, 'the parts do not add back to the whole');
  }



  // ══ Unticking an invoice must not move money to another one ═══════════════
  //
  // The bug this replaces: filtering the unticked invoice out and re-running
  // the split handed its share to the next invoice down. Four invoices meant
  // four clicks and the crumb was still on screen. Here the money an excluded
  // invoice would have taken is consumed anyway, so no row below it moves.
  await reset();
  {
    // The exact shape from the screenshot that reported this.
    const a = await inv({ total: 1994,     date: '2026-08-06' });
    const b = await inv({ total: 2236,     date: '2026-08-10' });
    const c = await inv({ total: 1497,     date: '2026-08-10' });
    const d = await inv({ total: 18896.60, date: '2026-08-10' });

    const before = await svc.planAllocation(pool, { mobile: MOB, amount: 2000, hubId: HUB_A });
    eqA(before.lines.map(l => l.take), [1994, 6, 0, 0],
      'the automatic split no longer puts the crumb on the second invoice'); n++;

    const after = await svc.planAllocation(pool, {
      mobile: MOB, amount: 2000, hubId: HUB_A, excludeInvoiceIds: [b] });
    eqA(after.lines.map(l => l.take), [1994, 0, 0, 0],
      'unticking the crumb invoice moved the money to the next one instead of to credit'); n++;
    eqS(after.leftover, 6, 'the unticked share did not become credit'); n++;
    eqA(after.lines.map(l => l.excluded), [false, true, false, false],
      'the wrong rows are marked as excluded'); n++;
    // The row below is untouched — that is the whole point.
    eqS(after.lines[2].take, 0, 'the invoice below the unticked one changed'); n++;
    eqS(after.lines[2].due, 1497, 'the invoice below the unticked one lost its balance'); n++;
    void c; void d;
  }

  // Unticking the FIRST invoice must not grow the second.
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    await inv({ total: 6000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 5000, hubId: HUB_A, excludeInvoiceIds: [a] });
    eqA(p.lines.map(l => l.take), [0, 1000],
      'unticking the first invoice let the second one take its ₹4,000'); n++;
    eqS(p.leftover, 4000, 'the unticked ₹4,000 did not become credit'); n++;
  }

  // Unticking everything is the same as keeping it all as credit.
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const b = await inv({ total: 6000, date: '2026-06-02' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 5000, hubId: HUB_A, excludeInvoiceIds: [a, b] });
    eqA(p.lines.map(l => l.take), [0, 0], 'an excluded invoice still took money'); n++;
    eqS(p.leftover, 5000, 'with everything unticked it must all become credit'); n++;
  }

  // An id that is not in the plan is ignored rather than throwing.
  await reset();
  {
    await inv({ total: 4000, date: '2026-05-25' });
    const p = await svc.planAllocation(pool, {
      mobile: MOB, amount: 4000, hubId: HUB_A, excludeInvoiceIds: [999999] });
    eqA(p.lines.map(l => l.take), [4000], 'an unknown exclusion changed the plan'); n++;
  }

  // ── The fixture must not disagree with production ─────────────────────────
  //
  // Every check below passed while planAllocation selected h.name, because the
  // stub hubs table above had been hand-written with a column of that name.
  // The query was wrong, the fixture agreed with it, and the 500 appeared only
  // on a real database.
  //
  // So the table aliases in the planner's OWN queries are read out of the
  // service source and confirmed against this database. Scoped to those two
  // functions deliberately: a scan of the whole 88KB file reports every alias
  // in it, including JS property accesses that merely look like columns, and a
  // guard that cries wolf is a guard that gets deleted.
  {
    const src = require('fs').readFileSync(
      path.join(BE, 'src/services/advances.service.js'), 'utf8');
    const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
    // Comments stripped first, both kinds. The first run of this guard failed
    // on h.name — inside the comment explaining that h.name was the bug.
    const strip = s => s.replace(/--[^\n]*/g, '').replace(/\/\/[^\n]*/g, '')
                        .replace(/\/\*[\s\S]*?\*\//g, '');
    const sql = strip(slice('async function creditBreakdown', 'async function planAllocation'))
              + strip(slice('const inv = await db.query', 'const open = inv.rows'));
    const TABLE = { ci: 'customer_invoices', h: 'hubs', e: 'estimates',
                    p: 'customer_invoice_payments' };
    const missing = [];
    for (const [alias, table] of Object.entries(TABLE)) {
      const have = new Set((await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table])).rows.map(x => x.column_name));
      for (const m of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)\\b`, 'g'))) {
        if (!have.has(m[1])) missing.push(`${alias}.${m[1]} (${table})`);
      }
    }
    assert.deepStrictEqual([...new Set(missing)], [],
      'the planner selects columns this database does not have'); n++;
  }

  await pool.end();
  console.log(`planalloc (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
