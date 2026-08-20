/**
 * Phase 4 — the advance receipt and refund vouchers, against a REAL PostgreSQL.
 *
 * These are TAX DOCUMENTS. What can go wrong with one is not that it looks
 * wrong; it is that it states a number an accountant will later have to defend.
 * So the things pinned here are the things a person would be asked about:
 *
 *   • gst + taxable == the amount received, to the paisa, on every voucher;
 *   • the voucher's tax proportion is the ESTIMATE's, not a rate applied fresh;
 *   • the receipt series is consecutive with NO GAPS — an abandoned payment
 *     link must consume no number;
 *   • two captures in the same instant get two different numbers;
 *   • receipts and refunds count on SEPARATE series, so issuing a refund never
 *     makes the receipt series skip;
 *   • a refund is numbered when the money goes back, never when it is asked
 *     for — and a failed refund leaves no hole;
 *   • only unapplied money can be refunded, and only once.
 *
 * Skips cleanly when no scratch server is running. Start one with:
 *   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgd -o '-p 5433 -k /tmp' start"
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BE = path.resolve(__dirname, '..');
const DBNAME = 'spinoto_voucher_test';
const CONN = { host: '/tmp', port: 5433, user: 'postgres', connectionTimeoutMillis: 1500 };
let n = 0;

const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const admin = new Client({ ...CONN, database: 'postgres' });
  try { await admin.connect(); } catch {
    console.log('vouchers (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const c = new Client({ ...CONN, database: DBNAME });
  await c.connect();

  await c.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE areas (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE hubs  (id SERIAL PRIMARY KEY, area_id INT REFERENCES areas(id),
                        hub_name VARCHAR(120), gst_number VARCHAR(20));
    CREATE TABLE appointments (id SERIAL PRIMARY KEY, customer_name VARCHAR(120),
                        mobile VARCHAR(15), vehicle_number VARCHAR(30), whatsapp VARCHAR(15),
                        make_id INT, model_id INT, body_type_id INT, cc_category_id INT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE estimates (id SERIAL PRIMARY KEY, status VARCHAR(30) DEFAULT 'approved',
                        hub_id INT REFERENCES hubs(id), appointment_id INT REFERENCES appointments(id),
                        public_token VARCHAR(20),
                        grand_total NUMERIC(12,2), total_gst NUMERIC(12,2),
                        customer_name VARCHAR(120), mobile VARCHAR(15), vehicle_number VARCHAR(30),
                        is_b2b BOOLEAN DEFAULT FALSE, b2b_company_name VARCHAR(160),
                        b2b_gst_number VARCHAR(20), b2b_address TEXT,
                        place_of_supply_code VARCHAR(2),
                        make_id INT, model_id INT, body_type_id INT, cc_category_id INT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE customer_invoices (id SERIAL PRIMARY KEY, estimate_id INT REFERENCES estimates(id),
                        grand_total NUMERIC(12,2), amount_paid NUMERIC(12,2) DEFAULT 0,
                        status VARCHAR(30) DEFAULT 'generated', mobile VARCHAR(15),
                        customer_name VARCHAR(120), public_token VARCHAR(20),
                        invoice_date DATE DEFAULT CURRENT_DATE,
                        hub_id INT REFERENCES hubs(id),
                        vehicle_number VARCHAR(30), appointment_id INT REFERENCES appointments(id),
                        -- recalcInvoiceState writes these on every allocation.
                        purchase_invoice_id INT, payout_due_date DATE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE payment_links (id SERIAL PRIMARY KEY, token VARCHAR(30), entity_type VARCHAR(20),
                        entity_id INT, hub_id INT, amount NUMERIC(12,2), status VARCHAR(20),
                        expires_at TIMESTAMPTZ, created_by INT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payment_transactions (id SERIAL PRIMARY KEY, txn_ref VARCHAR(60),
                        entity_type VARCHAR(20), entity_id INT, hub_id INT, amount NUMERIC(12,2),
                        status VARCHAR(20) DEFAULT 'created', gateway_payment_id VARCHAR(100),
                        payment_link_id INT, created_by INT, mobile VARCHAR(15),
                        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE customer_invoice_payments (
      id SERIAL PRIMARY KEY,
      customer_invoice_id INT REFERENCES customer_invoices(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL, method VARCHAR(30), reference_no VARCHAR(80), notes TEXT,
      paid_at DATE NOT NULL DEFAULT CURRENT_DATE, created_by INT REFERENCES users(id),
      source VARCHAR(20) NOT NULL DEFAULT 'manual', hub_id INT REFERENCES hubs(id),
      payment_transaction_id INT REFERENCES payment_transactions(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    -- recalcInvoiceState calls syncPayoutDueDate, which looks for a linked
    -- purchase invoice. Empty here — this file is about advances, not payouts —
    -- but the table has to exist for the query to parse.
    CREATE TABLE purchase_invoices (id SERIAL PRIMARY KEY, status VARCHAR(30),
                        payout_schedule JSONB, payout_due_date DATE,
                        estimate_id INT, purchase_invoice_id INT, amount_paid NUMERIC(12,2));
    CREATE TABLE company_settings (id INT PRIMARY KEY, company_name VARCHAR(160));
    INSERT INTO company_settings (id, company_name) VALUES (1, 'Spinoto');
    CREATE TABLE customer_identities (mobile VARCHAR(20) PRIMARY KEY, public_token VARCHAR(20));
    -- The name on an ON-ACCOUNT voucher comes from here when there is no job.
    CREATE TABLE customer_profiles (mobile VARCHAR(20) PRIMARY KEY,
                        display_name VARCHAR(120), is_deleted BOOLEAN DEFAULT FALSE);
    CREATE TABLE vehicle_makes  (id SERIAL PRIMARY KEY, name VARCHAR(80));
    CREATE TABLE vehicle_models (id SERIAL PRIMARY KEY, name VARCHAR(80));
    CREATE TABLE body_types     (id SERIAL PRIMARY KEY, name VARCHAR(80));
    CREATE TABLE cc_categories  (id SERIAL PRIMARY KEY, name VARCHAR(80));
  `);

  const apply = f => c.query(fs.readFileSync(path.join(BE, 'db/migrations', f), 'utf8'));
  for (const m of ['124_payment_refunds.sql', '133_payment_allocations.sql',
                   '134_invoice_payment_lines.sql', '135_advance_payments.sql',
                   '136_advance_gateway_scope.sql', '137_advance_voucher_series.sql',
                   '138_invoice_payment_lines_advance.sql', '139_advance_vouchers.sql',
                   '141_account_credit.sql']) {
    await apply(m);
  }

  // ── The service, pointed at this database ─────────────────────────────────
  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;
  const { pool } = require(path.join(BE, 'src/config/db'));
  const svc = require(path.join(BE, 'src/services/advances.service'));

  // A live pool check: if the service is talking to a different database, every
  // assertion below would be meaningless rather than failing.
  const who = await pool.query('SELECT current_database() AS db');
  if (who.rows[0].db !== DBNAME) {
    console.log(`vouchers (postgres): SKIPPED — service pool is on ${who.rows[0].db}, not ${DBNAME}`);
    process.exit(0);
  }

  // ── Seed ──────────────────────────────────────────────────────────────────
  await c.query(`INSERT INTO users (id, name) VALUES (1, 'Advisor')`);
  await c.query(`INSERT INTO areas (id, name) VALUES (1, 'Gota')`);
  await c.query(`INSERT INTO hubs (id, area_id, hub_name) VALUES (1, 1, 'Gota Motors LLP')`);
  await c.query(`INSERT INTO appointments (id, customer_name, mobile, vehicle_number)
                 VALUES (1, 'Raj Patel', '9876543210', 'GJ01AS1222')`);
  // 18% inclusive: 5000 gross, 762.71 tax, 4237.29 taxable.
  await c.query(`INSERT INTO estimates (id, hub_id, appointment_id, grand_total, total_gst,
                                        customer_name, mobile, vehicle_number)
                 VALUES (88, 1, 1, 5000.00, 762.71, 'Raj Patel', '9876543210', 'GJ01AS1222')`);

  // ── A cash advance: numbered immediately, tax proportional ───────────────
  const a1 = await svc.createManualAdvance({
    estimateId: 88, amount: 2000, method: 'cash', userId: 1,
  });
  const adv = a1.advance;
  n++; assert.ok(/^ADV-\d{4}-\d{2}-000001$/.test(adv.voucher_no),
    `first receipt is not number 1 of its series (got ${adv.voucher_no})`);

  // gst + taxable == amount, to the paisa. This is the arithmetic a customer
  // can do on the printed document.
  n++; assert.ok(near(Number(adv.amount) - Number(adv.gst_amount), 2000 - 305.08),
    'taxable + GST does not add up to the amount received');
  // 2000 × (762.71 / 5000) = 305.084 → 305.08
  n++; assert.ok(near(adv.gst_amount, 305.08),
    `the advance's GST is not the estimate's proportion (got ${adv.gst_amount})`);
  n++; assert.ok(near(adv.gst_rate, 18),
    `the printed rate is not 18% (got ${adv.gst_rate})`);
  n++; assert.ok(adv.public_token && adv.public_token.length <= 20,
    'the receipt has no public token, so the customer cannot open their own copy'); n++;

  // ── The document the customer receives ────────────────────────────────────
  const v = await svc.readReceiptVoucher(pool, { ledgerPaymentId: adv.id });
  n++; assert.ok(v, 'the receipt voucher cannot be read back');
  n++; assert.strictEqual(v.voucher_no, adv.voucher_no, 'the document carries a different number');
  n++; assert.ok(near(v.job_total, 5000), 'the voucher does not know the job total');
  n++; assert.ok(near(v.job_advanced, 2000), 'the voucher does not know what has been advanced');
  n++; assert.strictEqual(v.customer_name, 'Raj Patel', 'the voucher does not name the customer');
  n++; assert.strictEqual(v.kind, 'receipt', 'the receipt is not marked as one');

  // The same document, reached the way a CUSTOMER reaches it.
  const pub = await svc.readReceiptVoucher(pool, { publicToken: adv.public_token });
  n++; assert.strictEqual(pub && pub.id, adv.id,
    'the public token does not resolve to the same receipt');
  n++; assert.strictEqual(await svc.readReceiptVoucher(pool, { publicToken: 'nope' }), null,
    'an unknown token resolves to a document');

  // ── An abandoned payment link consumes NO number ─────────────────────────
  const before = (await c.query(`SELECT next_seq FROM advance_voucher_sequences
                                  WHERE doc_kind = 'receipt'`)).rows[0].next_seq;
  await c.query(
    `INSERT INTO payment_transactions (txn_ref, entity_type, entity_id, hub_id, amount, status)
     VALUES ('ADTEST1', 'estimate', 88, 1, 500, 'created')`);
  const after = (await c.query(`SELECT next_seq FROM advance_voucher_sequences
                                 WHERE doc_kind = 'receipt'`)).rows[0].next_seq;
  n++; assert.strictEqual(before, after,
    'an unpaid payment link consumed a receipt number — that is a hole in a tax series');
  // …and there is no document for it. Modelled as the row a half-finished
  // capture would leave: an advance with no number, which must not render as a
  // receipt stating that money was received.
  const unpaid = await c.query(
    `INSERT INTO customer_invoice_payments
       (customer_invoice_id, amount, method, paid_at, source, payment_type, estimate_id,
        mobile, public_token)
     VALUES (NULL, 400, 'upi', CURRENT_DATE, 'gateway', 'advance', 88, '9876543210', 'tok_unpaid')
     RETURNING id`);
  n++; assert.strictEqual(await svc.readReceiptVoucher(pool, { ledgerPaymentId: unpaid.rows[0].id }), null,
    'an advance with no receipt number renders as a receipt for money received');
  n++; assert.strictEqual(await svc.readReceiptVoucher(pool, { publicToken: 'tok_unpaid' }), null,
    'the public link renders an unnumbered advance as a receipt');
  await c.query(`DELETE FROM customer_invoice_payments WHERE id = $1`, [unpaid.rows[0].id]);
  n++; assert.strictEqual(await svc.readReceiptVoucher(pool, { voucherNo: 'ADV-9999-99-000001' }), null,
    'a number that was never issued resolves to a document');

  // ── Two captures at once get two different numbers ───────────────────────
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  try {
    await client1.query('BEGIN');
    const v1 = await svc.issueVoucherNumber(client1, { hubId: null });

    // client2 asks for a number WHILE client1 still holds its transaction open,
    // and we do not await it yet.
    //
    // This is the shape that catches a missing FOR UPDATE, and a timeout test
    // does not. Without the lock, client2's SELECT returns immediately with the
    // sequence value client1 has not committed yet — so both are handed the SAME
    // number, and client2 only blocks later, on the UPDATE. A test that merely
    // observes "client2 waited" passes either way. This one compares what the
    // two were actually given.
    await client2.query('BEGIN');
    const pending = svc.issueVoucherNumber(client2, { hubId: null });
    await new Promise(r => setTimeout(r, 200));
    await client1.query('COMMIT');
    const v2 = await pending;
    await client2.query('COMMIT');

    n++; assert.notStrictEqual(v2.voucher_no, v1.voucher_no,
      'two simultaneous captures were handed the same receipt number');
    n++; assert.strictEqual(v2.voucher_seq, v1.voucher_seq + 1,
      `the second capture did not take the next number (${v1.voucher_seq} then ${v2.voucher_seq})`);
    n++; assert.strictEqual(v1.voucher_seq, 2, 'the second receipt is not number 2');
  } finally { client1.release(); client2.release(); }

  // ── Refunds count on their OWN series ────────────────────────────────────
  // A second advance, so there is credit to return.
  const a2 = await svc.createManualAdvance({ estimateId: 88, amount: 1000, method: 'cash', userId: 1 });
  // 4, not 3: numbers 2 and 3 went to the two concurrent issues above, which
  // both committed. They belong to no payment row — see the closing assertion
  // for why that is the correct outcome rather than a leak.
  n++; assert.strictEqual(a2.advance.voucher_seq, 4,
    'the receipt series is not consecutive across a concurrent issue');

  const rf = await svc.refundAdvance({
    ledgerPaymentId: a2.advance.id, amount: 1000, reason: 'Job cancelled by the customer', userId: 1,
  });
  n++; assert.ok(/^ADVR-\d{4}-\d{2}-000001$/.test(rf.voucher_no),
    `the first refund is not number 1 of the REFUND series (got ${rf.voucher_no})`);
  n++; assert.strictEqual(rf.pending, false, 'a cash refund is not processed immediately');
  // 1000 of a 1000 advance whose GST was 152.54
  n++; assert.ok(near(rf.gst_amount, 152.54),
    `the refund reverses the wrong amount of tax (got ${rf.gst_amount})`);

  // The receipt series did NOT skip.
  const a3 = await svc.createManualAdvance({ estimateId: 88, amount: 100, method: 'cash', userId: 1 });
  n++; assert.strictEqual(a3.advance.voucher_seq, 5,
    'issuing a refund made the RECEIPT series skip a number');

  // ── The refund document ───────────────────────────────────────────────────
  const rv = await svc.readRefundVoucher(pool, { refundId: rf.id });
  n++; assert.ok(rv, 'the refund voucher cannot be read back');
  n++; assert.strictEqual(rv.kind, 'refund', 'the refund voucher is not marked as one');
  n++; assert.strictEqual(rv.against_voucher_no, a2.advance.voucher_no,
    'the refund does not name the receipt it reverses');
  n++; assert.ok(rv.public_token, 'the refund voucher has no public token');

  // ── Only unapplied money, and only once ──────────────────────────────────
  let msg = '';
  try {
    await svc.refundAdvance({ ledgerPaymentId: a2.advance.id, amount: 1, reason: 'again please' });
  } catch (e) { msg = e.message; }
  n++; assert.ok(/already been refunded|can still be refunded/i.test(msg),
    `refunding twice was allowed (message: ${msg})`);

  // Money applied to an invoice is not credit any more.
  await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total) VALUES (41, 88, 5000)`);
  await c.query(`INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
                 VALUES ($1, 41, $2)`, [adv.id, adv.amount]);
  msg = '';
  try {
    await svc.refundAdvance({ ledgerPaymentId: adv.id, amount: 100, reason: 'customer asked' });
  } catch (e) { msg = e.message; }
  n++; assert.ok(/applied to an invoice/i.test(msg),
    `money already on an invoice was refundable as credit (message: ${msg})`);

  // ── An ONLINE advance is actually sent back, not just recorded ───────────
  //
  // This is the bug this block exists for. The gateway branch used to write a
  // 'pending' row and stop — perfect record, money never moved, no webhook ever
  // arrived, and the screen told the customer it was on its way.
  //
  // With no Razorpay keys the adapter returns a MOCK refund reporting
  // 'processed', which is exactly what makes this observable: if the gateway is
  // called, the refund comes back processed AND numbered. If it is not, it
  // stays pending with no voucher, as it did before.
  {
    await c.query(
      `INSERT INTO payment_transactions (id, txn_ref, entity_type, entity_id, hub_id, amount,
                                         status, gateway_payment_id)
       VALUES (77, 'ADGW77', 'estimate', 88, 1, 600, 'captured', 'pay_MOCK77')`);
    const online = await c.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, paid_at, source, payment_type, estimate_id,
          mobile, voucher_no, gst_amount, gst_rate, public_token, payment_transaction_id)
       VALUES (NULL, 600, 'upi', CURRENT_DATE, 'gateway', 'advance', 88,
               '9876543210', 'ADV-2026-27-000700', 91.53, 18, 'tok_gw_77', 77)
       RETURNING id`);

    const out = await svc.refundAdvance({
      ledgerPaymentId: online.rows[0].id, amount: 600,
      reason: 'Customer cancelled after paying online', userId: 1,
    });

    n++; assert.strictEqual(out.status, 'processed',
      'an online advance refund was recorded but never sent to the gateway');
    n++; assert.ok(out.voucher_no && /^ADVR-/.test(out.voucher_no),
      `the processed online refund has no refund voucher (got ${out.voucher_no})`);
    n++; assert.strictEqual(out.pending, false,
      'a completed online refund is still reported as in flight');

    // The row must carry the advance link and the tax being reversed, or
    // applyRefundOutcome could not have known to issue a voucher at all.
    const row = (await c.query(
      `SELECT ledger_payment_id, gst_amount, gst_rate, gateway_refund_id, status
         FROM payment_refunds WHERE id = $1`, [out.id])).rows[0];
    n++; assert.strictEqual(Number(row.ledger_payment_id), online.rows[0].id,
      'the refund is not linked to the advance it reverses'); 
    n++; assert.ok(near(row.gst_amount, 91.53),
      `the online refund reverses the wrong tax (got ${row.gst_amount})`);
    n++; assert.ok(row.gateway_refund_id,
      'no gateway refund id was recorded — the gateway was never asked');

    // …and the ceiling still holds on this path.
    let msg = '';
    try {
      await svc.refundAdvance({ ledgerPaymentId: online.rows[0].id, amount: 1, reason: 'again' });
    } catch (e) { msg = e.message; }
    n++; assert.ok(/refunded|can still be refunded/i.test(msg),
      `an online advance could be refunded twice (message: ${msg})`);
  }

  // An online advance whose gateway transaction was never recorded cannot be
  // reversed automatically. It must say so — falling through would reach the
  // gateway path with no payment to refund and answer "Payment not found",
  // which reads as though the advance itself has vanished.
  {
    const orphan = await c.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, paid_at, source, payment_type, estimate_id,
          mobile, voucher_no, gst_amount, gst_rate, public_token)
       VALUES (NULL, 300, 'upi', CURRENT_DATE, 'gateway', 'advance', 88,
               '9876543210', 'ADV-2026-27-000800', 45.76, 18, 'tok_orphan')
       RETURNING id`);
    let msg = '';
    try {
      await svc.refundAdvance({ ledgerPaymentId: orphan.rows[0].id, amount: 300, reason: 'cancelled' });
    } catch (e) { msg = e.message; }
    n++; assert.ok(/Razorpay dashboard/i.test(msg),
      `an online advance with no gateway transaction did not explain itself (message: ${msg})`);
    const left = await c.query(
      `SELECT COUNT(*)::int AS n FROM payment_refunds WHERE ledger_payment_id = $1`,
      [orphan.rows[0].id]);
    n++; assert.strictEqual(left.rows[0].n, 0,
      'a refund row was left behind for money nothing will ever send back');
  }

  // ── A PENDING refund is not a document ───────────────────────────────────
  // Modelled directly: a gateway advance writes 'pending' with no number.
  const gp = await c.query(
    `INSERT INTO customer_invoice_payments
       (customer_invoice_id, amount, method, paid_at, source, payment_type, estimate_id,
        mobile, voucher_no, gst_amount, gst_rate, public_token)
     VALUES (NULL, 800, 'upi', CURRENT_DATE, 'gateway', 'advance', 88,
             '9876543210', 'ADV-2026-27-000900', 122.03, 18, 'tok_gw_1')
     RETURNING id`);
  const pend = await c.query(
    `INSERT INTO payment_refunds (ledger_payment_id, amount, reason, status, gst_amount, gst_rate)
     VALUES ($1, 800, 'Customer changed their mind', 'pending', 122.03, 18) RETURNING id`,
    [gp.rows[0].id]);
  n++; assert.strictEqual(await svc.readRefundVoucher(pool, { refundId: pend.rows[0].id }), null,
    'a refund that has not reached the customer already has a tax document');

  const seqBefore = (await c.query(`SELECT next_seq FROM advance_voucher_sequences
                                     WHERE doc_kind = 'refund'`)).rows[0].next_seq;

  // Now it processes. THIS is when it earns a number.
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const issued = await svc.issueRefundVoucher(cl, pend.rows[0].id);
    // Compared against the counter read a moment ago rather than a hard number:
    // every refund issued earlier in this file moves the series, and a fixed
    // expectation here would break whenever a case is added above.
    n++; assert.strictEqual(issued, `ADVR-${svc.financialYear()}-${String(seqBefore).padStart(6, '0')}`,
      `the processed refund did not take the next refund number (got ${issued})`);
    // Delivered twice — the second must be free.
    const again = await svc.issueRefundVoucher(cl, pend.rows[0].id);
    n++; assert.strictEqual(again, issued,
      'a webhook delivered twice issued a second number for one refund');
    await cl.query('COMMIT');
  } finally { cl.release(); }

  const seqAfter = (await c.query(`SELECT next_seq FROM advance_voucher_sequences
                                    WHERE doc_kind = 'refund'`)).rows[0].next_seq;
  n++; assert.strictEqual(seqAfter - seqBefore, 1,
    'a duplicate webhook advanced the refund series twice');

  // ── The whole series, end to end: consecutive, no gaps, no reuse ─────────
  const all = await c.query(
    `SELECT voucher_seq FROM customer_invoice_payments
      WHERE voucher_no LIKE 'ADV-%' AND voucher_seq IS NOT NULL ORDER BY voucher_seq`);
  const seqs = all.rows.map(r => r.voucher_seq);
  n++; assert.deepStrictEqual(seqs, [1, 4, 5],
    `the receipt series is not what was issued (got ${seqs.join(',')})`);
  // 2 and 3 are absent from the ledger: they were issued directly by the
  // concurrency test, to no payment. That is the honest outcome — a number,
  // once handed out, is spent. What must never happen is REUSE, which is what
  // the duplicate check below asserts. A test insisting the ledger holds every
  // number would be asserting that numbers get recycled.
  const dupes = await c.query(
    `SELECT voucher_no FROM customer_invoice_payments
      WHERE voucher_no IS NOT NULL GROUP BY voucher_no HAVING COUNT(*) > 1`);
  n++; assert.strictEqual(dupes.rows.length, 0, 'a receipt number was issued twice');

  // ── Money on the customer, with no job at all ────────────────────────────
  //
  // Everything above needed an estimate to supply the tax proportion. This is
  // the case that has none, and the rules that replace it.
  {
    // Switched OFF until someone has answered the rate question. An unset rate
    // is a refusal, not a default — a guess would print on a tax document.
    let msg = '';
    try {
      await svc.createAccountCredit({ mobile: '9876500000', amount: 1000, method: 'cash' });
    } catch (e) { msg = e.message; }
    n++; assert.ok(/switched off|GST rate/i.test(msg),
      `account credit was taken with no configured rate (message: ${msg})`);
    const none = await c.query(
      `SELECT COUNT(*)::int AS n FROM customer_invoice_payments WHERE mobile = '9876500000'`);
    n++; assert.strictEqual(none.rows[0].n, 0, 'a refused payment still wrote a row');

    // The constraint from 135 still forbids an advance attached to NOTHING.
    let blocked = false;
    try {
      await c.query(
        `INSERT INTO customer_invoice_payments (customer_invoice_id, amount, method, source, payment_type)
         VALUES (NULL, 500, 'cash', 'manual', 'advance')`);
    } catch (e) { blocked = e.code === '23514'; }
    n++; assert.ok(blocked,
      'an advance belonging to no job AND no customer was accepted — money no screen could find');

    // Now answer the rate.
    await c.query(`UPDATE company_settings SET advance_default_gst_rate = 18 WHERE id = 1`);

    // A name on file, so the voucher can name the person it belongs to.
    await c.query(
      `INSERT INTO customer_profiles (mobile, display_name) VALUES ('9876500000', 'Meera Shah')`);

    const out = await svc.createAccountCredit({
      mobile: '9876500000', amount: 1180, method: 'cash',
      vehicleNumber: 'GJ01ZZ9999', userId: 1,
    });
    const adv = out.advance;
    n++; assert.ok(/^ADV-/.test(adv.voucher_no),
      'on-account money did not get a receipt number from the ordinary series');
    n++; assert.strictEqual(adv.estimate_id, null, 'it was attached to a job it does not have');
    n++; assert.strictEqual(adv.customer_invoice_id, null, 'it was attached to an invoice');
    // INCLUSIVE: ₹1,180 at 18% contains ₹180 of tax, not ₹212.40 on top.
    n++; assert.ok(near(adv.gst_amount, 180),
      `the tax is not the part inside the amount (got ${adv.gst_amount})`);
    n++; assert.ok(near(adv.gst_rate, 18), 'the configured rate was not snapshotted onto the payment');

    // It is the customer's credit, and the existing machinery already sees it.
    const credit = await svc.creditFor(pool, '9876500000');
    n++; assert.ok(near(credit, 1180),
      `on-account money does not show as the customer's credit (got ${credit})`);

    // The identity exists, so the money belongs to a person the app can find.
    const ident = await c.query(
      `SELECT COUNT(*)::int AS n FROM customer_identities WHERE mobile = '9876500000'`);
    n++; assert.strictEqual(ident.rows[0].n, 1,
      'the customer was not created, so the money is attached to a number no screen resolves');

    // Changing the setting must never rewrite a receipt already issued.
    await c.query(`UPDATE company_settings SET advance_default_gst_rate = 5 WHERE id = 1`);
    const still = await c.query(
      `SELECT gst_rate, gst_amount FROM customer_invoice_payments WHERE id = $1`, [adv.id]);
    n++; assert.ok(near(still.rows[0].gst_rate, 18) && near(still.rows[0].gst_amount, 180),
      'changing the company rate altered a voucher already in a customer\'s hands');

    // And it can be applied to an invoice like any other credit, and returned.
    await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total) VALUES (55, NULL, 1000)`);
    const cl2 = await pool.connect();
    try {
      await cl2.query('BEGIN');
      const r2 = await svc.allocate(cl2, {
        ledgerPaymentId: adv.id, customerInvoiceId: 55, amount: null, userId: 1,
      });
      await cl2.query('COMMIT');
      n++; assert.ok(near(r2.applied, 1000),
        `applying on-account credit did not cap at what the invoice owes (got ${r2.applied})`);
    } finally { cl2.release(); }

    const left = await svc.creditFor(pool, '9876500000');
    n++; assert.ok(near(left, 180), `the remainder is not still credit (got ${left})`);

    const back = await svc.refundAdvance({
      ledgerPaymentId: adv.id, amount: 180, reason: 'Returned the unused balance', userId: 1,
    });
    n++; assert.ok(/^ADVR-/.test(back.voucher_no),
      'the unused part of on-account money could not be returned with a voucher');

    // The document, read the way both the staff PDF and the customer link read
    // it. With no estimate there is no job to take a name from, so it has to
    // come from the customer — a numbered tax document naming nobody is not a
    // document.
    const vch = await svc.readReceiptVoucher(pool, { ledgerPaymentId: adv.id });
    n++; assert.ok(vch, 'the on-account receipt cannot be read back');
    n++; assert.strictEqual(vch.customer_name, 'Meera Shah',
      `the on-account voucher names nobody (got ${vch.customer_name})`);
    n++; assert.strictEqual(vch.estimate_id, null, 'it resolved a job it does not have');
    n++; assert.strictEqual(vch.job_total, null, 'it resolved a job total from nowhere');

    // ── Credit chases the invoice ────────────────────────────────────────
    //
    // On-account money has no destination of its own, so it waits. Waiting
    // UNSEEN is the failure: the customer paid, gets billed the full amount,
    // and the money sits in a list nobody opened. applyCustomerCredit closes
    // that gap — atomically, oldest receipt first.
    //
    // Its own customer, with two receipts of known ages, so the ordering rule
    // is proved against state this block created rather than whatever the
    // cases above happened to leave behind.
    {
      const M = '9876511111';
      const older = await svc.createAccountCredit({ mobile: M, amount: 236, method: 'cash', userId: 1 });
      const newer = await svc.createAccountCredit({ mobile: M, amount: 590, method: 'cash', userId: 1 });
      await c.query(`UPDATE customer_invoice_payments SET paid_at = CURRENT_DATE - 5 WHERE id = $1`,
        [older.advance.id]);
      await c.query(`UPDATE customer_invoice_payments SET paid_at = CURRENT_DATE WHERE id = $1`,
        [newer.advance.id]);

      await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total, mobile)
                     VALUES (56, NULL, 400, $1)`, [M]);

      const applied = await svc.applyCustomerCredit({
        mobile: M, customerInvoiceId: 56, userId: 1,
      });
      n++; assert.ok(near(applied.total, 400),
        `credit was not capped at what the invoice owes (got ${applied.total})`);

      // Oldest first means the older receipt is DRAINED before the newer is
      // touched — not that the newer is never touched. ₹236 then ₹164.
      n++; assert.strictEqual(applied.applied[0].payment_id, older.advance.id,
        'credit was consumed newest-first, leaving a trail of half-spent receipts');
      n++; assert.ok(near(applied.applied[0].amount, 236),
        `the older receipt was not drained first (gave ${applied.applied[0].amount})`);
      n++; assert.strictEqual(applied.applied[1].payment_id, newer.advance.id,
        'the remainder did not come from the next receipt in date order');
      n++; assert.ok(near(applied.applied[1].amount, 164),
        `the newer receipt gave the wrong remainder (${applied.applied[1].amount})`);

      // The part-used receipt is the NEWEST one — which is the whole point of
      // consuming in date order.
      n++; assert.ok(near((await svc.unallocatedOf(pool, older.advance.id)).remaining, 0),
        'the older receipt still has credit on it');
      n++; assert.ok(near((await svc.unallocatedOf(pool, newer.advance.id)).remaining, 426),
        'the newer receipt was drawn on by the wrong amount');

      // A settled invoice is not somewhere money can go.
      let msg2 = '';
      try { await svc.applyCustomerCredit({ mobile: M, customerInvoiceId: 56 }); }
      catch (e) { msg2 = e.message; }
      n++; assert.ok(/already settled/i.test(msg2),
        `credit could be applied to an invoice that owes nothing (message: ${msg2})`);

      // A cancelled invoice is not somewhere money can go.
      await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total, mobile, status)
                     VALUES (58, NULL, 500, $1, 'cancelled')`, [M]);
      let msgC = '';
      try { await svc.applyCustomerCredit({ mobile: M, customerInvoiceId: 58 }); }
      catch (e) { msgC = e.message; }
      n++; assert.ok(/cancelled/i.test(msgC),
        `credit could be applied to a cancelled invoice (message: ${msgC})`);

      // Two advisors applying at the same moment must not both fill the same
      // balance. The invoice is locked first, so the second waits and then sees
      // what the first left — proven by result, not by reading the SQL.
      await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total, mobile)
                     VALUES (59, NULL, 300, $1)`, [M]);
      const both = await Promise.allSettled([
        svc.applyCustomerCredit({ mobile: M, customerInvoiceId: 59, userId: 1 }),
        svc.applyCustomerCredit({ mobile: M, customerInvoiceId: 59, userId: 1 }),
      ]);
      const landed = (await c.query(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM payment_allocations WHERE customer_invoice_id = 59`
      )).rows[0].t;
      n++; assert.ok(near(landed, 300),
        `two simultaneous applications overfilled the invoice (₹${landed} on a ₹300 invoice)`);
      n++; assert.strictEqual(both.filter(r => r.status === 'fulfilled').length, 1,
        'both simultaneous applications reported success for the same balance');

      // And a customer with nothing spare is told so rather than silently
      // succeeding with zero.
      await c.query(`INSERT INTO customer_invoices (id, estimate_id, grand_total, mobile)
                     VALUES (57, NULL, 100, '9999999999')`);
      let msg3 = '';
      try { await svc.applyCustomerCredit({ mobile: '9999999999', customerInvoiceId: 57 }); }
      catch (e) { msg3 = e.message; }
      n++; assert.ok(/no unused credit/i.test(msg3),
        `applying nothing reported success (message: ${msg3})`);
    }

    // REFUNDED money is not credit.
    //
    // This was wrong and it was quiet: `remaining` subtracted allocations and
    // not refunds, so a fully-refunded advance still read as spendable credit —
    // the customer page offered money the customer already had back.
    {
      const M = '9876522222';
      const paid = await svc.createAccountCredit({ mobile: M, amount: 500, method: 'cash', userId: 1 });
      n++; assert.ok(near(await svc.creditFor(pool, M), 500), 'the money is not credit to begin with');
      await svc.refundAdvance({
        ledgerPaymentId: paid.advance.id, amount: 500, reason: 'Customer changed their mind', userId: 1,
      });
      n++; assert.ok(near(await svc.creditFor(pool, M), 0),
        'money already given back is still offered as the customer\'s credit');
      n++; assert.ok(near((await svc.unallocatedOf(pool, paid.advance.id)).remaining, 0),
        'a refunded receipt still reports unapplied money on it');
    }
  }


  await pool.end();
  await c.end();
  console.log(`vouchers (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
