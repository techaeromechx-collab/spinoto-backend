/**
 * The invoice screen's payment list, run against a REAL PostgreSQL.
 *
 * This is the query that took the invoice page down:
 *
 *     error: column cip.id does not exist
 *
 * It was switched to invoice_payment_lines in one word — the table name — and
 * the view has no `id`. Every suite passed. Source assertions read the text and
 * the text was fine; the postgres suites built their own schemas and never ran
 * this particular SQL. The only thing that could have caught it is asking a
 * database to parse it, which is what this does.
 *
 * It runs the ACTUAL query, lifted out of the controller rather than retyped, so
 * a future edit to that query is checked here instead of a copy of it.
 *
 * It also pins the two facts the screen depends on:
 *
 *   • `id` is the LEDGER payment id — the edit and delete handlers take that id,
 *     and an allocation id would address the wrong row (or nothing at all);
 *   • `amount` is what landed on THIS invoice, not the whole payment, so a
 *     ₹2,000 advance applied ₹1,500 here shows 1500 and leaves 500 as credit.
 *
 * Skips cleanly when no scratch server is running. Start one with:
 *   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgd -o '-p 5433 -k /tmp' start"
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BE = path.resolve(__dirname, '..');
const DBNAME = 'spinoto_invpay_test';
const CONN = { host: '/tmp', port: 5433, user: 'postgres', connectionTimeoutMillis: 1500 };
let n = 0;

// The query under test, taken from the controller — not a copy of it.
const ctrl = fs.readFileSync(path.join(BE, 'src/controllers/customer_invoices.controller.js'), 'utf8');
const body = ctrl.slice(ctrl.indexOf('async function _getPayments'));
const qStart = body.indexOf('`SELECT') + 1;
const GET_PAYMENTS = body.slice(qStart, body.indexOf('`', qStart));
assert.ok(/FROM invoice_payment_lines/.test(GET_PAYMENTS),
  'could not lift _getPayments out of the controller'); n++;

(async () => {
  const admin = new Client({ ...CONN, database: 'postgres' });
  try { await admin.connect(); } catch {
    console.log('invoice payment list (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const c = new Client({ ...CONN, database: DBNAME });
  await c.connect();

  // Enough schema for the view and this query. Column types match the real
  // migrations where they matter — NUMERIC(12,2) is what makes the paise
  // assertions below mean anything.
  await c.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE hubs (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE estimates (id SERIAL PRIMARY KEY);
    CREATE TABLE appointments (id SERIAL PRIMARY KEY);
    CREATE TABLE customer_invoices (
      id SERIAL PRIMARY KEY, grand_total NUMERIC(12,2), amount_paid NUMERIC(12,2) DEFAULT 0,
      status VARCHAR(30) DEFAULT 'generated',
      -- migration 135 backfills the advance columns from these
      mobile VARCHAR(15), vehicle_number VARCHAR(30),
      appointment_id INT REFERENCES appointments(id),
      estimate_id INT REFERENCES estimates(id));
    CREATE TABLE payment_transactions (
      id SERIAL PRIMARY KEY, txn_ref VARCHAR(60), entity_type VARCHAR(20), entity_id INT);
    CREATE TABLE customer_invoice_payments (
      id SERIAL PRIMARY KEY,
      customer_invoice_id INT REFERENCES customer_invoices(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      method VARCHAR(30), reference_no VARCHAR(80), notes TEXT,
      paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
      created_by INT REFERENCES users(id),
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      hub_id INT REFERENCES hubs(id),
      payment_transaction_id INT REFERENCES payment_transactions(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);

  const apply = f => c.query(fs.readFileSync(path.join(BE, 'db/migrations', f), 'utf8'));
  await apply('133_payment_allocations.sql');
  await apply('134_invoice_payment_lines.sql');
  // 135 adds payment_type / voucher_no / estimate_id; 138 puts them on the view.
  await apply('135_advance_payments.sql');
  await apply('138_invoice_payment_lines_advance.sql');

  // ── A settled invoice: one ordinary payment and one part-applied advance ───
  await c.query(`INSERT INTO users (id, name) VALUES (7, 'Ravi')`);
  await c.query(`INSERT INTO estimates (id) VALUES (11)`);
  await c.query(`INSERT INTO customer_invoices (id, grand_total) VALUES (41, 5000.00)`);
  await c.query(`INSERT INTO payment_transactions (id, txn_ref) VALUES (3, 'pay_ABC123')`);

  // 1 — an ordinary manual payment, recorded against the invoice.
  await c.query(`INSERT INTO customer_invoice_payments
    (id, customer_invoice_id, amount, method, reference_no, paid_at, created_by, source, payment_type)
    VALUES (101, 41, 1500.00, 'cash', 'RCPT-9', '2026-08-02', 7, 'manual', 'invoice')`);
  await c.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
    VALUES (101, 41, 1500.00)`);

  // 2 — an online payment.
  await c.query(`INSERT INTO customer_invoice_payments
    (id, customer_invoice_id, amount, method, paid_at, source, payment_transaction_id, payment_type)
    VALUES (102, 41, 1000.00, 'upi', '2026-08-03', 'gateway', 3, 'invoice')`);
  await c.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
    VALUES (102, 41, 1000.00)`);

  // 3 — an advance of 2000 taken against the estimate, 1500.50 applied here.
  //     customer_invoice_id is NULL: there was no invoice when the money came in.
  await c.query(`INSERT INTO customer_invoice_payments
    (id, customer_invoice_id, amount, method, paid_at, source, payment_type,
     estimate_id, mobile, voucher_no, gst_amount)
    VALUES (103, NULL, 2000.00, 'cash', '2026-08-01', 'manual', 'advance',
            11, '9876543210', 'ADV-2026-27-000004', 305.08)`);
  await c.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
    VALUES (103, 41, 1500.50)`);

  // ── The query the controller actually runs ────────────────────────────────
  const r = await c.query(GET_PAYMENTS, [41]);
  assert.strictEqual(r.rows.length, 3, 'the invoice screen does not list all three lines'); n++;

  const by = id => r.rows.find(x => Number(x.id) === id);

  // `id` is the LEDGER payment id. If it were the allocation id, the delete
  // button would address a row that is not the payment — or no row at all.
  assert.ok(by(101) && by(102) && by(103),
    'the rows are not keyed by the ledger payment id — edit and delete would miss'); n++;

  // Oldest first: the advance came in before either payment.
  assert.strictEqual(Number(r.rows[0].id), 103, 'the list is not in payment order'); n++;

  // The ordinary payment.
  assert.strictEqual(Number(by(101).amount), 1500, 'the manual payment amount is wrong'); n++;
  assert.strictEqual(by(101).created_by_name, 'Ravi', 'who recorded it is not resolved'); n++;
  assert.strictEqual(by(101).payment_type, 'invoice', 'an ordinary payment is not typed as one'); n++;
  assert.strictEqual(by(101).voucher_no, null, 'an ordinary payment carries a receipt series number'); n++;

  // The online one keeps its gateway reference, which is what the screen shows
  // in place of a delete button.
  assert.strictEqual(by(102).txn_ref, 'pay_ABC123', 'the gateway reference is not joined'); n++;
  assert.strictEqual(by(102).source, 'gateway', 'the online payment is not marked online'); n++;

  // The advance: APPLIED here, not the whole payment.
  const adv = by(103);
  assert.strictEqual(Number(adv.amount), 1500.50,
    'the invoice shows the whole advance rather than the part applied to it'); n++;
  assert.strictEqual(Number(adv.payment_amount), 2000,
    'the screen cannot tell how much of the advance is still credit'); n++;
  assert.strictEqual(adv.payment_type, 'advance', 'the advance is listed as an ordinary payment'); n++;
  assert.strictEqual(adv.voucher_no, 'ADV-2026-27-000004',
    'the advance receipt number — the document the customer holds — is not shown'); n++;

  // The three lines add up to what the invoice has been paid.
  const paid = r.rows.reduce((s, x) => s + Number(x.amount), 0);
  assert.ok(Math.abs(paid - 4000.50) < 0.001,
    `the listed lines do not sum to what the invoice has been paid (got ${paid})`); n++;

  // ── The edit and delete handlers cannot touch the advance ─────────────────
  // Both match on `id AND customer_invoice_id`, and the advance's is NULL. This
  // is why the screen must render it as locked: the buttons would 404.
  const reach = await c.query(
    `SELECT id FROM customer_invoice_payments WHERE id = $1 AND customer_invoice_id = $2`,
    [103, 41]);
  assert.strictEqual(reach.rows.length, 0,
    'an applied advance is reachable by the invoice-scoped delete — deleting it would remove money the customer paid'); n++;
  const reachOrdinary = await c.query(
    `SELECT id FROM customer_invoice_payments WHERE id = $1 AND customer_invoice_id = $2`,
    [101, 41]);
  assert.strictEqual(reachOrdinary.rows.length, 1,
    'an ordinary payment is no longer reachable by the invoice-scoped delete'); n++;

  // ── The view has no `id`, and this is the proof ───────────────────────────
  let failed = false;
  try { await c.query(`SELECT id FROM invoice_payment_lines LIMIT 1`); }
  catch (e) { failed = e.code === '42703'; }
  assert.ok(failed,
    'invoice_payment_lines now answers to `id` — which of the two rows is it?'); n++;

  await c.end();
  console.log(`invoice payment list (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
