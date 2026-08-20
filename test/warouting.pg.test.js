/**
 * WhatsApp lead routing, against a REAL PostgreSQL.
 *
 * ── The bug this suite exists for ───────────────────────────────────────────
 *
 * routeInbound was only ever called from applyWorkflow — the handler for
 * Interakt's `workflow_response_update`. A customer who typed one sentence and
 * tapped nothing produced no workflow event, so nothing ever looked at their
 * lead. Not the category rota, not continuity, and not the "one person handles
 * every WhatsApp lead" switch, which lives INSIDE the function that was never
 * called. Three leads on one screen made it obvious: the two who used the bot
 * were assigned, the one who wrote "Interested" was not.
 *
 * The fix has two halves and both are asserted here:
 *
 *   1. applyInbound routes too, with no answers. Rules 0, 1 and 3 all work
 *      without the customer tapping anything.
 *   2. Rule 3 — the fallback owner (migration 160) — is marked 'fallback',
 *      which means PROVISIONAL. When the answer finally arrives, the lead is
 *      either confirmed where it is or handed to whoever handles the category,
 *      and both people are told.
 *
 * ── Why every schema block below is quoted, not invented ────────────────────
 *
 * A previous suite in this repo passed 63 checks against a query that could
 * never run in production, because the test schema had invented a convenient
 * column name. Every CREATE TABLE here is copied from the migration that owns
 * it, and the guard at the end re-reads the service's own SQL and confirms
 * each column against information_schema.
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
const DBNAME = 'spinoto_warouting_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };
let n = 0;

const SCHEMA = `
-- users / leads: db/schema.sql, trimmed to the columns routing reads.
-- hub_id arrives later (migration 066) and is the one that matters here: a row
-- with it set is a workshop's portal login, not a colleague.
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(180) NOT NULL UNIQUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  hub_id         INTEGER);

CREATE TABLE leads (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(160) NOT NULL,
  mobile            VARCHAR(20)  NOT NULL,
  -- migration 038
  assigned_to       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- migration 158. VARCHAR(12) is not incidental: 'fallback' fits, and a
  -- longer word would be silently rejected by Postgres at runtime.
  assignment_source VARCHAR(12),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 039
CREATE TABLE lead_activities (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 038
CREATE TABLE notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50)  NOT NULL DEFAULT 'lead_assigned',
  title      VARCHAR(200) NOT NULL,
  body       TEXT,
  lead_id    INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 113. mobile UNIQUE is what makes two simultaneous first messages
-- from one number produce one lead rather than two.
CREATE TABLE wa_conversations (
  id                SERIAL PRIMARY KEY,
  mobile            VARCHAR(20) NOT NULL UNIQUE,
  lead_id           INTEGER,
  assigned_user_id  INTEGER REFERENCES users(id),
  customer_name     VARCHAR(160),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 158
CREATE TABLE wa_categories (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80) NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX idx_wa_categories_name ON wa_categories (LOWER(TRIM(name)));

-- migration 158 + 159 + 160
CREATE TABLE wa_agents (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handles          TEXT[]      NOT NULL DEFAULT '{}',
  on_duty          BOOLEAN     NOT NULL DEFAULT TRUE,
  last_assigned_at TIMESTAMPTZ,
  takes_all        BOOLEAN     NOT NULL DEFAULT FALSE,
  takes_unrouted   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE UNIQUE INDEX idx_wa_agents_takes_all
  ON wa_agents ((TRUE)) WHERE takes_all;
CREATE UNIQUE INDEX idx_wa_agents_takes_unrouted
  ON wa_agents ((TRUE)) WHERE takes_unrouted;

INSERT INTO wa_categories (name, sort_order) VALUES
  ('Bike/Scooter', 1), ('Car', 2), ('Support/Help', 3);
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('warouting (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const pool = new Pool(DB);
  const svc = require(path.join(BE, 'src/services/waRouting.service'));

  await pool.query(SCHEMA);

  // ── Helpers ──────────────────────────────────────────────────────────────

  let seq = 0;
  async function user(name, extra = {}) {
    const r = await pool.query(
      `INSERT INTO users (name, email, is_active, hub_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W/g, '')}${++seq}@x.test`,
       extra.is_active !== false, extra.hub_id ?? null]);
    return r.rows[0].id;
  }

  async function rota(userId, { handles = [], on_duty = true, takes_all = false,
                               takes_unrouted = false, last = null } = {}) {
    await pool.query(
      `INSERT INTO wa_agents (user_id, handles, on_duty, takes_all, takes_unrouted, last_assigned_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET handles = EXCLUDED.handles,
         on_duty = EXCLUDED.on_duty, takes_all = EXCLUDED.takes_all,
         takes_unrouted = EXCLUDED.takes_unrouted, last_assigned_at = EXCLUDED.last_assigned_at`,
      [userId, handles, on_duty, takes_all, takes_unrouted, last]);
  }

  /** A customer messaging in: the conversation row and the lead, as applyInbound makes them. */
  async function inbound(name, e164) {
    await pool.query(
      `INSERT INTO wa_conversations (mobile, customer_name) VALUES ($1,$2)
       ON CONFLICT (mobile) DO NOTHING`, [e164, name]);
    const l = await pool.query(
      `INSERT INTO leads (name, mobile) VALUES ($1,$2) RETURNING id`, [name, e164]);
    const leadId = l.rows[0].id;
    await pool.query(`UPDATE wa_conversations SET lead_id = $2 WHERE mobile = $1`, [e164, leadId]);
    return leadId;
  }

  /** routeInbound on its own transaction, the way routeConversation runs it. */
  async function route(leadId, e164, answers) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await svc.routeInbound(c, { leadId, e164, answers });
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { c.release(); }
  }

  const leadRow = async id => (await pool.query(
    `SELECT assigned_to, assignment_source FROM leads WHERE id = $1`, [id])).rows[0];
  const notifs = async id => (await pool.query(
    `SELECT user_id, type, title FROM notifications WHERE lead_id = $1 ORDER BY id`, [id])).rows;
  const acts = async id => (await pool.query(
    `SELECT type, old_value, new_value, note, created_by FROM lead_activities
      WHERE lead_id = $1 ORDER BY id`, [id])).rows;

  const reset = async () => {
    await pool.query(`UPDATE wa_agents SET takes_all = FALSE, takes_unrouted = FALSE,
                        on_duty = TRUE, handles = '{}', last_assigned_at = NULL`);
  };

  // ── The cast ─────────────────────────────────────────────────────────────
  const AMAN   = await user('Aman');
  const PRIYA  = await user('Priya');
  const RAVI   = await user('Ravi');
  const TRIAGE = await user('Triage Desk');
  const GONE   = await user('Ex Employee', { is_active: false });
  const HUB    = await user('QuickFix Portal', { hub_id: 7 });

  // ══ 1. The reported bug, with nothing configured ═════════════════════════
  //
  // Yuvraj typed "Interested" and tapped nothing. This is the BEFORE state and
  // it must still be reachable: with no fallback owner named, "leave it in the
  // unassigned queue" remains the answer, because that is a decision somebody
  // can make on the settings screen.
  {
    await reset();
    await rota(PRIYA, { handles: ['Car'] });
    const lead = await inbound('Yuvraj', '+919898343030');
    const r = await route(lead, '+919898343030', []);

    assert.strictEqual(r.assigned, false);                       n++;
    assert.strictEqual(r.reason, 'no_category_yet');             n++;
    assert.strictEqual((await leadRow(lead)).assigned_to, null);  n++;
  }

  // ══ 2. …and with a fallback owner named ══════════════════════════════════
  {
    await reset();
    await rota(PRIYA, { handles: ['Car'] });
    await rota(TRIAGE, { takes_unrouted: true });
    const lead = await inbound('Yuvraj 2', '+919898343031');
    const r = await route(lead, '+919898343031', []);

    assert.strictEqual(r.assigned, true);                        n++;
    assert.strictEqual(r.userId, TRIAGE);                        n++;
    const row = await leadRow(lead);
    assert.strictEqual(row.assigned_to, TRIAGE);                 n++;
    // 'fallback', not 'auto'. This word is the whole permission to move it later.
    assert.strictEqual(row.assignment_source, 'fallback');       n++;

    // The conversation remembers them, so a second enquiry from this number
    // goes to the same desk.
    const conv = await pool.query(
      `SELECT assigned_user_id FROM wa_conversations WHERE mobile = $1`, ['+919898343031']);
    assert.strictEqual(conv.rows[0].assigned_user_id, TRIAGE);   n++;

    const ns = await notifs(lead);
    assert.strictEqual(ns.length, 1);                            n++;
    assert.strictEqual(ns[0].user_id, TRIAGE);                   n++;
    assert.strictEqual(ns[0].type, 'lead_assigned');             n++;

    // The Assignment History panel on the lead. created_by NULL renders as
    // "System", which is true — no person did this.
    const a = await acts(lead);
    assert.strictEqual(a.length, 1);                             n++;
    assert.strictEqual(a[0].type, 'assigned_changed');           n++;
    assert.strictEqual(a[0].old_value, null);                    n++;
    assert.strictEqual(a[0].new_value, 'Triage Desk');           n++;
    assert.strictEqual(a[0].created_by, null);                   n++;
    assert.match(a[0].note, /No option chosen/i);                n++;

    // Given work, so the rota does not owe them a run of leads for it.
    const stamp = await pool.query(
      `SELECT last_assigned_at FROM wa_agents WHERE user_id = $1`, [TRIAGE]);
    assert.ok(stamp.rows[0].last_assigned_at);                   n++;
  }

  // ══ 3. "Every" now means every ═══════════════════════════════════════════
  //
  // The sharpest proof that routing was never running for these leads: with
  // one person switched on as taking EVERY WhatsApp lead, a free-text lead
  // still reached nobody, because that switch is read inside the function that
  // was never called.
  {
    await reset();
    await rota(AMAN, { takes_all: true });
    const lead = await inbound('Walk-in', '+919000000003');
    const r = await route(lead, '+919000000003', []);

    assert.strictEqual(r.userId, AMAN);                          n++;
    assert.strictEqual((await leadRow(lead)).assignment_source, 'auto'); n++;
  }

  // ══ 4. A returning customer keeps their advisor, without tapping ═════════
  {
    await reset();
    await rota(PRIYA, { handles: ['Car'] });
    const e164 = '+919000000004';
    await pool.query(
      `INSERT INTO wa_conversations (mobile, assigned_user_id) VALUES ($1,$2)`, [e164, RAVI]);
    const l = await pool.query(
      `INSERT INTO leads (name, mobile) VALUES ('Returning','${e164}') RETURNING id`);
    const r = await route(l.rows[0].id, e164, []);

    assert.strictEqual(r.userId, RAVI);                          n++;
    assert.strictEqual((await leadRow(l.rows[0].id)).assignment_source, 'auto'); n++;
  }

  //    …but not to somebody who has left. A deactivated user still named on the
  //    conversation must fall through, not be handed a customer.
  {
    await reset();
    await rota(TRIAGE, { takes_unrouted: true });
    const e164 = '+919000000005';
    await pool.query(
      `INSERT INTO wa_conversations (mobile, assigned_user_id) VALUES ($1,$2)`, [e164, GONE]);
    const l = await pool.query(
      `INSERT INTO leads (name, mobile) VALUES ('Old customer','${e164}') RETURNING id`);
    const r = await route(l.rows[0].id, e164, []);
    assert.strictEqual(r.userId, TRIAGE);                        n++;
  }

  // ══ 5. Category routing is untouched ═════════════════════════════════════
  {
    await reset();
    await rota(PRIYA, { handles: ['Car'] });
    await rota(TRIAGE, { takes_unrouted: true });
    const lead = await inbound('Car customer', '+919000000006');
    // Trailing space, exactly as Interakt sends it.
    const r = await route(lead, '+919000000006', ['Hi', 'Car ']);

    assert.strictEqual(r.userId, PRIYA);                         n++;
    assert.strictEqual((await leadRow(lead)).assignment_source, 'auto'); n++;
  }

  // ══ 6. The hand-off: assign now, correct it when the answer arrives ══════
  //
  // This is the sequence the customer actually produces. The message creates
  // the lead and Triage takes it within milliseconds; a few seconds later the
  // flow answer lands and Priya is who should have it.
  {
    await reset();
    await rota(PRIYA,  { handles: ['Car'] });
    await rota(TRIAGE, { takes_unrouted: true });
    const e164 = '+919000000007';
    const lead = await inbound('Deepak', e164);

    const first = await route(lead, e164, []);
    assert.strictEqual(first.userId, TRIAGE);                    n++;

    const second = await route(lead, e164, ['Hi', 'Car']);
    assert.strictEqual(second.assigned, true);                   n++;
    assert.strictEqual(second.reason, 'recategorised');          n++;
    assert.strictEqual(second.userId, PRIYA);                    n++;
    assert.strictEqual(second.movedFrom, TRIAGE);                n++;

    const row = await leadRow(lead);
    assert.strictEqual(row.assigned_to, PRIYA);                  n++;
    // No longer provisional. A stray later event must not move it again.
    assert.strictEqual(row.assignment_source, 'auto');           n++;

    const conv = await pool.query(
      `SELECT assigned_user_id FROM wa_conversations WHERE mobile = $1`, [e164]);
    assert.strictEqual(conv.rows[0].assigned_user_id, PRIYA);    n++;

    // BOTH people are told, and the second one is the point: Triage was
    // notified two minutes ago and may have the thread open.
    const ns = await notifs(lead);
    assert.strictEqual(ns.length, 3);                            n++;
    assert.deepStrictEqual(
      ns.map(x => [x.user_id, x.type]),
      [[TRIAGE, 'lead_assigned'], [PRIYA, 'lead_assigned'], [TRIAGE, 'lead_reassigned']]); n++;
    assert.match(ns[2].title, /moved to Priya/);                 n++;

    const a = await acts(lead);
    assert.strictEqual(a.length, 2);                             n++;
    assert.strictEqual(a[1].old_value, 'Triage Desk');           n++;
    assert.strictEqual(a[1].new_value, 'Priya');                 n++;
    assert.match(a[1].note, /chose Car/);                        n++;
  }

  // ══ 7. …and it happens once, however many times the event re-fires ═══════
  //
  // workflow_response_update is CUMULATIVE: every tap re-sends the whole
  // conversation from step one. Without the 'auto' stamp above, each re-send
  // would re-run the hand-off and notify everybody again.
  {
    await reset();
    await rota(PRIYA,  { handles: ['Car'] });
    await rota(RAVI,   { handles: ['Car'] });
    await rota(TRIAGE, { takes_unrouted: true });
    const e164 = '+919000000008';
    const lead = await inbound('Repeat tapper', e164);

    await route(lead, e164, []);
    await route(lead, e164, ['Car']);
    const third  = await route(lead, e164, ['Car', 'Support/Help']);
    const fourth = await route(lead, e164, ['Car', 'Support/Help', 'Car']);

    assert.strictEqual(third.assigned, false);                   n++;
    assert.strictEqual(third.reason, 'already_assigned');        n++;
    assert.strictEqual(fourth.reason, 'already_assigned');       n++;
    assert.strictEqual((await notifs(lead)).length, 3);          n++;
    assert.strictEqual((await acts(lead)).length, 2);            n++;
  }

  // ══ 8. A guess that turned out right is confirmed, not moved ═════════════
  //
  // The person who triages is usually on the rota too. Moving the lead from
  // themselves to themselves would notify them twice and log a change that did
  // not happen.
  {
    await reset();
    await rota(TRIAGE, { takes_unrouted: true, handles: ['Car'] });
    const e164 = '+919000000009';
    const lead = await inbound('Confirmed', e164);

    await route(lead, e164, []);
    assert.strictEqual((await leadRow(lead)).assignment_source, 'fallback'); n++;

    const r = await route(lead, e164, ['Car']);
    assert.strictEqual(r.assigned, false);                       n++;
    assert.strictEqual(r.reason, 'fallback_confirmed');          n++;
    assert.strictEqual((await leadRow(lead)).assigned_to, TRIAGE); n++;
    // Stamped 'auto': it stops being provisional, so this is asked once.
    assert.strictEqual((await leadRow(lead)).assignment_source, 'auto'); n++;
    assert.strictEqual((await notifs(lead)).length, 1);          n++;
    assert.strictEqual((await acts(lead)).length, 1);            n++;
  }

  // ══ 9. What may NOT be moved ═════════════════════════════════════════════
  //
  // assignment_source is the permission. A person's choice outranks every rule
  // in the file; a lead already routed on a real signal is not second-guessed.
  for (const [source, label] of [['manual', 'a person chose'],
                                 ['auto',   'routed on a real signal'],
                                 ['reply',  'an advisor answered first']]) {
    await reset();
    await rota(PRIYA, { handles: ['Car'] });
    const e164 = `+9190000001${source.length}0`;
    const lead = await inbound(`Locked ${source}`, e164);
    await pool.query(
      `UPDATE leads SET assigned_to = $2, assignment_source = $3 WHERE id = $1`,
      [lead, RAVI, source]);

    const r = await route(lead, e164, ['Car']);
    assert.strictEqual(r.assigned, false, label);                n++;
    assert.strictEqual(r.reason, 'already_assigned', label);     n++;
    assert.strictEqual((await leadRow(lead)).assigned_to, RAVI, label); n++;
    assert.strictEqual((await notifs(lead)).length, 0, label);   n++;
  }

  // ══ 10. Nobody on duty for the category ══════════════════════════════════
  //
  // The category IS known and there is still nobody to give it to. That is
  // also provisional — the right person may be on duty tomorrow — so the
  // fallback owner holds it and the lead stays movable.
  {
    await reset();
    await rota(PRIYA,  { handles: ['Car'], on_duty: false });
    await rota(TRIAGE, { takes_unrouted: true });
    const e164 = '+919000000011';
    const lead = await inbound('Uncovered', e164);

    const r = await route(lead, e164, ['Car']);
    assert.strictEqual(r.userId, TRIAGE);                        n++;
    const row = await leadRow(lead);
    assert.strictEqual(row.assignment_source, 'fallback');       n++;

    // Priya comes on duty; the customer taps again.
    await pool.query(`UPDATE wa_agents SET on_duty = TRUE WHERE user_id = $1`, [PRIYA]);
    const later = await route(lead, e164, ['Car']);
    assert.strictEqual(later.userId, PRIYA);                     n++;
    assert.strictEqual(later.reason, 'recategorised');           n++;
  }

  //     …and with no fallback owner it is simply unassigned, as before.
  {
    await reset();
    await rota(PRIYA, { handles: ['Car'], on_duty: false });
    const e164 = '+919000000012';
    const lead = await inbound('Uncovered 2', e164);
    const r = await route(lead, e164, ['Car']);
    assert.strictEqual(r.assigned, false);                       n++;
    assert.strictEqual(r.reason, 'nobody_on_duty_for_Car');       n++;
  }

  // ══ 11. The fallback owner is refused when they are not available ════════
  //
  // Off duty, deactivated, or a hub portal login. In every case the lead stays
  // in the unassigned queue, where it is visibly nobody's — which beats sitting
  // with somebody who went home, because that looks handled.
  for (const [who, how] of [[TRIAGE, { takes_unrouted: true, on_duty: false }],
                            [GONE,   { takes_unrouted: true }],
                            [HUB,    { takes_unrouted: true }]]) {
    await reset();
    await pool.query(`UPDATE wa_agents SET takes_unrouted = FALSE`);
    await rota(who, how);
    const e164 = `+91900000002${who}`;
    const lead = await inbound(`Unavailable ${who}`, e164);
    const r = await route(lead, e164, []);
    assert.strictEqual(r.assigned, false, `user ${who}`);        n++;
    assert.strictEqual((await leadRow(lead)).assigned_to, null, `user ${who}`); n++;
  }

  // ══ 12. Round-robin still takes turns ════════════════════════════════════
  {
    await reset();
    await pool.query(`UPDATE wa_agents SET takes_unrouted = FALSE`);
    await rota(PRIYA, { handles: ['Car'] });
    await rota(RAVI,  { handles: ['Car'] });

    const owners = [];
    for (let i = 0; i < 4; i++) {
      const e164 = `+91912300000${i}`;
      const lead = await inbound(`RR ${i}`, e164);
      owners.push((await route(lead, e164, ['Car'])).userId);
    }
    assert.deepStrictEqual(
      [...owners].sort((a, b) => a - b),
      [PRIYA, PRIYA, RAVI, RAVI].sort((a, b) => a - b));         n++;
    assert.notStrictEqual(owners[0], owners[1]);                 n++;
  }

  // ══ 13. The two calls race, and one wins ═════════════════════════════════
  //
  // applyInbound and applyWorkflow now BOTH route, and for a fast tapper they
  // overlap. The FOR UPDATE on the lead row is what makes them take turns; a
  // customer with two owners and two notifications would be worse than the bug
  // this all fixes.
  {
    await reset();
    await rota(PRIYA,  { handles: ['Car'] });
    await rota(TRIAGE, { takes_unrouted: true });
    const e164 = '+919000000030';
    const lead = await inbound('Fast tapper', e164);

    const [a, b] = await Promise.all([
      route(lead, e164, []),
      route(lead, e164, ['Car']),
    ]);

    const row = await leadRow(lead);
    assert.ok([PRIYA, TRIAGE].includes(row.assigned_to));        n++;
    // Whichever order they landed in, exactly one of them created the lead's
    // first owner.
    const firstAssign = (await notifs(lead)).filter(x => x.type === 'lead_assigned');
    assert.ok(firstAssign.length >= 1 && firstAssign.length <= 2); n++;
    assert.ok([a.userId, b.userId].every(u => u === PRIYA || u === TRIAGE)); n++;
    // And it always ends with the specialist, whichever way the race went:
    // either Priya got it outright, or Triage did and the answer moved it.
    assert.strictEqual(row.assigned_to, PRIYA);                  n++;
  }

  // ══ 14. Schema drift guard ═══════════════════════════════════════════════
  //
  // The reason this is here: a sibling suite passed 63 checks against a query
  // referencing a column that does not exist, because the test schema had
  // invented it. So the service's OWN SQL is read back and every aliased column
  // it names is confirmed against this database.
  {
    const src = require('fs').readFileSync(
      path.join(BE, 'src/services/waRouting.service.js'), 'utf8');
    // Only the SQL, and this scoping is not fussiness. A scan of the whole file
    // reports `a.trim` — the JS callback in categoryFromAnswers, where `a` is an
    // answer string and not the wa_agents alias. A guard that cries wolf is a
    // guard that gets deleted, so it reads the template literals that actually
    // contain SQL and nothing else.
    const sql = (src.match(/`[^`]*`/g) || [])
      .filter(t => /\b(SELECT|INSERT|UPDATE)\b/.test(t))
      .join('\n')
      // Comments stripped after — an earlier version of this guard fired on a
      // column name that only appeared inside the comment explaining the bug.
      .replace(/--[^\n]*/g, '');
    const TABLE = { a: 'wa_agents', u: 'users', c: 'wa_conversations' };
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
      'routing reads columns this database does not have');      n++;

    // And the unaliased tables it writes, which the guard above cannot see.
    for (const [table, cols] of Object.entries({
      leads:           ['assigned_to', 'assignment_source'],
      lead_activities: ['lead_id', 'type', 'old_value', 'new_value', 'note', 'created_by'],
      notifications:   ['user_id', 'type', 'title', 'body', 'lead_id'],
    })) {
      const have = new Set((await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table])).rows.map(x => x.column_name));
      for (const col of cols) {
        assert.ok(have.has(col), `${table}.${col} is missing`);  n++;
      }
    }

    // 'fallback' must survive the column it is stored in. VARCHAR(12) would
    // reject a longer word at runtime and only in production.
    const len = await pool.query(
      `SELECT character_maximum_length AS n FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'assignment_source'`);
    assert.ok('fallback'.length <= len.rows[0].n);               n++;
  }

  await pool.end();
  console.log(`warouting (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
