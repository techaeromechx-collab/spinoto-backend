/**
 * receivePayment — one payment in, wherever it belongs. Against a REAL PostgreSQL.
 *
 * ── What is actually at risk here ───────────────────────────────────────────
 *
 * This endpoint writes money. The failure that matters is not an exception, it
 * is a wrong number that looks right: an invoice settled that should not be, a
 * surplus that vanishes instead of becoming credit, or two advisors between
 * them putting ₹10,000 onto a ₹6,000 invoice because each read the balance
 * before the other wrote.
 *
 * So the assertions below check the LEDGER after the fact — payment rows,
 * allocation rows, invoice balances — rather than the object the function
 * returned. A function can report whatever it likes about what it did.
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
const DBNAME = 'spinoto_receive_test';
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
  id SERIAL PRIMARY KEY, appointment_id INTEGER, hub_id INTEGER NOT NULL REFERENCES hubs(id),
  status VARCHAR(50) NOT NULL DEFAULT 'draft', grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_name VARCHAR(160), mobile VARCHAR(20), vehicle_number VARCHAR(30),
  estimate_date DATE NOT NULL DEFAULT CURRENT_DATE);
CREATE TABLE customer_invoices (
  id SERIAL PRIMARY KEY, estimate_id INTEGER REFERENCES estimates(id), appointment_id INTEGER,
  hub_id INTEGER REFERENCES hubs(id), customer_name VARCHAR(160), mobile VARCHAR(20),
  vehicle_number VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated','approved','partially_paid','paid','cancelled')),
  grand_total NUMERIC(12,2) NOT NULL DEFAULT 0, amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE, public_token VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ci_estimate_id UNIQUE (estimate_id));
CREATE TABLE customer_invoice_payments (
  id SERIAL PRIMARY KEY,
  customer_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method VARCHAR(30) NOT NULL DEFAULT 'cash',
  reference_no VARCHAR(100), paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), notes TEXT,
  created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payment_transaction_id INTEGER, source VARCHAR(20) NOT NULL DEFAULT 'manual',
  hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  payment_type VARCHAR(20) NOT NULL DEFAULT 'invoice' CHECK (payment_type IN ('invoice','advance')),
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL, appointment_id INTEGER,
  booking_id INTEGER, mobile VARCHAR(20), vehicle_number VARCHAR(30),
  voucher_no VARCHAR(30), voucher_fy VARCHAR(9), voucher_seq INTEGER,
  public_token VARCHAR(20), gst_amount NUMERIC(12,2), gst_rate NUMERIC(5,2));
CREATE TABLE payment_allocations (
  id SERIAL PRIMARY KEY,
  ledger_payment_id INTEGER NOT NULL REFERENCES customer_invoice_payments(id) ON DELETE CASCADE,
  customer_invoice_id INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE payment_refunds (
  id SERIAL PRIMARY KEY, payment_transaction_id INTEGER,
  ledger_payment_id INTEGER REFERENCES customer_invoice_payments(id) ON DELETE SET NULL,
  customer_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE SET NULL,
  hub_id INTEGER, amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE OR REPLACE VIEW invoice_payment_lines AS
SELECT a.id AS allocation_id, a.customer_invoice_id, a.amount, a.created_at AS allocated_at,
       cip.id AS payment_id, cip.amount AS payment_amount, cip.method, cip.reference_no,
       cip.paid_at, cip.notes, cip.created_by, cip.source, cip.hub_id,
       cip.payment_transaction_id, cip.payment_type, cip.voucher_no, cip.estimate_id
  FROM payment_allocations a JOIN customer_invoice_payments cip ON cip.id = a.ledger_payment_id;
CREATE TABLE advance_voucher_sequences (
  id SERIAL PRIMARY KEY, hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  fy VARCHAR(9) NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), doc_kind VARCHAR(10) NOT NULL DEFAULT 'receipt');
CREATE UNIQUE INDEX uq_avs ON advance_voucher_sequences (fy, doc_kind, COALESCE(hub_id, -1));
CREATE TABLE company_settings (id INTEGER PRIMARY KEY, advance_default_gst_rate NUMERIC(5,2));
INSERT INTO company_settings (id, advance_default_gst_rate) VALUES (1, 18);
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('receive (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

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
  const inv = async ({ total, date, hub = HUB_A, status = 'generated' }) => (await pool.query(
    `INSERT INTO customer_invoices (mobile, hub_id, grand_total, invoice_date, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [MOB, hub, total, date, status])).rows[0].id;

  /** What the ledger says an invoice has actually received. */
  const allocatedTo = async id => Number((await pool.query(
    `SELECT COALESCE(SUM(amount),0) t FROM payment_allocations WHERE customer_invoice_id = $1`,
    [id])).rows[0].t);
  const statusOf = async id => (await pool.query(
    `SELECT status FROM customer_invoices WHERE id = $1`, [id])).rows[0].status;
  const paymentCount = async () => Number((await pool.query(
    `SELECT COUNT(*) c FROM customer_invoice_payments`)).rows[0].c);

  const eqS = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
  const eqA = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
  const okA = (c, m) => { assert.ok(c, m); n++; };

  // ══ The ordinary path ══════════════════════════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const b = await inv({ total: 6000, date: '2026-06-02' });
    const out = await svc.receivePayment({ mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1 });

    eqS(await allocatedTo(a), 4000, 'the older invoice was not filled first');
    eqS(await allocatedTo(b), 1000, 'the remainder did not reach the second invoice');
    eqS(await statusOf(a), 'paid', 'a fully covered invoice was not marked paid');
    eqS(await statusOf(b), 'partially_paid', 'a part-covered invoice is not partially_paid');
    eqS(out.leftover, 0, 'money was reported as left over that had somewhere to go');

    // ONE payment row, two allocations. This is the shape the whole feature
    // rests on — a split payment must not become two receipts.
    eqS(await paymentCount(), 1, 'a split payment wrote more than one receipt');
    const allocs = Number((await pool.query(`SELECT COUNT(*) c FROM payment_allocations`)).rows[0].c);
    eqS(allocs, 2, 'the split did not produce one allocation per invoice');
    // NO receipt number, and that is the point. The ADV- series means "money
    // received before a tax invoice covers it". This payment landed entirely
    // on invoices that carry their own GST, so numbering it into that series
    // would change what the series means to an accountant — and asking for the
    // account-credit GST rate, which accountCreditRate REFUSES to guess, would
    // have made every ordinary invoice payment fail on any installation where
    // nobody has set it.
    eqS(out.payment.voucher_no, null,
      'a fully-allocated payment was numbered into the advance receipt series');
    eqS(out.payment.gst_rate, null,
      'a fully-allocated payment carries a GST figure that belongs to the invoice');
  }

  // ══ Surplus becomes credit, on the same row ════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const out = await svc.receivePayment({ mobile: MOB, amount: 10000, hubId: HUB_A, userId: 1 });
    eqS(await allocatedTo(a), 4000, 'the invoice was overpaid');
    eqS(out.leftover, 6000, 'the surplus was not reported as credit');
    eqS(await paymentCount(), 1, 'the surplus was split onto a second receipt');
    // Some of it IS becoming credit, so this one does need a receipt — and the
    // GST on it is worked out from the leftover, not from the whole payment:
    // the ₹4,000 that settled an invoice already has its tax on that invoice.
    okA(/^ADV-/.test(out.payment.voucher_no || ''),
      `money kept as credit must carry a receipt number (got ${out.payment.voucher_no})`);
    eqS(out.payment.gst_amount, Math.round((6000 * 18 / 118) * 100) / 100,
      'the GST was taken on the whole payment rather than on the part kept as credit');
    const b = await svc.creditBreakdown(pool, MOB);
    eqS(b.free, 6000, 'the surplus is not showing as spendable credit');
  }

  // ══ Nothing outstanding — this is what "Take Payment" becomes ═════════════
  await reset();
  {
    const out = await svc.receivePayment({ mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1 });
    eqS(out.allocations.length, 0, 'money was allocated to an invoice that does not exist');
    eqS(out.leftover, 5000, 'with nothing to pay it must all become credit');
    const b = await svc.creditBreakdown(pool, MOB);
    eqS(b.free, 5000, 'the money did not land as credit');
  }

  // An EMPTY allocations array is an instruction, not an absence: keep it all
  // as credit even though invoices are open. null would mean the opposite.
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const out = await svc.receivePayment({
      mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1, allocations: [] });
    eqS(await allocatedTo(a), 0, 'an explicit "allocate to nothing" still paid an invoice');
    eqS(out.leftover, 5000, 'the whole amount should have become credit');
  }

  // ══ Hub boundary ═══════════════════════════════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25', hub: HUB_A });
    const b = await inv({ total: 6000, date: '2026-06-02', hub: HUB_B });
    await svc.receivePayment({ mobile: MOB, amount: 5000, hubId: HUB_B, userId: 1 });
    eqS(await allocatedTo(a), 0, "cash taken at one hub settled another hub's invoice");
    eqS(await allocatedTo(b), 5000, 'the money did not reach its own hub');
  }

  // ══ Existing credit is spent first, and only the free part ════════════════
  await reset();
  {
    await svc.createAccountCredit({ mobile: MOB, amount: 3000, method: 'cash', userId: 1 });
    const a = await inv({ total: 20000, date: '2026-06-01' });
    const out = await svc.receivePayment({
      mobile: MOB, amount: 5000, hubId: HUB_A, useCredit: true, userId: 1 });
    eqS(await allocatedTo(a), 8000, 'credit plus cash did not both reach the invoice');
    eqS(out.credit_used, 3000, 'the credit that was spent is not reported');
    const b = await svc.creditBreakdown(pool, MOB);
    eqS(b.free, 0, 'the credit was not consumed');
  }

  await reset();
  {
    // A deposit against an un-invoiced job must survive useCredit untouched.
    const eid = (await pool.query(
      `INSERT INTO estimates (hub_id, grand_total, mobile, vehicle_number)
       VALUES ($1, 20000, $2, 'GJ01AB1234') RETURNING id`, [HUB_A, MOB])).rows[0].id;
    await pool.query(
      `INSERT INTO customer_invoice_payments (amount, mobile, payment_type, estimate_id, voucher_no)
       VALUES (9000, $1, 'advance', $2, 'ADV-9')`, [MOB, eid]);
    const a = await inv({ total: 20000, date: '2026-06-01' });
    const out = await svc.receivePayment({
      mobile: MOB, amount: 5000, hubId: HUB_A, useCredit: true, userId: 1 });
    eqS(out.credit_used, 0, "a job deposit was spent as though it were free credit");
    eqS(await allocatedTo(a), 5000, 'only the new money should have reached the invoice');
    const b = await svc.creditBreakdown(pool, MOB);
    eqS(b.held, 9000, 'the deposit was consumed');
  }

  // ══ An explicit override ═══════════════════════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const b = await inv({ total: 6000, date: '2026-06-02' });
    await svc.receivePayment({
      mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1,
      allocations: [{ customer_invoice_id: b, amount: 5000 }] });
    eqS(await allocatedTo(a), 0, 'an override did not stop the automatic split');
    eqS(await allocatedTo(b), 5000, 'the deliberately chosen invoice was not paid');
  }

  // An override that no longer fits must FAIL, not quietly shrink — and must
  // leave nothing behind. This is the stale-preview case, made real.
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    // Somebody else settles it in the seconds before Save.
    const other = (await pool.query(
      `INSERT INTO customer_invoice_payments (customer_invoice_id, amount, mobile, payment_type)
       VALUES ($1, 3500, $2, 'invoice') RETURNING id`, [a, MOB])).rows[0].id;
    await pool.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
                      VALUES ($1,$2,3500)`, [other, a]);

    const before = await paymentCount();
    let msg = '';
    try {
      await svc.receivePayment({
        mobile: MOB, amount: 4000, hubId: HUB_A, userId: 1,
        allocations: [{ customer_invoice_id: a, amount: 4000 }] });
    } catch (e) { msg = e.message; }

    okA(/only has ₹500 outstanding/.test(msg),
      `a stale override must say what changed (message: ${msg})`);
    okA(/Nothing has been saved/.test(msg),
      `a stale override must say nothing was written (message: ${msg})`);
    eqS(await paymentCount(), before, 'a failed override still wrote a payment row');
    eqS(await allocatedTo(a), 3500, 'a failed override changed the invoice anyway');
  }

  // ══ Two advisors at once ═══════════════════════════════════════════════════
  //
  // The invoices are locked before the plan is made, so the second request
  // plans against what the first left. Proven by the ledger, not by reading the
  // SQL: a ₹6,000 invoice must never receive ₹10,000 between them.
  await reset();
  {
    const a = await inv({ total: 6000, date: '2026-05-25' });
    const results = await Promise.allSettled([
      svc.receivePayment({ mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1 }),
      svc.receivePayment({ mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1 }),
    ]);
    eqS(results.filter(r => r.status === 'fulfilled').length, 2,
      'a concurrent payment failed outright instead of taking what was left');
    eqS(await allocatedTo(a), 6000, 'concurrent payments overfilled the invoice');
    eqS(await statusOf(a), 'paid', 'the invoice did not settle');
    eqS(await paymentCount(), 2, 'both payments must be recorded even though one overflowed');
    const b = await svc.creditBreakdown(pool, MOB);
    eqS(b.free, 4000, 'the overflow did not become credit');
  }


  // ══ Unticking, end to end, against the ledger ══════════════════════════════
  //
  // The screenshot's exact numbers. The ₹6 must reach credit, and the invoice
  // BELOW the unticked one must be untouched — not merely un-allocated in the
  // plan, but with no allocation row against it at all.
  await reset();
  {
    const a = await inv({ total: 1994,     date: '2026-08-06' });
    const b = await inv({ total: 2236,     date: '2026-08-10' });
    const c = await inv({ total: 1497,     date: '2026-08-10' });
    const d = await inv({ total: 18896.60, date: '2026-08-10' });

    const out = await svc.receivePayment({
      mobile: MOB, amount: 2000, hubId: HUB_A, userId: 1, excludeInvoiceIds: [b] });

    eqS(await allocatedTo(a), 1994, 'the first invoice was not settled'); n++;
    eqS(await allocatedTo(b), 0, 'the unticked invoice was paid anyway'); n++;
    eqS(await allocatedTo(c), 0, 'the money hopped to the invoice below the unticked one'); n++;
    eqS(await allocatedTo(d), 0, 'the money hopped further down the list'); n++;
    eqS(await statusOf(a), 'paid', 'the settled invoice is not marked paid'); n++;
    eqS(await statusOf(c), 'generated', 'an untouched invoice had its status changed'); n++;
    eqS(out.leftover, 6, 'the unticked share did not become credit'); n++;
    const cr = await svc.creditBreakdown(pool, MOB);
    eqS(cr.free, 6, 'the ₹6 is not showing as spendable credit'); n++;
  }

  // Unticking everything is the same as choosing "keep as credit".
  await reset();
  {
    const a = await inv({ total: 4000, date: '2026-05-25' });
    const b = await inv({ total: 6000, date: '2026-06-02' });
    const out = await svc.receivePayment({
      mobile: MOB, amount: 5000, hubId: HUB_A, userId: 1, excludeInvoiceIds: [a, b] });
    eqS(await allocatedTo(a), 0, 'an unticked invoice received money'); n++;
    eqS(await allocatedTo(b), 0, 'an unticked invoice received money'); n++;
    eqS(out.leftover, 5000, 'the whole amount should have become credit'); n++;
    okA(/^ADV-/.test(out.payment.voucher_no || ''),
      'money kept as credit must carry a receipt number'); n++;
  }

  // Credit spent alongside a payment must respect the ticks too.
  await reset();
  {
    await svc.createAccountCredit({ mobile: MOB, amount: 3000, method: 'cash', userId: 1 });
    const a = await inv({ total: 1000, date: '2026-05-25' });
    const b = await inv({ total: 9000, date: '2026-06-02' });
    await svc.receivePayment({
      mobile: MOB, amount: 2000, hubId: HUB_A, userId: 1,
      useCredit: true, excludeInvoiceIds: [b] });
    eqS(await allocatedTo(a), 1000, 'the ticked invoice was not settled'); n++;
    eqS(await allocatedTo(b), 0, 'existing credit was spent on an unticked invoice'); n++;
    const cr = await svc.creditBreakdown(pool, MOB);
    eqS(cr.free, 4000, 'the unspent credit and the surplus do not add up'); n++;
  }

  // ══ Rejections ═════════════════════════════════════════════════════════════
  await reset();
  {
    let m1 = '';
    try { await svc.receivePayment({ mobile: MOB, amount: 0, userId: 1 }); }
    catch (e) { m1 = e.message; }
    okA(/more than zero/.test(m1), `a zero payment must be refused (message: ${m1})`);

    let m2 = '';
    try { await svc.receivePayment({ mobile: '', amount: 100, userId: 1 }); }
    catch (e) { m2 = e.message; }
    okA(/customer is needed/.test(m2), `a payment with no customer must be refused (message: ${m2})`);

    let m3 = '';
    try { await svc.receivePayment({ mobile: MOB, amount: 100, method: 'crypto', userId: 1 }); }
    catch (e) { m3 = e.message; }
    okA(/Unknown payment method/.test(m3), `an unknown method must be refused (message: ${m3})`);

    eqS(await paymentCount(), 0, 'a refused payment still wrote a row');
  }

  // ══ Paise ══════════════════════════════════════════════════════════════════
  await reset();
  {
    const a = await inv({ total: 1234.56, date: '2026-05-25' });
    const b = await inv({ total: 2000, date: '2026-06-02' });
    const out = await svc.receivePayment({ mobile: MOB, amount: 1500.10, hubId: HUB_A, userId: 1 });
    eqS(await allocatedTo(a), 1234.56, 'paise were lost on the first invoice');
    eqS(await allocatedTo(b), 265.54, 'the remainder carried the wrong paise');
    eqS(await statusOf(a), 'paid', 'an exactly-covered invoice with paise did not settle');
    eqS(out.leftover, 0, 'paise leaked into the leftover');
  }

  await pool.end();
  console.log(`receive (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
