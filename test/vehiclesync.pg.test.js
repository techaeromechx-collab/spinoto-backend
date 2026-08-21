'use strict';

/**
 * One car, one record — appointments, the backfill, and the cascade.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 *
 * Scheduling an appointment recorded its vehicle in the appointment's OWN
 * columns (migration 021) and wrote nothing to customer_vehicles. The Customer
 * page merges real vehicles with ones DERIVED from appointments, so the car
 * showed up with cv_id = null — and the edit button reads
 *
 *     onClick={() => v.cv_id ? setEditVeh(v) : setPromoteVeh(v)}
 *
 * so pressing Edit did not edit. It fell through to "save this vehicle",
 * created a SECOND record that looked manually added, and left the appointment
 * untouched.
 *
 * Three things fix it and all three are exercised here:
 *
 *   1. utils/customerVehicle.js  — appointments now register the vehicle
 *   2. migration 167             — the ones already orphaned get a record
 *   3. cascadeVehicleEdit        — correcting the car reaches the appointment
 *
 * ── WHY THIS IS A POSTGRES SUITE ────────────────────────────────────────────
 *
 * Every question here is one only a real database answers. Does a SAVEPOINT
 * actually keep the caller's transaction usable after a constraint violation?
 * Does DISTINCT ON take the row ORDER BY says it does? Does a correlated NOT
 * EXISTS exclude what it looks like it excludes? A stub would answer whatever
 * it was written to answer.
 *
 * Skips cleanly when there is no scratch server, like the other pg suites.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Pool } = require('pg');

const BE = path.resolve(__dirname, '..');
const DBNAME = 'spinoto_vehiclesync_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };

// Only the columns these three pieces of code touch. A faithful copy of the
// whole schema would be a second definition of it that drifts.
const SCHEMA = `
CREATE TABLE vehicle_types  (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE vehicle_makes  (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE vehicle_models (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE segments       (id SERIAL PRIMARY KEY, name TEXT);
INSERT INTO vehicle_types  SELECT generate_series(1,5), 'type';
INSERT INTO vehicle_makes  SELECT generate_series(1,5), 'make';
INSERT INTO vehicle_models SELECT generate_series(1,5), 'model';
INSERT INTO segments       SELECT generate_series(1,5), 'segment';

-- migration 049 + 062
CREATE TABLE customer_vehicles (
  id              SERIAL PRIMARY KEY,
  mobile          VARCHAR(20) NOT NULL,
  vehicle_number  VARCHAR(30) NOT NULL,
  vehicle_type_id INT REFERENCES vehicle_types(id),
  make_id         INT REFERENCES vehicle_makes(id),
  model_id        INT REFERENCES vehicle_models(id),
  segment_id      INT REFERENCES segments(id),
  color           VARCHAR(50),
  year            SMALLINT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mobile, vehicle_number)
);

-- migration 021
CREATE TABLE appointments (
  id SERIAL PRIMARY KEY, mobile VARCHAR(20), vehicle_number VARCHAR(30),
  vehicle_type_id INT, make_id INT, model_id INT,
  segment_ids INT[] DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migration 082
CREATE TABLE estimates (
  id SERIAL PRIMARY KEY, mobile VARCHAR(20), vehicle_number VARCHAR(30),
  vehicle_type_id INT, make_id INT, model_id INT,
  segment_ids INT[] DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migration 065
CREATE TABLE customer_invoices (
  id SERIAL PRIMARY KEY, appointment_id INT REFERENCES appointments(id),
  mobile VARCHAR(20), vehicle_number VARCHAR(30),
  status VARCHAR(20) CHECK (status IN ('pending_approval','approved','cancelled'))
);
`;

/** cascadeVehicleEdit, lifted from the controller — which cannot be required. */
function loadCascade() {
  const src = fs.readFileSync(`${BE}/src/controllers/customers.controller.js`, 'utf8');
  const start = src.indexOf('async function cascadeVehicleEdit(');
  assert.ok(start > -1,
    'cascadeVehicleEdit is gone from customers.controller.js — inlined again, or renamed. '
    + 'It was extracted specifically so this suite could drive the REAL branching: an '
    + 'earlier version of this test rebuilt the conditionals itself and passed while three '
    + 'deliberate breaks went unnoticed.');
  const end = src.indexOf('\nmodule.exports', start);
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.fn = cascadeVehicleEdit;', ctx);
  return ctx.fn;
}

const M = '+919000000001';
const OTHER = '+919000000009';

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('vehicle sync (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const pool = new Pool(DB);
  await pool.query(SCHEMA);

  const { upsertCustomerVehicle } = require(`${BE}/src/utils/customerVehicle.js`);
  const cascadeVehicleEdit = loadCascade();
  let n = 0;

  const cvs = async (m) => (await pool.query(
    'SELECT * FROM customer_vehicles WHERE mobile=$1 ORDER BY id', [m])).rows;

  // ══ 1. REGISTERING ═══════════════════════════════════════════════════════
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const made = await upsertCustomerVehicle(c, M, {
      vehicle_number: '  gj01kz2914 ', vehicle_type_id: 1, make_id: 2, model_id: 3,
      segment_ids: [2, 9],
    });
    await c.query('COMMIT');
    c.release();

    assert.strictEqual(made, true, 'scheduling did not register the vehicle'); n++;
    const r = await cvs(M);
    assert.strictEqual(r.length, 1); n++;
    assert.strictEqual(r[0].vehicle_number, 'GJ01KZ2914',
      'the plate was not trimmed and uppercased the way addCustomerVehicle does — '
      + 'a different normalisation slips past the unique constraint and gives one car two rows'); n++;
    assert.strictEqual(r[0].make_id, 2); n++;
    assert.strictEqual(r[0].segment_id, 2, 'the first segment_id was not taken'); n++;
  }

  // A second booking must not duplicate, and must not wipe detail the
  // appointment form never asks for.
  {
    await pool.query(`UPDATE customer_vehicles SET color='Red', year=2019, notes='owner: Sunny'
                       WHERE mobile=$1`, [M]);
    const c = await pool.connect();
    await c.query('BEGIN');
    const again = await upsertCustomerVehicle(c, M, {
      vehicle_number: 'GJ01KZ2914', vehicle_type_id: null, make_id: null, model_id: null,
    });
    await c.query('COMMIT');
    c.release();

    assert.strictEqual(again, false, 'reported a create for a car already on file'); n++;
    const r = await cvs(M);
    assert.strictEqual(r.length, 1, 'one car became two rows'); n++;
    assert.strictEqual(r[0].color, 'Red',
      'ON CONFLICT DO NOTHING is not holding — a repeat booking wiped the colour'); n++;
    assert.strictEqual(r[0].year, 2019, 'the year was wiped'); n++;
    assert.strictEqual(r[0].notes, 'owner: Sunny', 'the notes were wiped'); n++;
    assert.strictEqual(r[0].make_id, 2, 'the make was overwritten with null'); n++;
  }

  // Case and padding resolve to the same row.
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const dup = await upsertCustomerVehicle(c, M, { vehicle_number: '  Gj01Kz2914' });
    await c.query('COMMIT');
    c.release();
    assert.strictEqual(dup, false, 'a differently-cased plate created a second row'); n++;
    assert.strictEqual((await cvs(M)).length, 1); n++;
  }

  // Nothing to register.
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    for (const bad of [{}, { vehicle_number: '' }, { vehicle_number: '   ' }, { vehicle_number: null }]) {
      assert.strictEqual(await upsertCustomerVehicle(c, '+919000000099', bad), false); n++;
    }
    assert.strictEqual(await upsertCustomerVehicle(c, null, { vehicle_number: 'X' }), false,
      'a missing mobile was accepted'); n++;
    await c.query('COMMIT');
    c.release();
    assert.strictEqual((await cvs('+919000000099')).length, 0, 'a blank plate created a row'); n++;
  }

  // ══ 2. THE SAVEPOINT ═════════════════════════════════════════════════════
  //
  // The assertion that cannot be reasoned about, only run. A failed statement
  // inside a transaction aborts the WHOLE transaction, so a bare try/catch
  // would not save the caller — their appointment INSERT, which has already
  // succeeded, is lost at COMMIT. Only a SAVEPOINT makes "this failure is not
  // fatal" true rather than merely intended.
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const appt = await c.query(
      `INSERT INTO appointments (mobile, vehicle_number) VALUES ($1,'GJ99XX0001') RETURNING id`,
      ['+918888888888']);
    assert.ok(appt.rows[0].id); n++;

    const failed = await upsertCustomerVehicle(c, '+918888888888', {
      vehicle_number: 'GJ99XX0001',
      make_id: 99999,                    // no such make — FK violation
    });
    assert.strictEqual(failed, false, 'a failing insert reported success'); n++;

    let usable = true;
    try {
      await c.query(`INSERT INTO appointments (mobile) VALUES ('+918888888888')`);
    } catch { usable = false; }
    assert.strictEqual(usable, true,
      "the caller's transaction was poisoned — the SAVEPOINT is missing or misplaced, and a "
      + 'lookup-table problem would cost the customer their booking'); n++;

    await c.query('COMMIT');
    c.release();

    const kept = await pool.query(
      `SELECT count(*)::int c FROM appointments WHERE mobile='+918888888888'`);
    assert.strictEqual(kept.rows[0].c, 2,
      'the appointments did not survive a failed vehicle registration'); n++;
    assert.strictEqual((await cvs('+918888888888')).length, 0,
      'the bad vehicle row was committed'); n++;
  }

  // ══ 3. THE BACKFILL (migration 167) ══════════════════════════════════════
  {
    await pool.query('TRUNCATE customer_invoices, estimates, appointments, customer_vehicles RESTART IDENTITY');

    // Ten visits, one car. The NEWEST description must win — the oldest is the
    // one most likely to carry a make nobody had corrected yet.
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number, make_id, model_id, created_at)
      SELECT $1, 'GJ01AA1111', 1, 1, NOW() - (g || ' days')::interval FROM generate_series(2,10) g`, [M]);
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number, make_id, model_id, segment_ids, created_at)
      VALUES ($1,'GJ01AA1111', 4, 4, ARRAY[3,5], NOW())`, [M]);
    // Case + padding variants of one plate.
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number, make_id)
      VALUES ($1,'  gj02bb2222 ',2), ($1,'GJ02BB2222',2)`, ['+919000000002']);
    // Already registered by hand, with detail that must survive.
    await pool.query(`INSERT INTO customer_vehicles (mobile, vehicle_number, make_id, color, year, notes)
      VALUES ($1,'GJ03CC3333',5,'Blue',2018,'do not wash')`, ['+919000000003']);
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number, make_id)
      VALUES ($1,'GJ03CC3333',1)`, ['+919000000003']);
    // Estimate-only vehicle, and rows that must be ignored.
    await pool.query(`INSERT INTO estimates (mobile, vehicle_number, make_id, model_id)
      VALUES ($1,'GJ04DD4444',3,3)`, ['+919000000004']);
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number)
      VALUES ($1,NULL), ($1,''), ($1,'   ')`, ['+919000000005']);
    await pool.query(`INSERT INTO appointments (mobile, vehicle_number, make_id)
      VALUES (NULL,'GJ09ZZ9999',1)`);

    const MIG = `${BE}/db/migrations/167_backfill_customer_vehicles.sql`;
    assert.ok(fs.existsSync(MIG), 'migration 167 is missing'); n++;
    const sql = fs.readFileSync(MIG, 'utf8');
    await pool.query(sql);

    assert.strictEqual((await cvs(M)).length, 1, 'ten visits produced more than one row'); n++;
    assert.strictEqual((await cvs(M))[0].make_id, 4,
      'the backfill did not take the most recent description of the car'); n++;
    assert.strictEqual((await cvs(M))[0].segment_id, 3, 'the first segment was not taken'); n++;

    assert.strictEqual((await cvs('+919000000002')).length, 1,
      'case and padding variants of one plate produced two rows'); n++;
    assert.strictEqual((await cvs('+919000000002'))[0].vehicle_number, 'GJ02BB2222'); n++;

    const hand = (await cvs('+919000000003'))[0];
    assert.strictEqual(hand.color, 'Blue',
      'the backfill overwrote a hand-registered vehicle — DO NOTHING is not holding'); n++;
    assert.strictEqual(hand.make_id, 5, 'the hand-entered make was replaced'); n++;

    assert.strictEqual((await cvs('+919000000004')).length, 1, 'estimate-only vehicle missed'); n++;
    assert.strictEqual((await cvs('+919000000005')).length, 0, 'a blank plate was registered'); n++;

    const nulls = await pool.query('SELECT count(*)::int c FROM customer_vehicles WHERE mobile IS NULL');
    assert.strictEqual(nulls.rows[0].c, 0, 'a null mobile was registered'); n++;

    const upper = await pool.query(
      `SELECT bool_and(vehicle_number = UPPER(TRIM(vehicle_number))) ok FROM customer_vehicles`);
    assert.strictEqual(upper.rows[0].ok, true, 'a plate was stored unnormalised'); n++;

    // Idempotent — and the migration's own verification block must pass again.
    const before = (await pool.query('SELECT count(*)::int c FROM customer_vehicles')).rows[0].c;
    await pool.query(sql);
    const after = (await pool.query('SELECT count(*)::int c FROM customer_vehicles')).rows[0].c;
    assert.strictEqual(after, before, 'a second run of migration 167 created rows'); n++;
  }

  // ══ 4. THE CASCADE ═══════════════════════════════════════════════════════
  {
    const reset = async () => {
      await pool.query('TRUNCATE customer_invoices, estimates, appointments RESTART IDENTITY');
      // One car, two jobs: #1 open, #2 already invoiced and approved.
      // #3 belongs to a DIFFERENT customer and happens to carry the same plate.
      await pool.query(`INSERT INTO appointments (id, mobile, vehicle_number, vehicle_type_id, make_id, model_id)
        VALUES (1,$1,'GJ01AA1111',1,1,1),(2,$1,'GJ01AA1111',1,1,1),(3,$2,'GJ01AA1111',1,1,1)`, [M, OTHER]);
      await pool.query(`INSERT INTO customer_invoices (appointment_id, mobile, vehicle_number, status)
        VALUES (2,$1,'GJ01AA1111','approved'),(1,$1,'GJ01AA1111','pending_approval')`, [M]);
      await pool.query(`INSERT INTO estimates (mobile, vehicle_number, vehicle_type_id, make_id, model_id)
        VALUES ($1,'GJ01AA1111',1,1,1)`, [M]);
    };
    const go = (o) => cascadeVehicleEdit(pool, {
      mobile: M,
      oldPlate: 'GJ01AA1111',
      newPlate: o.newPlate || 'GJ01AA1111',
      plateChanged: Boolean(o.newPlate && o.newPlate !== 'GJ01AA1111'),
      vehicle_type_id: 2, make_id: 2, model_id: 2,
      propagate_vehicle_number: !!o.plate,
      propagate_details:        !!o.details,
      propagate_details_all:    !!o.all,
    });
    const appt = async (id) => (await pool.query('SELECT * FROM appointments WHERE id=$1', [id])).rows[0];
    const est  = async ()   => (await pool.query('SELECT * FROM estimates LIMIT 1')).rows[0];
    const inv  = async (a)  => (await pool.query(
      'SELECT * FROM customer_invoices WHERE appointment_id=$1', [a])).rows[0];

    // Nothing ticked.
    await reset(); await go({});
    assert.strictEqual((await appt(1)).make_id, 1, 'details changed with no box ticked'); n++;
    assert.strictEqual((await est()).make_id, 1); n++;

    // Box 1: open work only.
    await reset(); await go({ details: true });
    assert.strictEqual((await appt(1)).make_id, 2, 'the open appointment was not updated'); n++;
    assert.strictEqual((await appt(1)).vehicle_type_id, 2,
      'an appointment whose invoice is only pending_approval was treated as finished'); n++;
    assert.strictEqual((await appt(2)).make_id, 1,
      'an INVOICED appointment was rewritten — a document the customer holds no longer matches'); n++;
    assert.strictEqual((await est()).make_id, 1, 'an estimate changed without the second box'); n++;
    assert.strictEqual((await appt(3)).make_id, 1,
      "ANOTHER CUSTOMER's car with the same plate was modified"); n++;

    // Box 2: history too.
    await reset(); await go({ details: true, all: true });
    assert.strictEqual((await appt(2)).make_id, 2, 'invoiced work was not updated with box 2 on'); n++;
    assert.strictEqual((await est()).make_id, 2, 'the estimate was not updated with box 2 on'); n++;
    assert.strictEqual((await appt(3)).make_id, 1, "another customer's car was modified"); n++;

    // Box 2 alone still works.
    await reset(); await go({ all: true });
    assert.strictEqual((await appt(2)).make_id, 2, 'box 2 alone did nothing'); n++;

    // ── BOTH SWITCHES — the combination that fails silently ────────────────
    //
    // The plate step rewrites every row to the new plate FIRST. If the details
    // step then matched the old plate it would match nothing, and the feature
    // would appear simply not to work, with no error anywhere.
    await reset(); await go({ plate: true, details: true, newPlate: 'GJ02BB2222' });
    assert.strictEqual((await appt(1)).vehicle_number, 'GJ02BB2222', 'the plate did not propagate'); n++;
    assert.strictEqual((await appt(1)).make_id, 2,
      'the details did NOT propagate alongside a plate change — the details UPDATE is matching '
      + 'the old plate, which the plate UPDATE has already overwritten'); n++;
    assert.strictEqual((await appt(2)).vehicle_number, 'GJ02BB2222',
      'the plate cascade skipped invoiced work — a plate correction must reach every record'); n++;
    assert.strictEqual((await appt(2)).make_id, 1, 'invoiced work had its details rewritten'); n++;
    assert.strictEqual((await inv(2)).vehicle_number, 'GJ02BB2222',
      'the invoice plate did not update'); n++;
    assert.strictEqual((await appt(3)).vehicle_number, 'GJ01AA1111',
      "another customer's plate was rewritten"); n++;

    // Plate box alone must not touch details.
    await reset(); await go({ plate: true, newPlate: 'GJ02BB2222' });
    assert.strictEqual((await appt(1)).vehicle_number, 'GJ02BB2222'); n++;
    assert.strictEqual((await appt(1)).make_id, 1, 'the plate box changed the vehicle details'); n++;

    // plateChanged false: the plate statements must not run.
    await reset();
    await cascadeVehicleEdit(pool, {
      mobile: M, oldPlate: 'GJ01AA1111', newPlate: 'GJ01AA1111', plateChanged: false,
      vehicle_type_id: 2, make_id: 2, model_id: 2,
      propagate_vehicle_number: true, propagate_details: false, propagate_details_all: false,
    });
    assert.strictEqual((await appt(1)).vehicle_number, 'GJ01AA1111'); n++;
    assert.strictEqual((await appt(1)).make_id, 1); n++;
  }

  // ══ 5. THE CALLERS ═══════════════════════════════════════════════════════
  //
  // Every path that creates an appointment must register the vehicle. Source
  // scan rather than execution: these three sit behind zod schemas, hub
  // resolution and permission middleware, and standing all of that up would
  // test the scaffolding rather than the line that matters.
  for (const [file, label] of [
    ['src/controllers/appointments.controller.js', 'scheduling'],
    ['src/services/bookingAppointment.service.js', 'public booking'],
    ['src/controllers/warranty_claims.controller.js', 'warranty redo'],
  ]) {
    const src = fs.readFileSync(`${BE}/${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /require\('\.\.\/utils\/customerVehicle'\)/,
      `${label} does not import the shared vehicle helper`); n++;
    assert.match(src, /await upsertCustomerVehicle\(/,
      `${label} creates an appointment without registering the vehicle — the Customer page `
      + 'would offer to create a duplicate for it'); n++;
  }

  // And nobody reimplements the insert. Four copies of the normalisation rule
  // is how the unique constraint stops catching duplicates.
  const writers = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8');
      if (/INSERT INTO customer_vehicles/.test(s)) writers.push(p.replace(BE, ''));
    }
  });
  walk(`${BE}/src`);
  assert.deepStrictEqual(
    writers.sort(),
    ['/src/controllers/customers.controller.js',
     '/src/controllers/estimates.controller.js',
     '/src/utils/customerVehicle.js'].sort(),
    'a new place writes customer_vehicles directly. Use upsertCustomerVehicle — its plate '
    + 'normalisation is what the unique constraint depends on, and a fourth copy of it will '
    + 'drift.'); n++;

  await pool.end();
  console.log(`vehicle sync (postgres): ${n} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
