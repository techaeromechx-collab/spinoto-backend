/**
 * Phase 1 — the allocation layer, against a REAL PostgreSQL.
 *
 * This phase changes how every invoice's paid amount is calculated. That
 * number drives the invoice status, the hub payout date, when an appointment
 * closes and when a warranty starts. Getting it wrong does not raise an error;
 * it shows wrong money.
 *
 * So the assertion that matters is not "does the new code work" but "does the
 * new code produce EXACTLY what the old code produced". This suite builds a
 * dataset of the shapes that actually break — several payments on one invoice,
 * a partial payment, a processed refund alongside a pending one, gateway and
 * manual money on the same invoice, an invoice with nothing paid, and amounts
 * with paise — then computes the old rule independently in SQL and compares.
 *
 * Skips cleanly when no scratch server is running.
 *
 *   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgd \
 *                   -o '-p 5433 -k /tmp' start"
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BE = path.resolve(__dirname, '..');
const MIG = path.join(BE, 'db', 'migrations');
let n = 0;

const DB = { host: '/tmp', port: 5433, user: 'postgres', database: 'spinoto_alloc_test',
             connectionTimeoutMillis: 1500 };

(async () => {
  // ── Can we run at all? ────────────────────────────────────────────────────
  const admin = new Pool({ ...DB, database: 'postgres' });
  try {
    await admin.query('SELECT 1');
  } catch {
    console.log('allocations (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DB.database}`);
  await admin.query(`CREATE DATABASE ${DB.database}`);
  await admin.end();

  const pool = new Pool(DB);

  // ── Schema: only what the balance calculation touches ─────────────────────
  await pool.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE areas (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE hubs  (id SERIAL PRIMARY KEY, area_id INT REFERENCES areas(id));
    CREATE TABLE customer_invoices (
      id SERIAL PRIMARY KEY, public_token VARCHAR(20), status VARCHAR(30) DEFAULT 'approved',
      hub_id INT REFERENCES hubs(id), purchase_invoice_id INT, estimate_id INT, appointment_id INT,
      grand_total NUMERIC(12,2) DEFAULT 0, amount_paid NUMERIC(12,2) DEFAULT 0,
      customer_name VARCHAR(120), mobile VARCHAR(20), vehicle_number VARCHAR(30),
      updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payment_transactions (
      id SERIAL PRIMARY KEY, txn_ref VARCHAR(40) UNIQUE, hub_id INT, amount NUMERIC(12,2),
      status VARCHAR(20), entity_type VARCHAR(30), entity_id INT, created_by INT);
    CREATE TABLE customer_invoice_payments (
      id SERIAL PRIMARY KEY,
      customer_invoice_id INT NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      method VARCHAR(30) NOT NULL DEFAULT 'cash',
      reference_no VARCHAR(100), paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), notes TEXT,
      created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(),
      payment_transaction_id INT REFERENCES payment_transactions(id),
      source VARCHAR(20) NOT NULL DEFAULT 'manual', hub_id INT REFERENCES hubs(id));
    CREATE TABLE payment_refunds (
      id SERIAL PRIMARY KEY, payment_transaction_id INT, ledger_payment_id INT,
      customer_invoice_id INT, hub_id INT, amount NUMERIC(12,2), status VARCHAR(20));
    -- readInvoiceBalance LEFT JOINs appointments for the customer fallback.
    -- Empty is enough: the join must resolve, not return anything.
    CREATE TABLE appointments (
      id SERIAL PRIMARY KEY, customer_name VARCHAR(120),
      mobile VARCHAR(20), vehicle_number VARCHAR(30));
  `);

  // ── The dataset: the shapes that break ────────────────────────────────────
  await pool.query(`
    INSERT INTO users (name) VALUES ('Advisor');
    INSERT INTO areas (name) VALUES ('Gota'),('Bopal');
    INSERT INTO hubs (area_id) VALUES (1),(2);
    INSERT INTO customer_invoices (id, grand_total, status, hub_id) VALUES
      (1, 10000.00, 'approved', 1),   -- three payments, gateway + manual
      (2,  3333.33, 'approved', 2),   -- paise
      (3,  4000.00, 'approved', 1),   -- processed refund AND a pending one
      (4,  7500.00, 'approved', 2),   -- nothing paid
      (5,  2000.00, 'approved', 1),   -- exact settlement
      (6,  1000.00, 'generated', 1),  -- unapproved, nothing paid
      (7,  5000.00, 'approved', 2);   -- one paisa short of paid
    SELECT setval('customer_invoices_id_seq', 100);

    INSERT INTO payment_transactions (id, txn_ref, amount, status, entity_type, entity_id, hub_id, created_by)
      VALUES (1,'PYA',4000,'captured','customer_invoice',1,1,1),
             (2,'PYB',4000,'captured','customer_invoice',3,1,1);
    SELECT setval('payment_transactions_id_seq', 100);

    INSERT INTO customer_invoice_payments
      (id, customer_invoice_id, amount, method, paid_at, created_by, payment_transaction_id, source, hub_id) VALUES
      (1, 1, 4000.00,   'upi',           NOW()-INTERVAL '5 day', 1, 1,    'gateway', 1),
      (2, 1, 3000.00,   'cash',          NOW()-INTERVAL '3 day', 1, NULL, 'manual',  1),
      (3, 1, 1500.00,   'bank_transfer', NOW()-INTERVAL '1 day', 1, NULL, 'manual',  1),
      (4, 2, 1111.11,   'cash',          NOW()-INTERVAL '2 day', 1, NULL, 'manual',  2),
      (5, 3, 4000.00,   'card',          NOW()-INTERVAL '4 day', 1, 2,    'gateway', 1),
      (6, 5, 2000.00,   'upi',           NOW()-INTERVAL '1 day', 1, NULL, 'manual',  1),
      (7, 7, 4999.99,   'cash',          NOW()-INTERVAL '1 day', 1, NULL, 'manual',  2);
    SELECT setval('customer_invoice_payments_id_seq', 100);

    -- A processed refund reduces the balance; a pending one must not.
    INSERT INTO payment_refunds (payment_transaction_id, ledger_payment_id, customer_invoice_id, hub_id, amount, status)
      VALUES (2, 5, 3, 1, 1500.00, 'processed'),
             (2, 5, 3, 1,  500.00, 'pending');
  `);

  // ── BEFORE: the old rule, written independently ───────────────────────────
  // Not the old code — an independent statement of the same rule. Comparing
  // code against itself proves only that it is deterministic.
  await pool.query(`
    CREATE TABLE _before AS
    WITH calc AS (
      SELECT ci.id, ci.grand_total, ci.status AS current_status,
             (SELECT COALESCE(SUM(p.amount),0) FROM customer_invoice_payments p
               WHERE p.customer_invoice_id = ci.id) AS gross,
             (SELECT COALESCE(SUM(rf.amount),0) FROM payment_refunds rf
               WHERE rf.customer_invoice_id = ci.id AND rf.status='processed') AS refunded
        FROM customer_invoices ci)
    SELECT id,
           ROUND(gross - refunded, 2) AS amount_paid,
           CASE WHEN (gross - refunded) >= grand_total - 0.011 AND grand_total > 0 THEN 'paid'
                WHEN (gross - refunded) > 0 THEN 'partially_paid'
                WHEN current_status = 'approved' THEN 'approved'
                ELSE 'generated' END AS status,
           ROUND(grand_total - (gross - refunded), 2) AS balance
      FROM calc`);

  // ── Apply the real migrations ─────────────────────────────────────────────
  for (const f of ['133_payment_allocations.sql', '134_invoice_payment_lines.sql']) {
    await pool.query(fs.readFileSync(path.join(MIG, f), 'utf8'));
  }
  n++;   // both migrations applied without error

  // The backfill must have covered every payment, at its full amount.
  const bf = await pool.query(`
    SELECT (SELECT count(*) FROM customer_invoice_payments) AS payments,
           (SELECT count(*) FROM payment_allocations)       AS allocs,
           (SELECT count(*) FROM customer_invoice_payments p
             WHERE NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.ledger_payment_id = p.id)) AS orphans,
           (SELECT count(*) FROM payment_allocations a
              JOIN customer_invoice_payments p ON p.id = a.ledger_payment_id
             WHERE a.amount <> p.amount) AS wrong_amount`);
  const b = bf.rows[0];
  assert.strictEqual(Number(b.orphans), 0, `${b.orphans} payment(s) got no allocation — their money vanishes from every invoice`); n++;
  assert.strictEqual(Number(b.allocs), Number(b.payments), 'allocation count does not match payment count'); n++;
  assert.strictEqual(Number(b.wrong_amount), 0, 'the backfill allocated an amount different from the payment'); n++;

  // Re-running must not double anything.
  await pool.query(fs.readFileSync(path.join(MIG, '133_payment_allocations.sql'), 'utf8'));
  const again = await pool.query('SELECT count(*)::int AS n FROM payment_allocations');
  assert.strictEqual(again.rows[0].n, Number(b.payments),
    're-running migration 133 duplicated allocations — every invoice would read double-paid'); n++;

  // ── AFTER: the real recalcInvoiceState, over every invoice ────────────────
  require.cache[path.join(BE, 'src/config/db.js')] =
    { id: 'db', filename: 'db', loaded: true, exports: { pool } };
  require.cache[path.join(BE, 'src/utils/payoutSchedule.js')] =
    { id: 'ps', filename: 'ps', loaded: true, exports: { syncPayoutDueDate: async () => {} } };
  const { recalcInvoiceState, readInvoiceBalance } =
    require(path.join(BE, 'src/services/invoiceBalance.service.js'));

  const ids = (await pool.query('SELECT id FROM customer_invoices ORDER BY id')).rows.map(r => r.id);
  const client = await pool.connect();
  const after = [];
  for (const id of ids) {
    await client.query('BEGIN');
    const s = await recalcInvoiceState(client, id);
    await client.query('COMMIT');
    after.push({ id, ...s });
  }
  client.release();

  // ── THE ASSERTION THIS PHASE EXISTS FOR ───────────────────────────────────
  const before = (await pool.query('SELECT * FROM _before ORDER BY id')).rows;
  assert.strictEqual(after.length, before.length, 'an invoice was lost or gained'); n++;
  for (const bRow of before) {
    const a = after.find(x => x.id === bRow.id);
    assert.ok(a, `invoice ${bRow.id} missing after`); n++;
    assert.strictEqual(Number(a.amount_paid), Number(bRow.amount_paid),
      `CI-${bRow.id}: amount_paid changed from ${bRow.amount_paid} to ${a.amount_paid}`); n++;
    assert.strictEqual(a.status, bRow.status,
      `CI-${bRow.id}: status changed from ${bRow.status} to ${a.status}`); n++;
    assert.strictEqual(Number(a.balance), Number(bRow.balance),
      `CI-${bRow.id}: balance changed from ${bRow.balance} to ${a.balance}`); n++;
  }

  // Spot-check the shapes by hand, so a wholesale error in BOTH the old rule
  // and the new code could not pass by agreeing with each other.
  const byId = Object.fromEntries(after.map(r => [r.id, r]));
  assert.strictEqual(Number(byId[1].amount_paid), 8500, 'three payments on one invoice do not sum'); n++;
  assert.strictEqual(Number(byId[2].amount_paid), 1111.11, 'paise are lost'); n++;
  assert.strictEqual(Number(byId[3].amount_paid), 2500,
    'the processed refund did not reduce, or the PENDING refund wrongly did'); n++;
  assert.strictEqual(Number(byId[4].amount_paid), 0, 'an unpaid invoice is not zero'); n++;
  assert.strictEqual(byId[4].status, 'approved', 'an unpaid approved invoice lost its status'); n++;
  assert.strictEqual(byId[5].status, 'paid', 'an exactly settled invoice is not paid'); n++;
  assert.strictEqual(byId[6].status, 'generated', 'an unpaid generated invoice was promoted'); n++;
  assert.strictEqual(byId[7].status, 'paid', 'the 0.011 paise tolerance was lost — ₹4999.99 of ₹5000 must read paid'); n++;

  // readInvoiceBalance must agree with recalcInvoiceState. They are read by
  // different callers — the gateway sizes a charge with one and the invoice
  // screen shows the other — and a disagreement is an overcharge.
  for (const id of ids) {
    const rb = await readInvoiceBalance(pool, id);
    assert.strictEqual(Number(rb.amount_paid), Number(byId[id].amount_paid),
      `readInvoiceBalance disagrees with recalcInvoiceState on CI-${id}`); n++;
    assert.strictEqual(Number(rb.balance), Number(byId[id].balance),
      `readInvoiceBalance balance disagrees on CI-${id}`); n++;
  }

  // ── The view behaves ──────────────────────────────────────────────────────
  const v = await pool.query(`SELECT * FROM invoice_payment_lines WHERE customer_invoice_id = 1 ORDER BY paid_at`);
  assert.strictEqual(v.rowCount, 3, 'the view does not return one row per allocation'); n++;
  assert.ok(v.rows.every(r => r.paid_at && r.method), 'the view lost the payment columns'); n++;
  assert.ok(v.rows.some(r => r.source === 'gateway') && v.rows.some(r => r.source === 'manual'),
    'the view does not carry source'); n++;

  // ── Deleting a payment must take its allocation ───────────────────────────
  // Without the CASCADE the invoice keeps counting money that no longer exists.
  await pool.query('DELETE FROM customer_invoice_payments WHERE id = 3');
  const left = await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE ledger_payment_id = 3');
  assert.strictEqual(left.rows[0].n, 0, 'deleting a payment left its allocation behind'); n++;
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const s = await recalcInvoiceState(c, 1);
    await c.query('COMMIT'); c.release();
    assert.strictEqual(Number(s.amount_paid), 7000,
      'the invoice still counts a deleted payment'); n++;
  }

  // ── A partial allocation is what makes advances possible ──────────────────
  // Not reachable through any handler yet; asserted here because the whole
  // point of this phase is that the arithmetic already supports it.
  await pool.query(`INSERT INTO customer_invoice_payments (id, customer_invoice_id, amount, method, source, hub_id)
                    VALUES (50, 4, 2000, 'cash', 'manual', 2)`);
  await pool.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
                    VALUES (50, 4, 800)`);
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const s = await recalcInvoiceState(c, 4);
    await c.query('COMMIT'); c.release();
    assert.strictEqual(Number(s.amount_paid), 800,
      'a partly allocated payment applied its full amount — an advance would overpay its invoice'); n++;
  }
  const credit = await pool.query(`
    SELECT p.amount - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                                 WHERE a.ledger_payment_id = p.id), 0) AS credit
      FROM customer_invoice_payments p WHERE p.id = 50`);
  assert.strictEqual(Number(credit.rows[0].credit), 1200,
    'credit is not payment minus allocations'); n++;

  await pool.end();
  console.log(`allocations layer (postgres): ${n} checks passed`);
})().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
