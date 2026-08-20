/**
 * Phase 2 — advance payments, against a REAL PostgreSQL.
 *
 * Three things here cannot be tested any other way, and each is a way the
 * feature could go wrong quietly:
 *
 *   1. THE VOUCHER SERIES. Two customers paying in the same second must not be
 *      handed the same receipt number, and an abandoned payment link must not
 *      consume one. A gap or a collision in a tax series is something a person
 *      has to explain to an auditor later, and neither is visible from reading
 *      the code — only from running it concurrently.
 *
 *   2. THE GST SPLIT. The tax inside an advance is a proportion of the estimate
 *      it came from, computed in NUMERIC and asserted to the paisa.
 *
 *   3. AUTO-APPLY. An advance must land on the invoice generated from its
 *      estimate, and the arithmetic has to survive an advance larger than the
 *      invoice — where the surplus stays as the customer's credit rather than
 *      overpaying.
 *
 * Builds its own database every run.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BE = path.resolve(__dirname, '..');
const MIG = path.join(BE, 'db', 'migrations');
const DBNAME = 'spinoto_adv_test';
let n = 0;

const CONN = { host: '/tmp', port: 5433, user: 'postgres', connectionTimeoutMillis: 1500 };

(async () => {
  const admin = new Pool({ ...CONN, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('advances (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const pool = new Pool({ ...CONN, database: DBNAME });

  await pool.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE areas (id SERIAL PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE hubs  (id SERIAL PRIMARY KEY, area_id INT REFERENCES areas(id));
    CREATE TABLE appointments (id SERIAL PRIMARY KEY, customer_name VARCHAR(120),
      mobile VARCHAR(20), vehicle_number VARCHAR(30));
    CREATE TABLE estimates (
      id SERIAL PRIMARY KEY, appointment_id INT REFERENCES appointments(id),
      hub_id INT REFERENCES hubs(id), status VARCHAR(40) DEFAULT 'work_completed',
      public_token VARCHAR(20),
      subtotal_ex_gst NUMERIC(12,2) DEFAULT 0, total_gst NUMERIC(12,2) DEFAULT 0,
      grand_total NUMERIC(12,2) DEFAULT 0,
      customer_name VARCHAR(160), mobile VARCHAR(20), vehicle_number VARCHAR(30));
    CREATE TABLE customer_invoices (
      id SERIAL PRIMARY KEY, public_token VARCHAR(20), status VARCHAR(30) DEFAULT 'approved',
      hub_id INT REFERENCES hubs(id), purchase_invoice_id INT,
      estimate_id INT REFERENCES estimates(id), appointment_id INT,
      grand_total NUMERIC(12,2) DEFAULT 0, amount_paid NUMERIC(12,2) DEFAULT 0,
      customer_name VARCHAR(120), mobile VARCHAR(20), vehicle_number VARCHAR(30),
      updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payment_transactions (
      id SERIAL PRIMARY KEY, txn_ref VARCHAR(40) UNIQUE, gateway VARCHAR(20) DEFAULT 'razorpay',
      mode VARCHAR(10) DEFAULT 'test', entity_type VARCHAR(30), entity_id INT,
      hub_id INT REFERENCES hubs(id), mobile VARCHAR(20),
      amount NUMERIC(12,2), currency VARCHAR(3) DEFAULT 'INR', status VARCHAR(20) DEFAULT 'created',
      gateway_order_id VARCHAR(100), gateway_payment_id VARCHAR(100), method_detail VARCHAR(40),
      error_code VARCHAR(60), error_description TEXT, payment_link_id INT,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payment_links (
      id SERIAL PRIMARY KEY, token VARCHAR(64) UNIQUE, entity_type VARCHAR(30) DEFAULT 'customer_invoice',
      entity_id INT, hub_id INT, amount NUMERIC(12,2), currency VARCHAR(3) DEFAULT 'INR',
      status VARCHAR(20) DEFAULT 'active', expires_at TIMESTAMPTZ,
      opened_count INT DEFAULT 0, last_opened_at TIMESTAMPTZ, notes TEXT,
      created_by INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE payment_links ADD CONSTRAINT payment_links_entity_type_check
      CHECK (entity_type IN ('customer_invoice'));
    ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_entity_type_check
      CHECK (entity_type IN ('customer_invoice','booking'));
    CREATE TABLE customer_invoice_payments (
      id SERIAL PRIMARY KEY,
      customer_invoice_id INT NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method VARCHAR(30) NOT NULL DEFAULT 'cash',
      reference_no VARCHAR(100), paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), notes TEXT,
      created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(),
      payment_transaction_id INT REFERENCES payment_transactions(id),
      source VARCHAR(20) NOT NULL DEFAULT 'manual', hub_id INT REFERENCES hubs(id));
    CREATE TABLE payment_refunds (
      id SERIAL PRIMARY KEY, payment_transaction_id INT NOT NULL REFERENCES payment_transactions(id),
      ledger_payment_id INT REFERENCES customer_invoice_payments(id),
      customer_invoice_id INT, hub_id INT, amount NUMERIC(12,2), status VARCHAR(20) DEFAULT 'processed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);

  // The real migrations, in order.
  for (const f of ['133_payment_allocations.sql', '134_invoice_payment_lines.sql',
                   '135_advance_payments.sql', '136_advance_gateway_scope.sql',
                   '137_advance_voucher_series.sql',
                   // 138 and 139 extend what 133–137 created. Applying the
                   // real set in order is the point of this file — pinning it
                   // to a prefix would test a schema that no longer ships.
                   '138_invoice_payment_lines_advance.sql',
                   '139_advance_vouchers.sql']) {
    await pool.query(fs.readFileSync(path.join(MIG, f), 'utf8'));
  }
  n++;

  await pool.query(`
    INSERT INTO users (name) VALUES ('Advisor');
    INSERT INTO areas (name) VALUES ('Gota');
    INSERT INTO hubs (area_id) VALUES (1);
    INSERT INTO appointments (customer_name, mobile, vehicle_number)
      VALUES ('Raj Patel','9876543210','GJ01AS1222');
    -- ₹5,000 including ₹762.71 GST at 18% on ₹4,237.29.
    INSERT INTO estimates (id, appointment_id, hub_id, subtotal_ex_gst, total_gst, grand_total,
                           customer_name, mobile, vehicle_number)
      VALUES (1, 1, 1, 4237.29, 762.71, 5000.00, 'Raj Patel','9876543210','GJ01AS1222'),
             (2, 1, 1, 8474.58, 1525.42, 10000.00, 'Raj Patel','9876543210','GJ01AS1222'),
             (3, 1, 1,    0.00,    0.00,     0.00, 'Raj Patel','9876543210','GJ01AS1222');
    SELECT setval('estimates_id_seq', 100);
  `);

  // ── Wire the service to this database ─────────────────────────────────────
  require.cache[path.join(BE, 'src/config/db.js')] =
    { id: 'db', filename: 'db', loaded: true, exports: { pool } };
  require.cache[path.join(BE, 'src/utils/payoutSchedule.js')] =
    { id: 'ps', filename: 'ps', loaded: true, exports: { syncPayoutDueDate: async () => {} } };
  const svc = require(path.join(BE, 'src/services/advances.service.js'));

  // ══ FINANCIAL YEAR ════════════════════════════════════════════════════════
  // April to March, computed in IST. A payment at 2am IST on 1 April is 20:30
  // UTC on 31 March — read in UTC it would be numbered into a year that has
  // already been filed.
  assert.strictEqual(svc.financialYear(new Date('2026-04-01T00:00:00+05:30')), '2026-27'); n++;
  assert.strictEqual(svc.financialYear(new Date('2026-03-31T23:59:00+05:30')), '2025-26'); n++;
  assert.strictEqual(svc.financialYear(new Date('2026-12-31T12:00:00+05:30')), '2026-27'); n++;
  assert.strictEqual(svc.financialYear(new Date('2027-01-01T12:00:00+05:30')), '2026-27'); n++;
  // The IST boundary itself: 20:35 UTC on 31 March is 2:05am IST on 1 April.
  assert.strictEqual(svc.financialYear(new Date('2026-03-31T20:35:00Z')), '2026-27',
    'the financial year is computed in UTC — a payment just after IST midnight lands in last year'); n++;

  // ══ THE GST SPLIT ═════════════════════════════════════════════════════════
  {
    const est = await svc.readEstimateForAdvance(pool, 1);
    assert.strictEqual(est.grand_total, 5000, 'the estimate total is wrong'); n++;
    assert.strictEqual(est.collectable, 5000, 'nothing has been advanced yet'); n++;

    const r = svc.resolveAdvance(est, 2000);
    assert.strictEqual(r.amount, 2000, 'the advance amount changed'); n++;
    // 2000 × (762.71 / 5000) = 305.084 → 305.08
    assert.strictEqual(r.gst_amount, 305.08,
      `the GST inside a ₹2,000 advance on a ₹5,000 job should be ₹305.08, got ₹${r.gst_amount}`); n++;
    assert.strictEqual(r.gst_rate, 18, `the rate should be 18%, got ${r.gst_rate}`); n++;
    // The amount is GST-INCLUSIVE. Nothing is added on top.
    assert.ok(r.gst_amount < r.amount, 'GST was added to the amount instead of being inside it'); n++;
  }
  {
    // The full amount carries the full tax, to the paisa.
    const est = await svc.readEstimateForAdvance(pool, 1);
    const r = svc.resolveAdvance(est, 5000);
    assert.strictEqual(r.gst_amount, 762.71,
      'a full-amount advance does not carry the estimate\'s whole tax'); n++;
  }
  {
    // An estimate with no total has nothing to take against.
    const est = await svc.readEstimateForAdvance(pool, 3);
    assert.throws(() => svc.resolveAdvance(est, 100), /no total/i,
      'an advance was allowed against an unpriced estimate — its GST would be unknowable'); n++;
  }

  // ══ THE CEILING ═══════════════════════════════════════════════════════════
  {
    const est = await svc.readEstimateForAdvance(pool, 1);
    assert.throws(() => svc.resolveAdvance(est, 6000), /more than/i,
      'an advance larger than the job was accepted'); n++;
    assert.throws(() => svc.resolveAdvance(est, 0), /valid amount/i); n++;
    assert.throws(() => svc.resolveAdvance(est, -5), /valid amount/i); n++;
  }

  // ══ A CASH ADVANCE ════════════════════════════════════════════════════════
  const cash = await svc.createManualAdvance({
    estimateId: 1, amount: 2000, method: 'cash', referenceNo: 'R-1', userId: 1,
  });
  const adv = cash.advance;
  assert.strictEqual(Number(adv.amount), 2000); n++;
  assert.strictEqual(adv.payment_type, 'advance', 'a cash advance was recorded as an invoice payment'); n++;
  assert.strictEqual(adv.customer_invoice_id, null,
    'an advance was bound to an invoice — there is no invoice yet'); n++;
  assert.strictEqual(adv.estimate_id, 1, 'the advance does not point at its estimate'); n++;
  assert.strictEqual(adv.mobile, '9876543210', 'the advance did not capture the customer'); n++;
  assert.strictEqual(adv.vehicle_number, 'GJ01AS1222', 'the advance did not capture the vehicle'); n++;
  assert.strictEqual(Number(adv.gst_amount), 305.08, 'the GST was not snapshotted'); n++;
  assert.ok(adv.voucher_no, 'no receipt number was issued for money already received'); n++;
  assert.ok(/^ADV-\d{4}-\d{2}-\d{6}$/.test(adv.voucher_no),
    `the voucher number is malformed: ${adv.voucher_no}`); n++;
  assert.ok(adv.public_token, 'the advance has no share token'); n++;

  // It is money, and it is credit — because nothing has been allocated.
  {
    const credit = await svc.creditFor(pool, '9876543210');
    assert.strictEqual(credit, 2000, `credit should be ₹2,000, got ₹${credit}`); n++;
    const u = await svc.unallocatedOf(pool, adv.id);
    assert.strictEqual(u.remaining, 2000, 'the advance is not fully unallocated'); n++;
  }

  // A second advance may be taken, up to the remaining total.
  {
    const est = await svc.readEstimateForAdvance(pool, 1);
    assert.strictEqual(est.already, 2000, 'the first advance is not counted'); n++;
    assert.strictEqual(est.collectable, 3000, 'the remaining collectable is wrong'); n++;
    assert.throws(() => svc.resolveAdvance(est, 3500), /more than/i,
      'the second advance could exceed what is left of the job'); n++;
  }

  // ══ THE VOUCHER SERIES ════════════════════════════════════════════════════
  // Consecutive, per financial year, never reused.
  {
    const second = await svc.createManualAdvance({ estimateId: 1, amount: 1000, method: 'upi', userId: 1 });
    const a = adv.voucher_seq, b = second.advance.voucher_seq;
    assert.strictEqual(b, a + 1, `receipt numbers are not consecutive: ${a} then ${b}`); n++;
    assert.notStrictEqual(adv.voucher_no, second.advance.voucher_no, 'two receipts share a number'); n++;
  }

  // ── THE LOCK, TESTED DIRECTLY ─────────────────────────────────────────────
  //
  // Ten concurrent calls through the service do NOT prove the FOR UPDATE
  // matters — verified by removing it and running them: still ten distinct
  // numbers, because the pool and the row lock on the UPDATE serialise them
  // enough by accident. An assertion that passes with the safeguard removed is
  // not testing the safeguard.
  //
  // So the interleaving is forced instead. Connection A opens a transaction and
  // takes a number, holding its lock. Connection B then tries — and MUST block
  // until A commits. A statement_timeout turns "blocked" into an observable
  // outcome: with the lock B times out, without it B sails through and hands a
  // second customer the same receipt number.
  {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      const first = await svc.issueVoucherNumber(a, { hubId: null });

      await b.query('BEGIN');
      await b.query(`SET LOCAL statement_timeout = '900ms'`);
      let blocked = false;
      try {
        await svc.issueVoucherNumber(b, { hubId: null });
      } catch (err) {
        blocked = /timeout/i.test(err.message);
      }
      assert.ok(blocked,
        'a second transaction read the number series while another held it — two customers would be handed the same receipt number'); n++;

      await b.query('ROLLBACK');
      await a.query('COMMIT');

      // And once A is done, B gets the NEXT number, not the same one.
      await b.query('BEGIN');
      const second = await svc.issueVoucherNumber(b, { hubId: null });
      await b.query('COMMIT');
      assert.strictEqual(second.voucher_seq, first.voucher_seq + 1,
        `after the lock released, the next number should be ${first.voucher_seq + 1}, got ${second.voucher_seq}`); n++;
      assert.notStrictEqual(second.voucher_no, first.voucher_no, 'two receipts share a number'); n++;
    } finally {
      a.release(); b.release();
    }
  }

  // Ten at once must still all succeed and all differ. This does not prove the
  // lock (see above) — it proves the whole path survives being hammered, and
  // that the unique index is not being hit and swallowed.
  {
    const before = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.createManualAdvance({ estimateId: 2, amount: 100, method: 'cash', userId: 1 })
          .then(r => r.advance.voucher_no)
          .catch(e => `ERR:${e.message}`)));
    const good = results.filter(v => !String(v).startsWith('ERR:'));
    assert.strictEqual(good.length, 10, `only ${good.length} of 10 concurrent advances succeeded`); n++;
    assert.strictEqual(new Set(good).size, 10,
      `ten concurrent advances produced ${new Set(good).size} distinct receipt numbers — two customers share one`); n++;
    const after = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;
    assert.strictEqual(after - before, 10,
      `the sequence moved by ${after - before} for 10 receipts — the series has a gap or a repeat`); n++;
  }

  // ══ A LINK CONSUMES NO NUMBER ═════════════════════════════════════════════
  // The rule that keeps the series free of holes: a customer who opens a
  // payment link and walks away must not burn a receipt number.
  {
    const gateway = require(path.join(BE, 'src/services/gateway/razorpay.adapter.js'));
    const realCheck = gateway.isWebhookConfigured;
    gateway.isWebhookConfigured = () => true;

    const seqBefore = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;
    const link = await svc.createAdvanceLink({ estimateId: 2, amount: 500, userId: 1 });
    const seqAfter = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;

    assert.strictEqual(seqAfter, seqBefore,
      'creating a payment link consumed a receipt number — an abandoned link would leave a gap in the tax series'); n++;
    assert.strictEqual(link.txn.entity_type, 'estimate', 'the transaction is not scoped to the estimate'); n++;
    assert.strictEqual(link.link.entity_type, 'estimate', 'the link is not scoped to the estimate'); n++;
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM customer_invoice_payments WHERE payment_transaction_id = $1`, [link.txn.id]);
    assert.strictEqual(ledger.rows[0].n, 0, 'a link wrote a ledger row — a request is not money'); n++;

    // …and capture DOES issue one.
    const cap = await svc.captureAdvance({
      txnId: link.txn.id, gatewayPaymentId: 'pay_ADV1',
      gatewayPayment: { amount: 500, method_detail: 'upi' }, via: 'test',
    });
    assert.strictEqual(cap.captured, true); n++;
    assert.ok(cap.advance.voucher_no, 'a captured advance got no receipt number'); n++;
    assert.strictEqual(cap.advance.customer_invoice_id, null, 'a captured advance was bound to an invoice'); n++;
    assert.strictEqual(Number(cap.advance.amount), 500); n++;

    // A repeat delivery must not draw a SECOND number.
    const seqAfterCap = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;
    const dupe = await svc.captureAdvance({ txnId: link.txn.id, gatewayPaymentId: 'pay_ADV1', via: 'test' });
    const seqAfterDupe = (await pool.query(`SELECT next_seq FROM advance_voucher_sequences WHERE hub_id IS NULL`)).rows[0].next_seq;
    assert.strictEqual(dupe.duplicate, true, 'a repeat capture was not recognised'); n++;
    assert.strictEqual(seqAfterDupe, seqAfterCap,
      'a duplicate webhook consumed a second receipt number — leaving a gap where the unused one was'); n++;

    gateway.isWebhookConfigured = realCheck;
  }

  // ══ AUTO-APPLY ════════════════════════════════════════════════════════════
  {
    // Invoice for estimate 1, which holds ₹3,000 of advances (2000 + 1000).
    await pool.query(
      `INSERT INTO customer_invoices (id, estimate_id, hub_id, grand_total, status)
       VALUES (500, 1, 1, 5000, 'approved')`);

    const client = await pool.connect();
    await client.query('BEGIN');
    const applied = await svc.autoApplyForInvoice(client, { estimateId: 1, customerInvoiceId: 500, userId: 1 });
    await client.query('COMMIT');
    client.release();

    assert.strictEqual(applied.length, 2, `expected both advances applied, got ${applied.length}`); n++;
    const total = applied.reduce((s, a) => s + a.amount, 0);
    assert.strictEqual(total, 3000, `₹${total} applied, expected ₹3,000`); n++;

    const inv = await pool.query(`SELECT amount_paid, status FROM customer_invoices WHERE id = 500`);
    assert.strictEqual(Number(inv.rows[0].amount_paid), 3000,
      'the invoice did not pick up the advances'); n++;
    assert.strictEqual(inv.rows[0].status, 'partially_paid',
      'a ₹5,000 invoice with ₹3,000 of advances is not partially paid'); n++;

    // The advances are consumed, so the credit is gone.
    const credit = await svc.creditFor(pool, '9876543210');
    assert.ok(credit < 3000, 'applying the advances did not reduce the credit'); n++;

    // Applying twice must not double the invoice.
    const c2 = await pool.connect();
    await c2.query('BEGIN');
    const again = await svc.autoApplyForInvoice(c2, { estimateId: 1, customerInvoiceId: 500 });
    await c2.query('COMMIT'); c2.release();
    assert.strictEqual(again.length, 0, 'a second auto-apply re-applied money already used'); n++;
    const inv2 = await pool.query(`SELECT amount_paid FROM customer_invoices WHERE id = 500`);
    assert.strictEqual(Number(inv2.rows[0].amount_paid), 3000,
      'the invoice was paid twice from one advance'); n++;
  }

  // ══ ADVANCE BIGGER THAN THE INVOICE ═══════════════════════════════════════
  // The surplus stays as credit. It must never overpay the invoice.
  {
    await pool.query(`
      INSERT INTO estimates (id, appointment_id, hub_id, subtotal_ex_gst, total_gst, grand_total,
                             customer_name, mobile, vehicle_number)
      VALUES (50, 1, 1, 3389.83, 610.17, 4000.00, 'Big Advance','9800000099','GJ09ZZ0009')`);
    const big = await svc.createManualAdvance({ estimateId: 50, amount: 4000, method: 'cash', userId: 1 });

    // …but the job turns out smaller.
    await pool.query(
      `INSERT INTO customer_invoices (id, estimate_id, hub_id, grand_total, status)
       VALUES (501, 50, 1, 2500, 'approved')`);

    const c = await pool.connect();
    await c.query('BEGIN');
    const applied = await svc.autoApplyForInvoice(c, { estimateId: 50, customerInvoiceId: 501 });
    await c.query('COMMIT'); c.release();

    assert.strictEqual(applied[0].amount, 2500,
      `only the invoice's ₹2,500 should be applied, got ₹${applied[0]?.amount}`); n++;
    const inv = await pool.query(`SELECT amount_paid, status FROM customer_invoices WHERE id = 501`);
    assert.strictEqual(Number(inv.rows[0].amount_paid), 2500, 'the invoice was overpaid'); n++;
    assert.strictEqual(inv.rows[0].status, 'paid', 'the invoice was not settled'); n++;
    const left = await svc.unallocatedOf(pool, big.advance.id);
    assert.strictEqual(left.remaining, 1500,
      `the ₹1,500 surplus should remain as credit, got ₹${left.remaining}`); n++;
    const credit = await svc.creditFor(pool, '9800000099');
    assert.strictEqual(credit, 1500, 'the surplus is not showing as the customer\'s credit'); n++;
  }

  // ══ ALLOCATION CEILINGS ═══════════════════════════════════════════════════
  {
    await pool.query(`
      INSERT INTO estimates (id, appointment_id, hub_id, subtotal_ex_gst, total_gst, grand_total, mobile)
      VALUES (60, 1, 1, 847.46, 152.54, 1000.00, '9700000001')`);
    const small = await svc.createManualAdvance({ estimateId: 60, amount: 1000, method: 'cash', userId: 1 });
    await pool.query(
      `INSERT INTO customer_invoices (id, estimate_id, hub_id, grand_total, status)
       VALUES (502, 60, 1, 9000, 'approved')`);

    const c = await pool.connect();
    await c.query('BEGIN');
    await assert.rejects(
      () => svc.allocate(c, { ledgerPaymentId: small.advance.id, customerInvoiceId: 502, amount: 5000 }),
      /still unapplied/i,
      'more was applied than the payment holds — money the workshop never received'); n++;
    await c.query('ROLLBACK');

    await c.query('BEGIN');
    await svc.allocate(c, { ledgerPaymentId: small.advance.id, customerInvoiceId: 502, amount: 1000 });
    await assert.rejects(
      () => svc.allocate(c, { ledgerPaymentId: small.advance.id, customerInvoiceId: 502, amount: 1 }),
      /fully applied/i, 'a fully applied payment could be applied again'); n++;
    await c.query('ROLLBACK');

    // The OTHER ceiling: more than the invoice still owes.
    //
    // Auto-apply never trips this — it asks for min(remaining, owed) and is
    // capped before it gets here. So it is only reachable by an explicit
    // allocation, which is exactly the path a person drives by hand, and the
    // one where a typo turns an advance into an overpaid invoice with the
    // surplus invisible instead of held as credit.
    await pool.query(`
      INSERT INTO estimates (id, appointment_id, hub_id, subtotal_ex_gst, total_gst, grand_total, mobile)
      VALUES (61, 1, 1, 4237.29, 762.71, 5000.00, '9700000002')`);
    const fat = await svc.createManualAdvance({ estimateId: 61, amount: 5000, method: 'cash', userId: 1 });
    await pool.query(
      `INSERT INTO customer_invoices (id, estimate_id, hub_id, grand_total, status)
       VALUES (503, 61, 1, 1200, 'approved')`);

    await c.query('BEGIN');
    await assert.rejects(
      () => svc.allocate(c, { ledgerPaymentId: fat.advance.id, customerInvoiceId: 503, amount: 4000 }),
      /only has ₹1200\.00 outstanding|outstanding/i,
      'more was applied than the invoice owes — the invoice reads overpaid and the surplus vanishes'); n++;
    await c.query('ROLLBACK');

    // …and the correct amount is accepted, leaving the rest as credit.
    await c.query('BEGIN');
    const fit = await svc.allocate(c, { ledgerPaymentId: fat.advance.id, customerInvoiceId: 503, amount: 1200 });
    await c.query('COMMIT');
    assert.strictEqual(fit.applied, 1200); n++;
    assert.strictEqual(fit.remaining, 3800, 'the surplus is not left as credit'); n++;
    c.release();
  }

  // ══ THE WIRING ════════════════════════════════════════════════════════════
  // Source assertions, because exercising the full invoice-generation and
  // webhook controllers against this database would mean standing up most of
  // the app. What is asserted here is placement — and placement is where these
  // two fail silently rather than loudly.
  {
    const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const ciSrc = strip(fs.readFileSync(path.join(BE, 'src/controllers/customer_invoices.controller.js'), 'utf8'));
    const whSrc = strip(fs.readFileSync(path.join(BE, 'src/controllers/webhooks.payments.controller.js'), 'utf8'));

    // The ASSIGNMENT, not merely the call text appearing somewhere.
    //
    // `/autoApplyForInvoice\(client, \{/` alone passes even when the call is
    // short-circuited into a dead branch — the characters are still in the
    // file. Anchoring on the whole statement is what makes this an assertion
    // about behaviour rather than about spelling.
    assert.ok(/appliedAdvances = await autoApplyForInvoice\(client, \{\s*\n\s*estimateId: estimate_id, customerInvoiceId: ciId/.test(ciSrc),
      'generating an invoice does not apply the advances held against its estimate'); n++;
    assert.ok(!/\|\|\s*await autoApplyForInvoice/.test(ciSrc),
      'the auto-apply call is short-circuited — the text is there but it never runs'); n++;

    // INSIDE the transaction. Outside it, a failure between the two leaves an
    // invoice showing the full amount due while the customer's money sits as
    // credit — with the customer standing there having already paid.
    const gen = ciSrc.slice(ciSrc.indexOf('function generateCustomerInvoiceFromEstimate'));
    const applyIdx  = gen.indexOf('autoApplyForInvoice(client,');
    const commitIdx = gen.indexOf("await client.query('COMMIT')");
    assert.ok(applyIdx > 0 && commitIdx > 0 && applyIdx < commitIdx,
      'advances are applied AFTER the invoice transaction commits — a failure between them strands the money'); n++;
    assert.ok(!/autoApplyForInvoice\(pool,/.test(ciSrc),
      'auto-apply runs on the pool, outside any transaction'); n++;

    // An estimate-scoped capture must not go down the invoice path — there is
    // no invoice for it to recalculate.
    assert.ok(/if \(txn\.entity_type === 'estimate'\) \{[\s\S]{0,200}captureAdvance\(/.test(whSrc),
      'the webhook does not route an estimate-scoped capture to the advance path'); n++;
    // Both handlers: payment.captured and qr_code.credited.
    assert.strictEqual((whSrc.match(/txn\.entity_type === 'estimate'/g) || []).length, 2,
      'only one of the two capture handlers routes advances — a QR advance would take the invoice path'); n++;
  }

  // ══ THE CONSTRAINTS DO THEIR OWN WORK ═════════════════════════════════════
  // Not application logic — the database refusing states the code should never
  // produce, so that a future handler cannot produce them either.
  await assert.rejects(
    () => pool.query(`INSERT INTO customer_invoice_payments (customer_invoice_id, amount, payment_type)
                      VALUES (NULL, 100, 'invoice')`),
    /cip_invoice_payment_has_invoice/,
    'an ordinary invoice payment was allowed with no invoice'); n++;
  await assert.rejects(
    () => pool.query(`INSERT INTO customer_invoice_payments (customer_invoice_id, amount, payment_type)
                      VALUES (NULL, 100, 'advance')`),
    /cip_advance_has_context/,
    'an advance was allowed with no estimate, appointment or booking — money nothing can lead you back to'); n++;
  await assert.rejects(
    () => pool.query(`INSERT INTO customer_invoice_payments (amount, payment_type, estimate_id, voucher_no)
                      VALUES (100, 'advance', 1, $1)`, [adv.voucher_no]),
    /uq_cip_voucher_no/, 'two receipts were allowed to share a number'); n++;
  await assert.rejects(
    () => pool.query(`INSERT INTO payment_refunds (amount, status) VALUES (100, 'processed')`),
    /refund_has_source/, 'a refund was allowed with nothing to trace it to'); n++;

  await pool.end();
  console.log(`advances (postgres): ${n} checks passed`);
})().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
