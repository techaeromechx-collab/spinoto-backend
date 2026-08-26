'use strict';

/**
 * A follow-up somebody DID vs a follow-up that just expired.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * Two completely different events wrote the same two columns:
 *
 *   PATCH /lead-events/:id/done   an advisor: "I called them"
 *   any status change             the code, because the follow-up was attached
 *                                 to a status the lead has left
 *
 * Both did `SET is_done = TRUE, done_at = NOW()` and nothing else, so the rows
 * were indistinguishable afterwards and every figure built on them counted the
 * two as one thing. An import updating 400 statuses closed 400 follow-ups and
 * booked every one as completed — on_time for any not yet due, attributed to
 * whoever happened to be assigned. The compliance rate could only go up.
 *
 * migration 170 adds auto_closed (and done_by, which the table never had at
 * all), and the reporting queries exclude the auto rows.
 *
 * ── WHY THIS SUITE EXECUTES SQL ─────────────────────────────────────────────
 *
 * A static test can prove `NOT e.auto_closed` appears in the query. It cannot
 * prove the column exists, that the FILTER clauses group as they read, or that
 * the rate actually comes out different. A sibling suite once passed 63 checks
 * against a query that could not run in production. So the queries here are
 * LIFTED OUT OF THE CONTROLLER TEXT and run — not retyped, because retyped SQL
 * tests the copy and the copy is always right.
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
const { applyProcessTimezone, istToday, istAddDays, istWeekday, istEndOfDayISO } =
  require(path.join(BE, 'src/utils/appTime'));

// Before any Date is formatted. Node caches the zone on first use, so a test
// that sets this late would pass while proving nothing about the server.
applyProcessTimezone();

const DBNAME = 'spinoto_followup_test';
/* The session timezone the app's own pool sets (src/config/db.js). Without it
   this suite would connect on UTC and cheerfully verify the behaviour the
   timezone work exists to replace. */
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             options: '-c timezone=Asia/Kolkata',
             connectionTimeoutMillis: 1500 };
let n = 0;

const read = f => fs.readFileSync(path.join(BE, 'src/controllers', f), 'utf8');
const SRC    = read('lead_events.controller.js');
const LEADS  = read('leads.controller.js');
const APPT   = read('appointments.controller.js');
const IMPORT = read('import.controller.js');

/* ── Lifting a template literal out of the source ───────────────────────────
   The queries are JS templates with ${} holes. Rather than strip the holes
   (and test something the app never sends) they are FILLED with the values the
   controller computes on the super-admin path — visibilitySQL = '',
   pOffset = 0 — by evaluating the template in a scope holding those names.

   Bounded by the literal's own backticks, not a fixed character window: a
   window is what once let an assertion run past the end of one query and match
   inside the next. */
function liftQuery(marker, vars) {
  const i = SRC.indexOf(marker);
  assert.ok(i > -1, `cannot find ${marker} in lead_events.controller.js`);
  const start = SRC.lastIndexOf('`', i);
  const end = SRC.indexOf('`', i);
  assert.ok(start > -1 && end > i, `cannot bound the template around ${marker}`);
  const names = Object.keys(vars);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${SRC.slice(start, end + 1)};`)(...names.map(k => vars[k]));
}

/* LIFTED, not copied. This fragment used to be pasted into all four handlers
   under four different names; it is one module constant now, and a copy here
   would test the copy — including its old, wrong flag list. */
const FINISHED_LEAD_SQL = (() => {
  const i = SRC.indexOf('const FINISHED_LEAD_SQL = `');
  assert.ok(i > -1, 'the shared finished-lead filter is gone; the rule is being pasted per handler again');
  return SRC.slice(SRC.indexOf('`', i) + 1, SRC.indexOf('`', SRC.indexOf('`', i) + 1));
})();

/* The pre-170 shape of the tables the changed SQL touches, from the migrations
   that own them (037 lead_events, 040 due_at, 013 leads.status as VARCHAR).
   Deliberately WITHOUT done_by / auto_closed: migration 170 has to be the thing
   that adds them, or applying it here proves nothing. */
const SCHEMA = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
  manager_id INTEGER REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE);

CREATE TABLE lead_statuses (
  id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL,
  sort_order INTEGER, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  needs_follow_up BOOLEAN NOT NULL DEFAULT FALSE,
  converts_to_appointment BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE);

CREATE TABLE leads (
  id SERIAL PRIMARY KEY, name VARCHAR(160), mobile VARCHAR(20),
  status VARCHAR(100),
  created_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id));

CREATE TABLE lead_events (
  id          SERIAL PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status_name VARCHAR(100) NOT NULL,
  due_date    DATE NOT NULL,
  due_at      TIMESTAMPTZ,
  note        TEXT,
  is_done     BOOLEAN NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;

const TODAY = '2026-08-21';

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('followup (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const db = new Pool(DB);
  await db.query(SCHEMA);

  // ── Migration 170 is applied here, from the real file ────────────────────
  const before = await db.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'lead_events' AND column_name IN ('done_by','auto_closed')`);
  assert.strictEqual(before.rows[0].n, 0,
    'the test schema already has the 170 columns, so applying the migration proves nothing'); n++;

  for (const f of ['170_lead_events_done_by.sql', '171_lead_events_created_by.sql']) {
    const mig = fs.readFileSync(path.join(BE, 'db/migrations', f), 'utf8');
    await db.query(mig);
    // Applied twice: migrations get re-run against a database that already has
    // them more often than anybody plans for.
    await db.query(mig);
  }
  const c171 = await db.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'lead_events' AND column_name = 'created_by'`);
  assert.strictEqual(c171.rows[0].n, 1, '171 did not add created_by'); n++;

  const cols = await db.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'lead_events' AND column_name IN ('done_by','auto_closed')
      ORDER BY column_name`);
  assert.strictEqual(cols.rows.length, 2, '170 did not add both columns'); n++;
  const auto = cols.rows.find(r => r.column_name === 'auto_closed');
  assert.strictEqual(auto.is_nullable, 'NO',
    'auto_closed is nullable — NULL is neither TRUE nor FALSE in a FILTER, so those rows would '
    + 'vanish from every bucket at once'); n++;
  assert.match(auto.column_default, /false/,
    'auto_closed has no FALSE default, so every existing row becomes NULL and drops out of the reports'); n++;

  // ── Seed ─────────────────────────────────────────────────────────────────
  await db.query(`INSERT INTO users (name) VALUES ('Advisor')`);
  await db.query(`
    INSERT INTO lead_statuses (name, needs_follow_up, converts_to_appointment, is_locked, is_closed) VALUES
      ('New',       FALSE, FALSE, FALSE, FALSE),
      ('Attempt 1', TRUE,  FALSE, FALSE, FALSE),
      ('Booked',    FALSE, TRUE,  FALSE, FALSE),
      ('Lost',      FALSE, FALSE, TRUE,  TRUE ),
      -- closed but NOT locked: the case all four old filter copies missed
      ('Not Interested', FALSE, FALSE, FALSE, TRUE)`);
  await db.query(`
    INSERT INTO leads (name, status, created_by, assigned_to) VALUES
      ('Live lead',      'New',    1, 1),
      ('Converted lead', 'Booked', 1, 1),
      ('Lost lead',      'Lost',   1, 1),
      ('Closed lead',    'Not Interested', 1, 1)`);

  // One row per bucket, plus the two that used to be counted as work.
  await db.query(`
    INSERT INTO lead_events (lead_id, status_name, due_date, is_done, done_at, auto_closed) VALUES
      (1, 'Attempt 1', DATE '2026-08-01', TRUE,  TIMESTAMPTZ '2026-07-30', FALSE),  -- on_time
      (1, 'Attempt 1', DATE '2026-08-01', TRUE,  TIMESTAMPTZ '2026-08-05', FALSE),  -- late
      (1, 'Attempt 1', DATE '2026-08-01', FALSE, NULL,                     FALSE),  -- missed
      (1, 'Attempt 1', DATE '2026-08-01', TRUE,  TIMESTAMPTZ '2026-07-30', TRUE ),  -- auto (was on_time)
      (1, 'Attempt 1', DATE '2026-08-01', TRUE,  TIMESTAMPTZ '2026-08-05', TRUE ),  -- auto (was late)
      (1, 'Attempt 1', DATE '2099-01-01', FALSE, NULL,                     FALSE),  -- future
      (2, 'Attempt 1', DATE '2026-08-01', FALSE, NULL,                     FALSE),  -- CONVERTED lead
      (3, 'Attempt 1', DATE '2026-08-01', FALSE, NULL,                     FALSE),  -- LOCKED lead
      (4, 'Attempt 1', DATE '2026-08-01', FALSE, NULL,                     FALSE)`);// CLOSED, not locked

  // ── Compliance ───────────────────────────────────────────────────────────
  const complianceSQL = liftQuery('AS total_due,', {
    pOffset: 0, visibilitySQL: '', FINISHED_LEAD_SQL,
  });
  const c = (await db.query(complianceSQL, [TODAY])).rows[0];

  assert.strictEqual(c.on_time, 1,
    `on_time is ${c.on_time}, expected 1 — an auto-closed follow-up is counted as work somebody did`); n++;
  assert.strictEqual(c.late, 1,
    `late is ${c.late}, expected 1 — an auto-closed follow-up is counted as a late completion`); n++;
  assert.strictEqual(c.missed, 1, `missed is ${c.missed}, expected 1`); n++;
  assert.strictEqual(c.auto, 2,
    `auto is ${c.auto}, expected 2 — the auto-closed rows are not reported at all, so there is no way to `
    + 'tell a thin compliance rate from one whose follow-ups keep being overtaken by events'); n++;

  /* The rate gets its own assertion with the OLD value named, because it is the
     number a manager acts on. This same data produced 2/(2+2+1) = 40% before.
     Nobody did more work; two of those four completions were a dropdown. */
  const rate = Math.round((c.on_time / (c.on_time + c.late + c.missed)) * 100);
  assert.strictEqual(rate, 33,
    `compliance rate is ${rate}%, expected 33% — 40% is the inflated figure this change removes`); n++;

  assert.strictEqual(c.total_due, 5,
    `total_due is ${c.total_due}, expected 5 — a follow-up on a converted or locked lead has leaked back `
    + 'in, or the future-dated one is being counted as due'); n++;

  // ── Stats (what the Dashboard renders today) ─────────────────────────────
  const statsSQL = liftQuery('AS overdue_new,', { targetExtra: '', FINISHED_LEAD_SQL });
  const s = (await db.query(statsSQL, [TODAY, null, null, TODAY, TODAY])).rows[0];

  assert.strictEqual(s.completed, 2,
    `completed is ${s.completed}, expected 2 — an advisor's own "completed this week" is counting `
    + 'follow-ups that expired when somebody changed a status'); n++;
  assert.strictEqual(s.completed_total, 2, `completed_total is ${s.completed_total}, expected 2`); n++;
  /* The denominator has to drop them too. Removing auto rows from the numerator
     only would make the completion rate WORSE than before the fix — a fraction
     whose top and bottom count different populations. That is a subtler wrong
     answer than the one being fixed, and it would look like the change had
     backfired. */
  assert.strictEqual(s.total, 4,
    `total is ${s.total}, expected 4 — auto-closed rows are still in the completion-rate denominator`); n++;
  const cr = Math.round((s.completed_total / s.total) * 100);
  assert.strictEqual(cr, 50, `completion_rate is ${cr}%, expected 50% (67% was the inflated figure)`); n++;

  // The pending side must be untouched by any of this.
  assert.strictEqual(s.overdue, 1, `overdue is ${s.overdue}, expected 1`); n++;
  assert.strictEqual(s.upcoming, 1, `upcoming is ${s.upcoming}, expected 1`); n++;

  // ── Booking an appointment settles the follow-up ─────────────────────────
  //
  // Run as SQL, because the bug was that this statement did not exist in
  // appointments.controller.js at all — the string 'lead_events' appeared
  // nowhere in the file.
  const mAppt = APPT.match(
    /UPDATE lead_events\s+SET is_done = TRUE, done_at = NOW\(\), auto_closed = TRUE\s+WHERE lead_id = \$1 AND is_done = FALSE/);
  assert.ok(mAppt,
    'booking an appointment no longer closes the lead\'s follow-up — the row survives, hidden while the '
    + 'lead sits in a converting status, and returns as overdue the day somebody deletes the appointment'); n++;

  const openBefore = (await db.query(
    `SELECT count(*)::int AS n FROM lead_events WHERE lead_id = 1 AND is_done = FALSE`)).rows[0].n;
  assert.strictEqual(openBefore, 2, `expected 2 open follow-ups before booking, saw ${openBefore}`); n++;
  await db.query(mAppt[0], [1]);
  const after = (await db.query(
    `SELECT count(*) FILTER (WHERE NOT is_done)::int         AS still_open,
            count(*) FILTER (WHERE is_done AND auto_closed)::int AS auto
       FROM lead_events WHERE lead_id = 1`)).rows[0];
  assert.strictEqual(after.still_open, 0,
    `${after.still_open} follow-ups still open after the appointment was booked`); n++;
  assert.strictEqual(after.auto, 4,
    `booking marked follow-ups done but not auto_closed (${after.auto} of 4) — they would count as `
    + 'completed work, handing an advisor a free tick for every lead they convert'); n++;

  // ── The needs_follow_up guard, as SQL ────────────────────────────────────
  const mNf = LEADS.match(
    /SELECT name FROM lead_statuses\s+WHERE LOWER\(TRIM\(name\)\) = LOWER\(TRIM\(\$1\)\) AND needs_follow_up = TRUE\s+LIMIT 1/);
  assert.ok(mNf, 'the needs_follow_up guard is gone from updateLead'); n++;
  assert.strictEqual((await db.query(mNf[0], ['attempt 1'])).rows.length, 1,
    'the guard misses a status sent in different casing — leads.status holds the NAME, and a client can '
    + 'send whatever casing it read off a stale list'); n++;
  assert.strictEqual((await db.query(mNf[0], ['New'])).rows.length, 0,
    'the guard fires on a status that does NOT need a follow-up — every plain status change would 422'); n++;

  /* ── Every close-without-a-person is flagged ────────────────────────────
     Counted per file, because the failure mode is fixing four and missing the
     fifth — and a missed one is silent: those rows go straight back into
     on_time and the rate quietly climbs again. */
  const closes  = src => (src.match(/UPDATE lead_events\s+SET is_done = TRUE, done_at = NOW\(\)/g) || []).length;
  const flagged = src => (src.match(/UPDATE lead_events\s+SET is_done = TRUE, done_at = NOW\(\), auto_closed = TRUE/g) || []).length;

  for (const [name, src, expected] of [
    ['leads.controller.js',        LEADS,  3],
    ['import.controller.js',       IMPORT, 1],
    ['appointments.controller.js', APPT,   1],
  ]) {
    assert.strictEqual(flagged(src), expected,
      `${name} has ${flagged(src)} of ${expected} auto-closes marked auto_closed`); n++;
    assert.strictEqual(closes(src), flagged(src),
      `${name} closes a follow-up WITHOUT auto_closed = TRUE — it will be counted as work somebody did`); n++;
  }

  // markDone is the mirror image: the only place a human claims the work.
  const iDone = SRC.indexOf('function markDone(');
  const doneFn = SRC.slice(iDone, SRC.indexOf('\n}', iDone));
  assert.match(doneFn, /done_by = \$2/,
    'markDone does not record WHO completed the follow-up'); n++;
  assert.match(doneFn, /auto_closed = FALSE/,
    'markDone does not clear auto_closed, so ticking a previously auto-closed event leaves it excluded '
    + 'from the very report the tick was meant to feed'); n++;

  /* ── The bulk guard ──────────────────────────────────────────────────────
     Its own assertions, and the ones most worth having: bulkStatus closes the
     open follow-up on every selected lead BEFORE inserting the replacement, so
     a bulk move into a chase status with no date strips hundreds of follow-ups
     and schedules nothing — the largest version of this mistake available in
     one click. */
  const iBulk = LEADS.indexOf('function bulkStatus(');
  assert.ok(iBulk > -1, 'bulkStatus is gone'); n++;
  const bulkFn = LEADS.slice(iBulk, LEADS.indexOf('\nfunction ', iBulk + 10));
  assert.match(bulkFn, /target\.needs_follow_up && !follow_up_date/,
    'the bulk status change no longer requires a date for a status that needs a follow-up'); n++;
  assert.match(bulkFn, /FOLLOW_UP_REQUIRED/,
    'the bulk refusal has no machine-readable code, so a client cannot tell it from any other 422'); n++;
  // The flag has to be SELECTed or the check reads undefined and never fires.
  assert.match(bulkFn, /converts_to_appointment, needs_follow_up/,
    'needs_follow_up is not read from lead_statuses, so target.needs_follow_up is undefined and the '
    + 'guard is dead code that always passes'); n++;

  /* ── A closed status is finished, even when nobody ticked "locked" ────────
     All four old copies of this filter tested converts_to_appointment and
     is_locked only. The current status set hides that, because 'Lost' carries
     all three flags — so the seed above adds one that does not: 'Not
     Interested', closed but unlocked, with an overdue follow-up on it. Under
     the old rule that lead's chase sat in the list forever. */
  const closedLeak = await db.query(
    `SELECT count(*)::int AS n FROM lead_events e JOIN leads l ON l.id = e.lead_id
      WHERE l.status = 'Not Interested' ${FINISHED_LEAD_SQL}`);
  assert.strictEqual(closedLeak.rows[0].n, 0,
    'a follow-up on a lead whose status is CLOSED but not locked is still in the chase list — the '
    + 'filter is only testing converts_to_appointment and is_locked'); n++;

  /* ── The clock ────────────────────────────────────────────────────────────
     The pool session runs on Asia/Kolkata, so `done_at::date` answers in IST.
     This row is completed at 02:00 IST the DAY AFTER it was due, which is late.
     On UTC that instant renders as 20:30 the previous day — the due date itself
     — and the old code counted it on_time. Every follow-up finished in the
     small hours was being scored a day early, always in the flattering
     direction. */
  await db.query(`
    INSERT INTO lead_events (lead_id, status_name, due_date, is_done, done_at, auto_closed)
    VALUES (1, 'Attempt 1', DATE '2026-08-01', TRUE, TIMESTAMPTZ '2026-08-02 02:00:00+05:30', FALSE)`);
  const tz = (await db.query(complianceSQL, [TODAY])).rows[0];
  assert.strictEqual(tz.late, 2,
    `late is ${tz.late}, expected 2 — a follow-up completed at 2am IST the day AFTER it was due is `
    + 'being dated in UTC, which puts it back on the due date and scores it on_time'); n++;
  assert.strictEqual(tz.on_time, 1,
    `on_time is ${tz.on_time}, expected 1 — the 2am completion has leaked into the on-time bucket`); n++;

  const sess = await db.query(`SELECT current_setting('TimeZone') AS tz`);
  assert.strictEqual(sess.rows[0].tz, 'Asia/Kolkata',
    'the connection is not on IST, so every ::date in this suite answered in the wrong zone'); n++;
  // And the app's own pool must ask for it — in the startup packet, not a SET.
  /* Comments stripped first. Without that, this pair matched the PROSE in
     db.js explaining why a per-connection SET is the wrong approach — a test
     that reads the argument for a decision and reports it as the decision. */
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const DBCFG = strip(fs.readFileSync(path.join(BE, 'src/config/db.js'), 'utf8'));
  assert.match(DBCFG, /options:\s*'-c timezone=Asia\/Kolkata'/,
    'src/config/db.js no longer pins the session timezone, so every ::date in the app is back on UTC'); n++;
  assert.ok(!/SET TIME ZONE/i.test(DBCFG),
    'the timezone is being set with a per-connection SET — a pool opens connections on its own '
    + 'schedule, so one missed reconnect means one query, occasionally, answering in UTC'); n++;

  // Node's clock too: this is what decides that a 09:00 follow-up means 09:00.
  assert.strictEqual(new Date('2026-08-25T09:00:00').toISOString(), '2026-08-25T03:30:00.000Z',
    'a zoneless 09:00 is still being read as UTC, so every morning follow-up is filed at 2:30pm IST — '
    + 'which is what the code has always done despite its comment saying otherwise'); n++;
  for (const f of ['src/server.js', 'db/migrate.js']) {
    assert.match(fs.readFileSync(path.join(BE, f), 'utf8'), /applyProcessTimezone\(\)/,
      `${f} does not set the process timezone`); n++;
  }

  // The date helpers, including the boundaries that make them worth having.
  assert.strictEqual(istToday(new Date('2026-08-25T00:30:00+05:30')), '2026-08-25',
    'istToday returns the UTC date for an instant just after IST midnight'); n++;
  assert.strictEqual(istAddDays('2026-12-31', 1), '2027-01-01', 'istAddDays breaks over a year end'); n++;
  assert.strictEqual(istAddDays('2028-02-28', 1), '2028-02-29', 'istAddDays breaks on a leap day'); n++;
  assert.strictEqual(istWeekday('2026-08-23'), 0, 'istWeekday does not report Sunday as 0'); n++;
  assert.strictEqual(istEndOfDayISO('2026-08-25'), '2026-08-25T18:29:59.999Z',
    'end of an IST day is not being converted to the right instant'); n++;

  /* ── markDone is scoped ───────────────────────────────────────────────────
     The controller is invoked for real rather than having its SQL lifted: the
     scope is built in JavaScript from req.user, so a string test would prove
     only that some text exists. */
  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;
  const events = require(path.join(BE, 'src/controllers/lead_events.controller'));

  await db.query(`INSERT INTO users (name) VALUES ('Other advisor')`);           // id 2
  await db.query(`INSERT INTO leads (name, status, created_by, assigned_to)
                  VALUES ('Somebody else''s lead', 'New', 2, 2)`);               // id 5
  const foreign = (await db.query(
    `INSERT INTO lead_events (lead_id, status_name, due_date)
     VALUES (5, 'Attempt 1', DATE '2026-08-01') RETURNING id`)).rows[0].id;

  const call = (id, user) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
    events.markDone({ params: { id: String(id) }, user }, res, e => resolve({ code: 500, body: { error: e.message } }));
  });
  const advisor = { id: 1, is_super_admin: false, permissions: new Set(['VIEW_OWN_LEADS']) };
  const admin2  = { id: 1, is_super_admin: true,  permissions: new Set() };

  const denied = await call(foreign, advisor);
  assert.strictEqual(denied.code, 404,
    `an advisor closed a follow-up on a lead belonging to somebody else (HTTP ${denied.code}) — the `
    + 'read endpoints are all scoped and the one WRITE was scoped by nothing at all'); n++;
  const stillOpen = (await db.query(`SELECT is_done, done_by FROM lead_events WHERE id = $1`, [foreign])).rows[0];
  assert.strictEqual(stillOpen.is_done, false,
    'the row was closed anyway — the 404 is cosmetic and the UPDATE still ran'); n++;
  assert.strictEqual(stillOpen.done_by, null,
    'somebody else\'s follow-up now carries this user\'s name against it'); n++;

  // The other half of the rule: the advisor's OWN follow-up still works.
  const mine = (await db.query(
    `INSERT INTO lead_events (lead_id, status_name, due_date)
     VALUES (1, 'Attempt 1', DATE '2026-08-01') RETURNING id`)).rows[0].id;
  const ok = await call(mine, advisor);
  assert.strictEqual(ok.code, 200,
    `an advisor cannot tick their own follow-up (HTTP ${ok.code}) — the scope is too tight and the `
    + 'feature is broken for everybody without VIEW_LEAD'); n++;
  const done = (await db.query(`SELECT is_done, done_by, auto_closed FROM lead_events WHERE id = $1`, [mine])).rows[0];
  assert.strictEqual(done.done_by, 1, 'done_by was not recorded on a real completion'); n++;
  assert.strictEqual(done.auto_closed, false, 'a hand-ticked follow-up is flagged auto_closed'); n++;

  // A super admin reaches anything, which is the point of the flag.
  assert.strictEqual((await call(foreign, admin2)).code, 200,
    'a super admin cannot close a follow-up they can plainly see'); n++;

  /* ── Deleting an appointment gives the lead a follow-up back ──────────────
     The regression this whole round introduced. Booking now closes the chase;
     deleting the appointment returns the lead to the status it came from —
     usually one that needs chasing — and without this it lands there with
     nothing scheduled and no way to notice, because the Follow-up list is built
     from OPEN rows. */
  const iUn = APPT.indexOf('Appointment deleted');
  const unconvert = APPT.slice(Math.max(0, iUn - 4000), iUn);
  assert.match(unconvert, /needs_follow_up = TRUE AND is_active = TRUE/,
    'the un-convert path does not check whether the status it returns the lead to needs a follow-up'); n++;
  assert.match(unconvert, /INSERT INTO lead_events[\s\S]{0,200}CURRENT_DATE/,
    'the un-convert path schedules no follow-up, so a lead whose appointment was deleted sits in a '
    + 'chase status with nobody chasing it and nothing on any list'); n++;
  assert.ok(!/due_date\s*=\s*back\.|old_due/.test(unconvert),
    'the un-convert path revives the ORIGINAL due date — a months-old reminder for a call that stopped '
    + 'being owed when the customer booked'); n++;
  // The guard against a second open row.
  assert.match(unconvert, /SELECT 1 FROM lead_events WHERE lead_id = \$1 AND is_done = FALSE/,
    'nothing stops a second open follow-up being created, which would list the lead twice'); n++;

  /* ── Who scheduled it ─────────────────────────────────────────────────────
     Both insert sites, counted. One is the single-lead update and one is the
     bulk path; missing either leaves a whole route writing anonymous rows. */
  const inserts = (LEADS.match(/INSERT INTO lead_events \(lead_id, status_name, due_date, due_at, note, created_by\)/g) || []).length;
  assert.strictEqual(inserts, 2,
    `${inserts} of 2 follow-up inserts record who scheduled them`); n++;
  assert.ok(!/INSERT INTO lead_events \(lead_id, status_name, due_date, due_at, note\)\s/.test(LEADS),
    'a follow-up insert still omits created_by'); n++;
  assert.match(SRC, /cu\.name AS created_by_name/,
    'the follow-up list does not return who scheduled it, so the column is written and never read'); n++;

  await db.end();
  console.log(`followup (postgres): ${n} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
