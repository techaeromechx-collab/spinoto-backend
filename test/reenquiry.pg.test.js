/**
 * Where a RETURNING customer's new lead lands, against a REAL PostgreSQL.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 *
 * Migration 156 stopped a closed lead swallowing new messages: a customer
 * marked Lost in March who messages in August gets a fresh lead. Migration 161
 * finishes the job by putting that fresh lead somewhere that says what it is,
 * and it distinguishes two people the pipeline used to show identically:
 *
 *   re-enquiry        their old lead was CLOSED. A sale that did not work.
 *   repeat customer   they have had a job done. Revenue that did.
 *
 * ── And a bug it fixes on the way ───────────────────────────────────────────
 *
 * leads.status stores the status NAME (migration 013 turned the enum into
 * VARCHAR(100)) and nothing stores the id. Renaming a status on the Master Data
 * screen therefore orphaned every lead wearing the old name — and because a
 * status with no matching row is deliberately treated as OPEN, renaming "Lost"
 * silently resurrected every Lost lead and sent their next WhatsApp message
 * back onto the dead one. The last section of this suite is that scenario,
 * end to end.
 *
 * ── Every schema block is quoted, not invented ──────────────────────────────
 *
 * A sibling suite once passed 63 checks against a query that could not run in
 * production, because the test schema had made up a convenient column. Each
 * CREATE TABLE here is copied from the migration that owns it.
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
const DBNAME = 'spinoto_reenquiry_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };
let n = 0;

const SCHEMA = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE, is_active BOOLEAN NOT NULL DEFAULT TRUE);

-- db/schema.sql, trimmed. status is VARCHAR(100) holding the status NAME —
-- migration 013 — which is the fact the rename section below turns on.
CREATE TABLE leads (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(160),
  mobile       VARCHAR(20) NOT NULL,
  whatsapp     VARCHAR(20),
  lead_source  VARCHAR(80),
  status       VARCHAR(100),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  public_token VARCHAR(20),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 155's two expression indexes, verbatim. Present so the query plan
-- under test is the one production uses, not a sequential scan that happens to
-- return the same rows.
CREATE INDEX idx_leads_mobile_national
  ON leads (RIGHT(regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g'), 10));
CREATE INDEX idx_leads_whatsapp_national
  ON leads (RIGHT(regexp_replace(COALESCE(whatsapp, ''), '\\D', '', 'g'), 10))
  WHERE whatsapp IS NOT NULL;

-- migration 013 + 037 + 156 + 161
CREATE TABLE lead_statuses (
  id                      SERIAL PRIMARY KEY,
  name                    VARCHAR(100) NOT NULL,
  color                   VARCHAR(10) NOT NULL DEFAULT '#6b7280',
  bg_color                VARCHAR(10) NOT NULL DEFAULT '#f3f4f6',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  is_default              BOOLEAN NOT NULL DEFAULT FALSE,
  needs_follow_up         BOOLEAN NOT NULL DEFAULT FALSE,
  converts_to_appointment BOOLEAN NOT NULL DEFAULT FALSE,
  is_pipeline             BOOLEAN NOT NULL DEFAULT TRUE,
  logs_call               BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked               BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed               BOOLEAN NOT NULL DEFAULT FALSE,
  is_reenquiry            BOOLEAN NOT NULL DEFAULT FALSE,
  is_repeat_customer      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE UNIQUE INDEX idx_lead_statuses_reenquiry
  ON lead_statuses ((TRUE)) WHERE is_reenquiry;
CREATE UNIQUE INDEX idx_lead_statuses_repeat
  ON lead_statuses ((TRUE)) WHERE is_repeat_customer;

-- migration 039
CREATE TABLE lead_activities (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, old_value TEXT, new_value TEXT, note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 037
CREATE TABLE lead_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status_name VARCHAR(100) NOT NULL,
  due_date DATE NOT NULL, due_at TIMESTAMPTZ, note TEXT,
  is_done BOOLEAN NOT NULL DEFAULT FALSE, done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 021 + 084. lead_id is NULLABLE and that is the point: a walk-in has
-- no lead, and a walk-in who later messages on WhatsApp is the most obviously
-- repeat customer there is.
CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_name VARCHAR(160),
  mobile VARCHAR(20) NOT NULL,
  whatsapp VARCHAR(20),
  scheduled_date DATE NOT NULL,
  appointment_code VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE INDEX idx_appointments_mobile_national
  ON appointments (RIGHT(regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g'), 10));
CREATE INDEX idx_appointments_whatsapp_national
  ON appointments (RIGHT(regexp_replace(COALESCE(whatsapp, ''), '\\D', '', 'g'), 10))
  WHERE whatsapp IS NOT NULL;

-- migration 026. mobile IS the primary key here — there is no surrogate id,
-- which is why waInboundLead.service.js has no ORDER BY on this lookup.
CREATE TABLE customer_profiles (
  mobile VARCHAR(20) PRIMARY KEY,
  display_name VARCHAR(160),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE);

-- migration 113
CREATE TABLE wa_conversations (
  id SERIAL PRIMARY KEY,
  mobile VARCHAR(20) NOT NULL UNIQUE,
  lead_id INTEGER,
  assigned_user_id INTEGER REFERENCES users(id),
  customer_name VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

INSERT INTO lead_statuses (name, sort_order, is_closed) VALUES
  ('Follow-Up',             1, FALSE),
  ('Appointment Completed', 2, FALSE),
  ('Lost',                  3, TRUE),
  ('Junk',                  4, TRUE);
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('reenquiry (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;

  // The statuses controller emits an invalidate on save. There is no socket
  // server in a test process, so getIO() is replaced BEFORE the controller is
  // loaded — the alternative is starting a real io just to watch it emit into
  // nothing.
  const socketPath = require.resolve(path.join(BE, 'src/socket'));
  require.cache[socketPath] = {
    id: socketPath, filename: socketPath, loaded: true,
    exports: { getIO: () => ({ emit() {} }) },
  };

  const { pool } = require(path.join(BE, 'src/config/db'));
  const svc  = require(path.join(BE, 'src/services/waInboundLead.service'));
  const ctrl = require(path.join(BE, 'src/controllers/lead_statuses.controller'));

  await pool.query(SCHEMA);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const statusId = async name => (await pool.query(
    `SELECT id FROM lead_statuses WHERE name = $1`, [name])).rows[0].id;

  /** Tick one of the two destination flags, clearing whoever held it. */
  async function flag(col, name) {
    await pool.query(`UPDATE lead_statuses SET ${col} = FALSE WHERE ${col}`);
    if (name) await pool.query(`UPDATE lead_statuses SET ${col} = TRUE WHERE name = $1`, [name]);
  }

  /** One inbound message, exactly as applyInbound drives it. */
  async function inbound(e164, { name = null, body = 'Interested' } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO wa_conversations (mobile, customer_name) VALUES ($1,$2)
         ON CONFLICT (mobile) DO NOTHING`, [e164, name]);
      const t = await svc.resolveOrCreateLead(client, { e164, name, firstMessage: body });
      await client.query('COMMIT');
      return t;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  const leadRow = async id => (await pool.query(
    `SELECT status, notes, lead_source FROM leads WHERE id = $1`, [id])).rows[0];

  /** A lead that already exists, on a given status. */
  async function seedLead(mobile, status, { whatsapp = null } = {}) {
    const r = await pool.query(
      `INSERT INTO leads (name, mobile, whatsapp, status) VALUES ('Old lead',$1,$2,$3) RETURNING id`,
      [mobile, whatsapp, status]);
    return r.rows[0].id;
  }

  // Both destinations exist for most of the suite.
  await flag('is_reenquiry', 'Follow-Up');
  await flag('is_repeat_customer', 'Appointment Completed');

  // ══ 1. A stranger is still a stranger ════════════════════════════════════
  //
  // Nothing about this change may touch a first-time enquiry. status NULL is
  // what leads.controller.js means by "New Lead"; there is no 'New' row to
  // write, and writing the string would produce a lead no filter recognises.
  {
    const t = await inbound('+919000010001', { name: 'Brand New' });
    assert.strictEqual(t.createdLead, true);                     n++;
    assert.strictEqual(t.returning, null);                       n++;
    const row = await leadRow(t.leadId);
    assert.strictEqual(row.status, null);                        n++;
    assert.strictEqual(row.lead_source, 'WhatsApp');             n++;
    assert.match(row.notes, /^First WhatsApp message:/);         n++;
  }

  // ══ 2. Their old lead was Lost — a re-enquiry ════════════════════════════
  {
    const old = await seedLead('9000010002', 'Lost');
    const t = await inbound('+919000010002');

    assert.strictEqual(t.createdLead, true, 'a closed lead must not be reused'); n++;
    assert.notStrictEqual(t.leadId, old);                        n++;
    assert.strictEqual(t.returning, 'reenquiry');                n++;

    const row = await leadRow(t.leadId);
    assert.strictEqual(row.status, 'Follow-Up');                 n++;
    // The sentence that answers "why is this person in here twice", and it is
    // FIRST — under a 2000-character form-fill it would not be read.
    assert.ok(row.notes.startsWith(`Re-enquiry — previous lead #${old} was Lost.`),
      row.notes.slice(0, 80));                                   n++;
    assert.match(row.notes, /First WhatsApp message:/);          n++;

    // The old lead is left exactly as it was. Nothing reopens it.
    const before = await pool.query(`SELECT status FROM leads WHERE id = $1`, [old]);
    assert.strictEqual(before.rows[0].status, 'Lost');           n++;
  }

  // ══ 3. They have had a job done — a repeat customer ══════════════════════
  {
    const old = await seedLead('9000010003', 'Lost');
    await pool.query(
      `INSERT INTO appointments (lead_id, mobile, scheduled_date, appointment_code)
       VALUES ($1, '+91 90000 10003', DATE '2026-03-12', 'APT-000123')`, [old]);

    const t = await inbound('+919000010003');
    // Repeat beats re-enquiry even though the old lead is Lost: what they are
    // to you is a customer, and the lost quote is one episode inside that.
    assert.strictEqual(t.returning, 'repeat');                   n++;
    const row = await leadRow(t.leadId);
    assert.strictEqual(row.status, 'Appointment Completed');     n++;
    assert.ok(row.notes.startsWith('Repeat customer — last visit 2026-03-12 (APT-000123).'),
      row.notes.slice(0, 80));                                   n++;
  }

  // ══ 4. A walk-in, with no lead at all ════════════════════════════════════
  //
  // appointments.lead_id is nullable and this is why the lookup is on the
  // NUMBER. Going through leads would miss every walk-in.
  {
    await pool.query(
      `INSERT INTO appointments (lead_id, mobile, scheduled_date, appointment_code)
       VALUES (NULL, '9000010004', DATE '2026-01-05', 'APT-000090')`);
    const t = await inbound('+919000010004');
    assert.strictEqual(t.returning, 'repeat');                   n++;
    assert.strictEqual((await leadRow(t.leadId)).status, 'Appointment Completed'); n++;
  }

  //    …and one booked under a different WhatsApp number.
  {
    await pool.query(
      `INSERT INTO appointments (mobile, whatsapp, scheduled_date)
       VALUES ('0000000000', '+919000010005', DATE '2026-02-02')`);
    const t = await inbound('+919000010005');
    assert.strictEqual(t.returning, 'repeat');                   n++;
  }

  // ══ 5. On file as a customer, with no appointment row ════════════════════
  //
  // A profile exists because they were served. Whether the appointment row
  // survived a tidy-up is not something the customer should be able to feel.
  {
    await pool.query(
      `INSERT INTO customer_profiles (mobile, display_name) VALUES ('9000010006','Rajeev Mundra')`);
    const t = await inbound('+919000010006');
    assert.strictEqual(t.returning, 'repeat');                   n++;
    assert.strictEqual(t.matchedCustomer, true);                 n++;
    // Their real name beats "(no name)" — a returning customer rarely re-types it.
    const nm = await pool.query(`SELECT name FROM leads WHERE id = $1`, [t.leadId]);
    assert.strictEqual(nm.rows[0].name, 'Rajeev Mundra');        n++;
  }

  // ══ 6. An OPEN lead is still just attached to ════════════════════════════
  //
  // The load-bearing negative. None of this may fire when the customer already
  // has a live lead — no new lead, and above all no status change on the one
  // they are working.
  {
    const open = await seedLead('9000010007', 'Follow-Up');
    await pool.query(`UPDATE leads SET status = 'Junk' WHERE id = $1`, [open]);
    await pool.query(`UPDATE leads SET status = 'Follow-Up' WHERE id = $1`, [open]);

    const t = await inbound('+919000010007');
    assert.strictEqual(t.createdLead, false);                    n++;
    assert.strictEqual(t.leadId, open);                          n++;
    assert.strictEqual((await leadRow(open)).status, 'Follow-Up'); n++;
    // No note bolted onto a live lead either.
    assert.strictEqual((await leadRow(open)).notes, null);       n++;
  }

  // ══ 7. Nothing ticked → exactly the old behaviour ════════════════════════
  //
  // This is what ships. Migration 161 seeds no flag, so until somebody decides
  // where these should point, the code must be inert.
  {
    await flag('is_reenquiry', null);
    await flag('is_repeat_customer', null);

    await seedLead('9000010008', 'Lost');
    const t = await inbound('+919000010008');
    assert.strictEqual(t.returning, 'reenquiry');                n++;
    assert.strictEqual((await leadRow(t.leadId)).status, null,
      'with no status ticked a re-enquiry must still be a plain New Lead'); n++;
    // The trail line is still written — it costs nothing and answers the
    // duplicate question whether or not a status was configured.
    assert.match((await leadRow(t.leadId)).notes, /^Re-enquiry — previous lead #/); n++;
  }

  // ══ 8. Only ONE of the two ticked ════════════════════════════════════════
  //
  // The fallback leans one way on purpose.
  {
    await flag('is_reenquiry', 'Follow-Up');
    await flag('is_repeat_customer', null);

    await pool.query(
      `INSERT INTO appointments (mobile, scheduled_date) VALUES ('9000010009', DATE '2026-04-01')`);
    const t = await inbound('+919000010009');
    // A repeat customer with no repeat status falls back to the re-enquiry one.
    // Slightly wrong, much better than blank: ticking one box said "mark
    // returning customers", and New Lead would ignore that.
    assert.strictEqual(t.returning, 'repeat');                   n++;
    assert.strictEqual((await leadRow(t.leadId)).status, 'Follow-Up'); n++;
  }
  {
    await flag('is_reenquiry', null);
    await flag('is_repeat_customer', 'Appointment Completed');

    await seedLead('9000010010', 'Junk');
    const t = await inbound('+919000010010');
    // The reverse does NOT apply. Calling somebody who has never paid you a
    // repeat customer is a different kind of wrong — one that ends up in front
    // of them.
    assert.strictEqual(t.returning, 'reenquiry');                n++;
    assert.strictEqual((await leadRow(t.leadId)).status, null);  n++;
  }

  // ══ 9. Only one status may hold each flag ════════════════════════════════
  {
    await flag('is_reenquiry', 'Follow-Up');
    await assert.rejects(
      () => pool.query(`UPDATE lead_statuses SET is_reenquiry = TRUE WHERE name = 'Lost'`),
      /duplicate key|unique/i,
      'two statuses must not both be the re-enquiry destination');            n++;
  }

  // ══ 10. Renaming a status carries its leads with it ══════════════════════
  //
  // The silent bug. leads.status stores the NAME, so a rename used to leave
  // every lead on a string matching no row — and a status with no row is
  // treated as OPEN by design.
  {
    await flag('is_reenquiry', 'Follow-Up');
    await flag('is_repeat_customer', null);

    const lost = await seedLead('9000010011', 'Lost');
    // History and a follow-up card, both keyed on the name.
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value)
       VALUES ($1,'status_changed','Follow-Up','Lost'), ($1,'created',NULL,'Lost')`, [lost]);
    // …and one row that merely CONTAINS the same text in a different meaning.
    // An unscoped rewrite would quietly edit somebody's assignment history.
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value)
       VALUES ($1,'assigned_changed','Lost','Lost')`, [lost]);
    await pool.query(
      `INSERT INTO lead_events (lead_id, status_name, due_date)
       VALUES ($1,'Lost', CURRENT_DATE)`, [lost]);

    // Counted rather than hardcoded: earlier sections in this suite also left
    // leads on Lost, and the point is that EVERY one of them travels — a test
    // asserting "1" would pass while three were left behind.
    const wearingIt = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM leads WHERE status = 'Lost'`)).rows[0].n);
    assert.ok(wearingIt > 1, 'the fixture should have several leads on Lost'); n++;

    const id = await statusId('Lost');
    const out = await new Promise((resolve, reject) => {
      ctrl.updateStatus(
        { params: { id: String(id) }, body: { name: 'Lost Lead' } },
        { status() { return this; }, json: resolve },
        reject);
    });

    assert.strictEqual(out.item.name, 'Lost Lead');               n++;
    assert.strictEqual(out.leads_relabelled, wearingIt);          n++;
    assert.strictEqual(Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM leads WHERE status = 'Lost'`)).rows[0].n), 0,
      'not one lead may be left holding the old name');                 n++;
    assert.strictEqual((await leadRow(lost)).status, 'Lost Lead'); n++;

    const hist = await pool.query(
      `SELECT type, old_value, new_value FROM lead_activities WHERE lead_id = $1 ORDER BY id`, [lost]);
    assert.deepStrictEqual(hist.rows[0], { type: 'status_changed', old_value: 'Follow-Up', new_value: 'Lost Lead' }); n++;
    assert.deepStrictEqual(hist.rows[1], { type: 'created', old_value: null, new_value: 'Lost Lead' }); n++;
    // Untouched — a user called "Lost" is not a status.
    assert.deepStrictEqual(hist.rows[2], { type: 'assigned_changed', old_value: 'Lost', new_value: 'Lost' }); n++;

    const ev = await pool.query(`SELECT status_name FROM lead_events WHERE lead_id = $1`, [lost]);
    assert.strictEqual(ev.rows[0].status_name, 'Lost Lead');      n++;
  }

  // ══ 11. …so the rename does not resurrect them ═══════════════════════════
  //
  // The whole reason the cascade matters. Before it, the lead above would have
  // been holding "Lost" against a table that no longer had it, counted as
  // OPEN, and this message would have landed on the dead lead — invisible,
  // with the system looking like it had worked.
  {
    const t = await inbound('+919000010011');
    assert.strictEqual(t.createdLead, true,
      'a renamed closed status must still be closed');            n++;
    assert.strictEqual(t.returning, 'reenquiry');                 n++;
    assert.match((await leadRow(t.leadId)).notes, /was Lost Lead\./); n++;
  }

  //     …and renaming only the capitalisation is still carried.
  {
    const id = await statusId('Junk');
    const lead = await seedLead('9000010012', 'Junk');
    await new Promise((resolve, reject) => {
      ctrl.updateStatus({ params: { id: String(id) }, body: { name: 'JUNK' } },
        { status() { return this; }, json: resolve }, reject);
    });
    assert.strictEqual((await leadRow(lead)).status, 'JUNK');     n++;
  }

  // ══ 12. Schema drift guard ═══════════════════════════════════════════════
  {
    const src = require('fs').readFileSync(
      path.join(BE, 'src/services/waInboundLead.service.js'), 'utf8');
    // The SQL only. A whole-file scan reports JS property access that merely
    // looks like a column, and a guard that cries wolf gets deleted.
    const sql = (src.match(/`[^`]*`/g) || [])
      .filter(t => /\b(SELECT|INSERT|UPDATE)\b/.test(t))
      .join('\n').replace(/--[^\n]*/g, '');
    const TABLE = { l: 'leads', ls: 'lead_statuses', ap: 'appointments', c: 'wa_conversations' };
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
      'the inbound lead rule reads columns this database does not have'); n++;

    // A status name must survive the column that stores it on the lead.
    const w = await pool.query(
      `SELECT character_maximum_length AS n FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'status'`);
    const longest = await pool.query(
      `SELECT COALESCE(MAX(LENGTH(name)), 0) AS n FROM lead_statuses`);
    assert.ok(Number(longest.rows[0].n) <= Number(w.rows[0].n));  n++;
  }

  await pool.end();
  console.log(`reenquiry (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
