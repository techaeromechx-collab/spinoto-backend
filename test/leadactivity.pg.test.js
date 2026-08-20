/**
 * The Recent Activity column on the Leads page, against a REAL PostgreSQL.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * The column worked for about a second and then went blank on every refresh.
 *
 * leads.controller.js has TWO select fragments over the same table: LEAD_SELECT
 * for a single lead, and a separate LIST_SELECT built inside listLeads. The
 * LATERAL that finds the last activity was only ever in the first one — and the
 * Recent Activity column is rendered ONLY by the list. So:
 *
 *   change a status  → PATCH responds from LEAD_SELECT, which HAS the columns,
 *                      and the browser merges that row into the table → shown
 *   refresh          → GET /api/leads runs LIST_SELECT, which does not →  "—"
 *
 * Two queries over one table drifting apart is invisible in review and obvious
 * to whoever uses the screen. The fix is one definition used by both, and this
 * suite is what stops them separating again: it runs the REAL endpoints against
 * real rows and asserts they agree, field for field.
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
const DBNAME = 'spinoto_leadactivity_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };
let n = 0;

const SCHEMA = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE, manager_id INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE);

CREATE TABLE leads (
  id SERIAL PRIMARY KEY, public_token VARCHAR(20),
  name VARCHAR(160), mobile VARCHAR(20) NOT NULL, whatsapp VARCHAR(20),
  status VARCHAR(100), total_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  priority VARCHAR(10) NOT NULL DEFAULT 'normal', tags TEXT[] DEFAULT '{}',
  lead_source VARCHAR(80), lost_reason TEXT, notes TEXT,
  state_id INT, city_id INT, area_id INT, vehicle_type_id INT, make_id INT,
  model_id INT, body_type_id INT, segment_ids INTEGER[] DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 039, with its indexes: the LATERAL is only cheap because of these.
CREATE TABLE lead_activities (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, old_value TEXT, new_value TEXT, note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id, created_at ASC);

CREATE TABLE lead_notes (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);

-- Everything the two SELECTs join to. Present so the queries under test are
-- the ones production runs rather than a trimmed rewrite of them.
CREATE TABLE states         (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE cities         (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE areas          (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE vehicle_types  (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE vehicle_makes  (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE vehicle_models (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE body_types     (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE segments       (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE services (id SERIAL PRIMARY KEY, name TEXT,
  category_id INTEGER REFERENCES service_categories(id));
CREATE TABLE lead_services (id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id), price NUMERIC(12,2));
CREATE TABLE lead_categories (id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES service_categories(id));
CREATE TABLE appointments (id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL);
CREATE TABLE lead_events (id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  status_name VARCHAR(100), due_date DATE, due_at TIMESTAMPTZ,
  is_done BOOLEAN NOT NULL DEFAULT FALSE, done_at TIMESTAMPTZ);
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('leadactivity (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;
  const { pool } = require(path.join(BE, 'src/config/db'));
  const ctrl = require(path.join(BE, 'src/controllers/leads.controller'));

  await pool.query(SCHEMA);

  // ── Helpers ──────────────────────────────────────────────────────────────

  // A full-access user: the scope filters are a different suite's problem, and
  // narrowing them here would only hide the columns under test.
  const REQ_USER = { id: 1, is_super_admin: true, permissions: new Set() };

  /** GET /api/leads — the query that feeds the table. */
  const list = () => new Promise((resolve, reject) =>
    ctrl.listLeads({ query: {}, user: REQ_USER },
      { json: resolve, status() { return this; } }, reject));

  /** GET /api/leads/:id — the query behind the detail page and the PATCH reply. */
  const one = id => new Promise((resolve, reject) =>
    ctrl.getLead({ params: { id: String(id) }, query: {}, user: REQ_USER },
      // getLead answers { item: {...} }; unwrapped here so a comparison against
      // a list row is comparing two lead rows rather than a row and an envelope.
      { json: r => resolve(r.item), status() { return this; } }, reject));

  const ACT = ['last_activity_type', 'last_activity_old', 'last_activity_new',
               'last_activity_at', 'last_activity_by'];
  const activityOf = row => Object.fromEntries(ACT.map(k => [k, row[k]]));

  // Ids pinned rather than captured: the fixtures below name them directly, and
  // a test that has to thread an id through six inserts stops being readable.
  await pool.query(`INSERT INTO users (id, name, email) VALUES
    (1,'Raj','raj@x.test'), (2,'Aman','aman@x.test')`);

  const lead = async name => (await pool.query(
    `INSERT INTO leads (name, mobile, status, created_by) VALUES ($1,'9999900000','Follow-Up',1)
     RETURNING id`, [name])).rows[0].id;

  // ══ 1. A lead with nothing on it ═════════════════════════════════════════
  //
  // The empty case has to be a real null, not a missing key: the column renders
  // "—" on `!row.last_activity_at`, and `undefined` would look identical while
  // meaning "this query does not select it".
  {
    const id = await lead('Quiet lead');
    const rows = (await list()).items;
    const row = rows.find(r => r.id === id);

    for (const k of ACT) {
      assert.ok(k in row, `${k} must be SELECTed by the list query, not absent`); n++;
      assert.strictEqual(row[k], null);                          n++;
    }
  }

  // ══ 2. The reported bug, end to end ══════════════════════════════════════
  //
  // Change a status, then read the list — which is what a refresh does.
  {
    const id = await lead('Status changer');
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
       VALUES ($1,'status_changed','Follow-Up','Lost',1)`, [id]);

    const row = (await list()).items.find(r => r.id === id);
    assert.ok(row.last_activity_at, 'the list must carry the activity after a refresh'); n++;
    assert.strictEqual(row.last_activity_type, 'status_changed'); n++;
    assert.strictEqual(row.last_activity_old, 'Follow-Up');       n++;
    assert.strictEqual(row.last_activity_new, 'Lost');            n++;
    // The name, which needs the second join. Without it the cell shows the
    // change but not who made it, which is the half that gets asked about.
    assert.strictEqual(row.last_activity_by, 'Raj');              n++;

    // ── And the two queries agree ──────────────────────────────────────────
    //
    // This is the assertion that would have caught the bug. The row the PATCH
    // hands back is built by getLead's SELECT; the row a refresh shows is built
    // by the list's. When they disagree, the column changes under the user for
    // no reason they can see.
    const detail = await one(id);
    assert.deepStrictEqual(activityOf(row), activityOf(detail));  n++;
  }

  // ══ 3. A note is newer than the status change ════════════════════════════
  //
  // Both sources feed the column. Reading only lead_activities would show
  // Tuesday's status change on a lead somebody wrote a note on this morning —
  // worse than showing nothing, because it looks current.
  {
    const id = await lead('Noted lead');
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by, created_at)
       VALUES ($1,'status_changed','Follow-Up','Lost',1, NOW() - INTERVAL '2 days')`, [id]);
    await pool.query(
      `INSERT INTO lead_notes (lead_id, note, created_by) VALUES ($1,$2,2)`,
      [id, 'Customer called back, wants a quote for the front bumper as well']);

    const row = (await list()).items.find(r => r.id === id);
    assert.strictEqual(row.last_activity_type, 'note_added');     n++;
    assert.strictEqual(row.last_activity_by, 'Aman');             n++;
    assert.match(row.last_activity_new, /^Customer called back/); n++;
    assert.deepStrictEqual(activityOf(row), activityOf(await one(id))); n++;
  }

  //    …and the other way round: a status change AFTER the note wins.
  {
    const id = await lead('Note then status');
    await pool.query(
      `INSERT INTO lead_notes (lead_id, note, created_by, created_at)
       VALUES ($1,'older note',2, NOW() - INTERVAL '1 hour')`, [id]);
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
       VALUES ($1,'status_changed','Follow-Up','Junk',1)`, [id]);

    const row = (await list()).items.find(r => r.id === id);
    assert.strictEqual(row.last_activity_type, 'status_changed'); n++;
    assert.strictEqual(row.last_activity_new, 'Junk');            n++;
  }

  // ══ 4. A long note is trimmed by the server ══════════════════════════════
  //
  // The cell shows a few words. Shipping 2,000 characters to render 40 of them
  // is bandwidth spent on text nobody sees — and it is 2,000 characters PER
  // LEAD across the whole table.
  {
    const id = await lead('Essayist');
    await pool.query(`INSERT INTO lead_notes (lead_id, note, created_by) VALUES ($1,$2,1)`,
      [id, 'x'.repeat(2000)]);
    const row = (await list()).items.find(r => r.id === id);
    assert.strictEqual(row.last_activity_new.length, 80);         n++;
  }

  // ══ 5. An automated activity, with nobody behind it ══════════════════════
  //
  // WhatsApp routing writes assigned_changed rows with created_by NULL. An
  // INNER JOIN to users would drop the whole row and the column would go blank
  // on exactly the leads the CRM created by itself.
  {
    const id = await lead('Auto-assigned');
    await pool.query(
      `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
       VALUES ($1,'assigned_changed',NULL,'Priya','No option chosen yet.',NULL)`, [id]);

    const row = (await list()).items.find(r => r.id === id);
    assert.strictEqual(row.last_activity_type, 'assigned_changed'); n++;
    assert.strictEqual(row.last_activity_new, 'Priya');           n++;
    assert.strictEqual(row.last_activity_by, null,
      'a system activity has no actor, and must still appear');   n++;
  }

  // ══ 6. The drift guard ═══════════════════════════════════════════════════
  //
  // The bug was two SELECTs over one table, one of them missing a block. Both
  // now interpolate the same constants, and this is what says so — a future
  // edit that inlines one of them again fails here rather than on the screen.
  {
    const src = require('fs').readFileSync(
      path.join(BE, 'src/controllers/leads.controller.js'), 'utf8');

    const listSel = src.slice(src.indexOf('const LIST_SELECT'),
                              src.indexOf('const r = await pool.query'));
    const leadSel = src.slice(src.indexOf('const LEAD_SELECT'),
                              src.indexOf('function listLeads'));

    for (const [label, frag] of [['LIST_SELECT', listSel], ['LEAD_SELECT', leadSel]]) {
      assert.ok(frag.includes('${ACTIVITY_COLS}'),
        `${label} must use the shared activity columns`);          n++;
      assert.ok(frag.includes('${ACTIVITY_JOIN}'),
        `${label} must use the shared activity join`);             n++;
    }

    // And the aliases those constants use really exist on this database.
    const sql = src.slice(src.indexOf('const ACTIVITY_COLS'), src.indexOf('const LEAD_SELECT'))
                   .replace(/--[^\n]*/g, '');
    const TABLE = { a2: 'lead_activities', n: 'lead_notes' };
    const missing = [];
    for (const [alias, table] of Object.entries(TABLE)) {
      const have = new Set((await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table])).rows.map(x => x.column_name));
      for (const m of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)\\b`, 'g'))) {
        if (!have.has(m[1])) missing.push(`${alias}.${m[1]} (${table})`);
      }
    }
    assert.deepStrictEqual([...new Set(missing)], []);             n++;
  }

  await pool.end();
  console.log(`leadactivity (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
