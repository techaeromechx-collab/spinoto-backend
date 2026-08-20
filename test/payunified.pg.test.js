/**
 * Phase B — the unified payments queries, run against a REAL PostgreSQL.
 *
 * Every other suite here reads source and asserts about it. Source assertions
 * cannot tell a valid UNION from an invalid one, cannot catch a column list
 * that misaligns between the two branches, and cannot notice that a gateway
 * capture is being counted twice. This one seeds a database — deliberately with
 * a transaction and a ledger row that share the id 41 — and runs the actual SQL
 * the controller builds.
 *
 * IT BUILDS ITS OWN DATABASE, every run.
 *
 * It used to connect to a shared scratch database and assume the rows it wanted
 * were there. They were, for a while — and then another suite seeded five more
 * invoices into the same database and thirteen assertions started failing on
 * code that had not changed. A test that depends on state it did not create is
 * not testing anything; it is agreeing with a coincidence.
 *
 * Skips cleanly when no scratch server is running, so it never blocks the rest.
 * Start one with:
 *   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgd -o '-p 5433 -k /tmp' start"
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BE = path.resolve(__dirname, '..');
const DBNAME = 'spinoto_unified_test';

const src = fs.readFileSync(path.join(BE, 'src/controllers/payments.controller.js'), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`const ${name} = \``);
  const start = src.indexOf('`', i) + 1;
  return src.slice(start, src.indexOf('`;', start));
};
const PAY_UNION = grab('PAY_UNION');
const PAY_SELECT = grab('PAY_SELECT').replace('${PAY_UNION}', PAY_UNION);

const CONN = { host: '/tmp', port: 5433, user: 'postgres', connectionTimeoutMillis: 1500 };

(async () => {
  const admin = new Client({ ...CONN, database: 'postgres' });
  try {
    await admin.connect();
  } catch {
    console.log('unified payments (postgres): SKIPPED — no scratch server on /tmp:5433');
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
    CREATE TABLE hubs  (id SERIAL PRIMARY KEY, area_id INT REFERENCES areas(id));
    CREATE TABLE customer_invoices (
      id SERIAL PRIMARY KEY, public_token VARCHAR(20), status VARCHAR(30) DEFAULT 'approved',
      hub_id INT REFERENCES hubs(id), purchase_invoice_id INT, estimate_id INT, appointment_id INT,
      grand_total NUMERIC(12,2) DEFAULT 0, amount_paid NUMERIC(12,2) DEFAULT 0,
      customer_name VARCHAR(120), mobile VARCHAR(20), vehicle_number VARCHAR(30));
    CREATE TABLE payment_transactions (
      id SERIAL PRIMARY KEY, txn_ref VARCHAR(40) UNIQUE, gateway VARCHAR(20) DEFAULT 'razorpay',
      mode VARCHAR(10) DEFAULT 'test', entity_type VARCHAR(30), entity_id INT, hub_id INT REFERENCES hubs(id),
      mobile VARCHAR(20), amount NUMERIC(12,2), currency VARCHAR(3) DEFAULT 'INR', status VARCHAR(20),
      gateway_order_id VARCHAR(100), gateway_payment_id VARCHAR(100), method_detail VARCHAR(40),
      error_code VARCHAR(60), error_description TEXT, payment_link_id INT,
      created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      qr_image_url TEXT, qr_expires_at TIMESTAMPTZ);
    CREATE TABLE customer_invoice_payments (
      id SERIAL PRIMARY KEY, customer_invoice_id INT NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method VARCHAR(30) NOT NULL DEFAULT 'cash',
      reference_no VARCHAR(100), paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), notes TEXT,
      created_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(),
      payment_transaction_id INT REFERENCES payment_transactions(id),
      source VARCHAR(20) NOT NULL DEFAULT 'manual', hub_id INT REFERENCES hubs(id));
    CREATE TABLE payment_refunds (
      id SERIAL PRIMARY KEY, payment_transaction_id INT REFERENCES payment_transactions(id),
      ledger_payment_id INT REFERENCES customer_invoice_payments(id),
      customer_invoice_id INT, hub_id INT, amount NUMERIC(12,2), status VARCHAR(20) DEFAULT 'processed');
  `);

  // Allocations exist from migration 133 onward, and PAY_UNION reads them.
  await c.query(fs.readFileSync(path.join(BE, 'db/migrations/133_payment_allocations.sql'), 'utf8'));

  await c.query(`
    INSERT INTO users (name) VALUES ('Advisor');
    INSERT INTO areas (name) VALUES ('Gota'), ('Bopal');
    INSERT INTO hubs (area_id) VALUES (1), (2);
    INSERT INTO customer_invoices (id, public_token, hub_id, grand_total, customer_name, mobile, vehicle_number)
    VALUES (41, 'tok41', 1, 2000, 'Raj', '9876543210', 'GJ01AB1234'),
           (42, 'tok42', 2, 5000, 'Meera', '9812345678', 'GJ05XY9999');
    SELECT setval('customer_invoices_id_seq', 100);

    -- A gateway transaction numbered 41, to collide with ledger row 41 on purpose.
    INSERT INTO payment_transactions (id, txn_ref, mode, entity_type, entity_id, hub_id, mobile, amount, status, method_detail, gateway_payment_id, created_by)
    VALUES (41, 'PYAAA1', 'live', 'customer_invoice', 41, 1, '9876543210', 1200, 'captured', 'upi', 'pay_X1', 1),
           (42, 'PYBBB2', 'test', 'customer_invoice', 42, 2, '9812345678',  900, 'failed',  'card', NULL, 1),
           (43, 'PYCCC3', 'live', 'customer_invoice', 42, 2, '9812345678',  400, 'created', NULL,   NULL, 1);
    SELECT setval('payment_transactions_id_seq', 100);

    INSERT INTO customer_invoice_payments (id, customer_invoice_id, amount, method, reference_no, paid_at, created_by, payment_transaction_id, source, hub_id)
    VALUES (41, 41, 1200, 'upi',  'pay_X1', NOW() - INTERVAL '1 day', 1, 41, 'gateway', 1),
           (44, 41,  800, 'cash', 'R-100',  NOW() - INTERVAL '2 day', 1, NULL, 'manual', 1),
           (45, 42, 2500, 'bank_transfer', 'NEFT-77', NOW(), 1, NULL, 'manual', 2);
    SELECT setval('customer_invoice_payments_id_seq', 100);

    INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount)
    VALUES (41, 41, 1200), (44, 41, 800), (45, 42, 2500);

    -- A refund against the GATEWAY payment only.
    INSERT INTO payment_refunds (payment_transaction_id, ledger_payment_id, customer_invoice_id, hub_id, amount, status)
    VALUES (41, NULL, 41, 1, 200, 'processed');
  `);

  let fail = 0, checks = 0;
  const ok = (label, cond, extra = '') => {
    checks++;
    if (!cond) { console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`); fail++; }
  };

  // 1. The union parses and returns both sides.
  const rows = (await c.query(`${PAY_SELECT} ORDER BY t.created_at DESC, t.row_key DESC`)).rows;
  ok('union parses and runs', true);
  ok('returns 5 rows (3 gateway + 2 manual)', rows.length === 5, `got ${rows.length}`);

  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  ok("gateway txn 41 keyed 'T41'", !!byId['T41']);
  ok("ledger row 44 keyed 'M44'", !!byId['M44']);
  ok('colliding ids do not merge', byId['T41'] && byId['M44'] && byId['T41'].amount !== byId['M44'].amount);

  // 2. The gateway capture must NOT appear twice.
  ok('gateway capture appears once, not twice',
     rows.filter(r => Number(r.amount) === 1200).length === 1);
  ok('ledger row 41 (source=gateway) is excluded', !byId['M41']);

  // 3. Refunds do not cross the union.
  ok('gateway row carries its refund', Number(byId['T41'].refunded) === 200, `got ${byId['T41'].refunded}`);
  ok('manual row has no refund leaked onto it', Number(byId['M44'].refunded) === 0, `got ${byId['M44'].refunded}`);

  // 4. Manual rows are synthesised correctly.
  ok("manual status is 'captured'", byId['M44'].status === 'captured');
  ok("manual mode is 'live'", byId['M44'].mode === 'live');
  ok("manual kind is 'manual'", byId['M44'].kind === 'manual');
  ok('manual carries its invoice', byId['M44'].entity_id === 41);
  ok('manual carries method', byId['M44'].method_detail === 'cash');
  ok('manual carries hub', byId['M44'].hub_id === 1);
  ok('manual mobile falls back to the invoice', byId['M44'].mobile === '9876543210');
  ok('manual customer resolves', byId['M44'].customer_name === 'Raj');
  ok('manual hub name resolves', byId['M44'].hub_name === 'Spinoto Gota', byId['M44'].hub_name);
  ok('manual reference is exposed', byId['M44'].reference_no === 'R-100');
  ok('manual has no txn_ref', byId['M44'].txn_ref === null);
  ok('manual txn_id is null (so refunds cannot match)', byId['M44'].txn_id === null);

  // 5. Filters that the frontend actually sends.
  const filtered = async (where, params) =>
    (await c.query(`${PAY_SELECT} WHERE ${where}`, params)).rows;
  ok('source=manual returns only cash', (await filtered(`t.kind = $1`, ['manual'])).length === 2);
  ok('source=gateway returns only online', (await filtered(`t.kind = $1`, ['gateway'])).length === 3);
  ok('status=captured spans both', (await filtered(`t.status = ANY($1::text[])`, [['captured']])).length === 3);
  ok('mode=test hides cash', (await filtered(`t.mode = $1`, ['test'])).length === 1);
  ok('hub scoping works on both sides',
     (await filtered(`t.hub_id = $1`, [1])).length === 2);
  ok('date filter uses paid_at for manual rows',
     (await filtered(`t.created_at < (CURRENT_DATE - INTERVAL '1 day')`, [])).length === 1);

  // 6. The summary aggregate.
  const sumSql = src.slice(src.indexOf('function paymentsSummary('), src.indexOf('function paymentsByHub('));
  const sq = sumSql.slice(sumSql.indexOf('`SELECT') + 1, sumSql.indexOf('${whereSql}')).replace('${PAY_UNION}', PAY_UNION);
  const s = (await c.query(sq)).rows[0];
  ok('summary runs', true);
  // captured: gateway 1200 + cash 800 + 2500 = 4500
  ok('collected includes cash', Number(s.collected) === 4500, `got ${s.collected}`);
  ok('collected_manual is the cash half', Number(s.collected_manual) === 3300, `got ${s.collected_manual}`);
  ok('collected_online is the gateway half', Number(s.collected_online) === 1200, `got ${s.collected_online}`);
  ok('refunded is counted once', Number(s.refunded) === 200, `got ${s.refunded}`);
  ok('failed_count is gateway-only', s.failed_count === 1, `got ${s.failed_count}`);
  ok('pending_count is gateway-only', s.pending_count === 1, `got ${s.pending_count}`);
  ok('gateway_captured excludes cash', s.gateway_captured === 1, `got ${s.gateway_captured}`);

  // 7. by-hub.
  const bhSql = src.slice(src.indexOf('function paymentsByHub('), src.indexOf('function getPayment('));
  const bq = bhSql.slice(bhSql.indexOf('`SELECT') + 1, bhSql.indexOf('${whereSql}')).replace('${PAY_UNION}', PAY_UNION)
    + ' GROUP BY t.hub_id, ar.name ORDER BY collected DESC';
  const hubs = (await c.query(bq)).rows;
  ok('by-hub runs', true);
  ok('two hubs returned', hubs.length === 2, `got ${hubs.length}`);
  const gota = hubs.find(h => h.hub_name === 'Spinoto Gota');
  ok('Gota collected 2000 (1200 online + 800 cash)', Number(gota.collected) === 2000, `got ${gota && gota.collected}`);
  ok('Gota split is right', Number(gota.collected_manual) === 800 && Number(gota.collected_online) === 1200);

  // 8. getPayment's integer lookup.
  const one = (await c.query(`${PAY_SELECT} WHERE t.txn_ref = $1`, ['PYAAA1'])).rows[0];
  ok('getPayment finds the gateway row', !!one);
  ok('txn_id is the integer the refunds table needs', one.txn_id === 41, `got ${one.txn_id}`);
  const rf = await c.query(`SELECT COUNT(*)::int AS n FROM payment_refunds WHERE payment_transaction_id = $1`, [one.txn_id]);
  ok('refund lookup by txn_id succeeds', rf.rows[0].n === 1);
  // And prove the OLD code would have blown up.
  let blew = false;
  try { await c.query(`SELECT 1 FROM payment_refunds WHERE payment_transaction_id = $1`, [one.id]); }
  catch (e) { blew = e.code === '22P02'; }
  ok("passing row_key ('T41') into that column is a 22P02", blew);

  await c.end();
  console.log(fail === 0 ? `unified payments (postgres): ${checks} checks passed` : `${fail} POSTGRES CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
