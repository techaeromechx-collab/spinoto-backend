/**
 * The WhatsApp badge in the topbar, against a REAL PostgreSQL.
 *
 * ── What is worth protecting here ───────────────────────────────────────────
 *
 * A badge is trusted or ignored, and there is nothing in between. Two failures
 * turn it into wallpaper within a day:
 *
 *   it counts something you cannot clear  → it sticks at 47 forever
 *   it clears when SOMEBODY ELSE looks    → you never learn a customer wrote
 *
 * The first is why wa_conversation_reads exists at all (nothing in this system
 * recorded whether an advisor had seen an inbound message - wa_messages.read_at
 * is the CUSTOMER'S blue tick on an outbound one). The second is why the read
 * cursor is per user rather than a column on the conversation, and it is the
 * case most likely to be quietly broken by a later "simplification".
 *
 * Both are asserted below against real rows, through the real endpoints.
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
const DBNAME = 'spinoto_wainbox_test';
const DB = { host: '/tmp', port: 5433, user: 'postgres', database: DBNAME,
             connectionTimeoutMillis: 1500 };
let n = 0;

const SCHEMA = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE, is_active BOOLEAN NOT NULL DEFAULT TRUE);

CREATE TABLE leads (
  id SERIAL PRIMARY KEY, name VARCHAR(160), mobile VARCHAR(20) NOT NULL,
  status VARCHAR(100), assigned_to INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 113
CREATE TABLE wa_conversations (
  id SERIAL PRIMARY KEY,
  mobile VARCHAR(20) NOT NULL UNIQUE,
  last_inbound_at TIMESTAMPTZ,
  window_expires_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  lead_id INTEGER,
  assigned_user_id INTEGER REFERENCES users(id),
  customer_name VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- migration 111, trimmed to what the inbox reads.
CREATE TABLE wa_messages (
  id SERIAL PRIMARY KEY,
  direction VARCHAR(3) NOT NULL DEFAULT 'out',
  origin VARCHAR(10),
  to_number VARCHAR(20) NOT NULL,
  body_rendered TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'queued',
  entity_type VARCHAR(20), entity_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ);
CREATE INDEX idx_wa_messages_number ON wa_messages (to_number, created_at DESC);

-- migration 163
CREATE TABLE wa_conversation_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mobile VARCHAR(20) NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- migration 164
  dismissed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, mobile));
`;

(async () => {
  const admin = new Pool({ ...DB, database: 'postgres' });
  try { await admin.query('SELECT 1'); }
  catch {
    console.log('wainbox (postgres): SKIPPED — no scratch server on /tmp:5433');
    process.exit(0);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  process.env.DATABASE_URL = `postgres://postgres@/${DBNAME}?host=/tmp&port=5433`;
  const { pool } = require(path.join(BE, 'src/config/db'));
  const ctrl = require(path.join(BE, 'src/controllers/whatsapp.inbox.controller'));

  await pool.query(SCHEMA);

  // ── Helpers ──────────────────────────────────────────────────────────────

  // The real shape leads.controller reads: a Set, plus is_super_admin. An
  // advisor has neither flag; an owner has one of them.
  const asUser = (id, opts = {}) => ({
    id,
    is_super_admin: !!opts.super,
    permissions: new Set(opts.perms || []),
  });

  const count = (uid, opts) => new Promise((resolve, reject) =>
    ctrl.unreadCount({ user: asUser(uid, opts) },
      { json: r => resolve(r.count), status() { return this; } }, reject));

  const list = (uid, opts) => new Promise((resolve, reject) =>
    ctrl.listInbox({ user: asUser(uid, opts), query: {} },
      { json: r => resolve(r.items), status() { return this; } }, reject));

  const read = (uid, mobile) => new Promise((resolve, reject) =>
    ctrl.markRead({ user: asUser(uid), body: { mobile } },
      { json: resolve, status(c) { this.code = c; return this; } }, reject));

  const readAll = uid => new Promise((resolve, reject) =>
    ctrl.markAllRead({ user: asUser(uid) },
      { json: resolve, status() { return this; } }, reject));

  const clear = (uid, mobile) => new Promise((resolve, reject) =>
    ctrl.dismiss({ user: asUser(uid), body: { mobile } },
      { json: resolve, status() { return this; } }, reject));

  const clearAll = uid => new Promise((resolve, reject) =>
    ctrl.dismissAll({ user: asUser(uid) },
      { json: resolve, status() { return this; } }, reject));

  /** A conversation with one inbound message on it. */
  async function convo(mobile, { owner = null, name = null, agoMin = 1,
                                 windowHours = 24, body = 'Interested' } = {}) {
    await pool.query(
      `INSERT INTO wa_conversations (mobile, assigned_user_id, customer_name,
                                     last_inbound_at, window_expires_at, last_message_at)
       VALUES ($1,$2,$3, NOW() - ($4 || ' minutes')::interval,
               NOW() + ($5 || ' hours')::interval, NOW())`,
      [mobile, owner, name, String(agoMin), String(windowHours)]);
    await pool.query(
      `INSERT INTO wa_messages (direction, to_number, body_rendered, status, created_at)
       VALUES ('in', $1, $2, 'received', NOW() - ($3 || ' minutes')::interval)`,
      [mobile, body, String(agoMin)]);
  }

  const AMAN  = (await pool.query(
    `INSERT INTO users (name,email) VALUES ('Aman','a@x.test') RETURNING id`)).rows[0].id;
  const PRIYA = (await pool.query(
    `INSERT INTO users (name,email) VALUES ('Priya','p@x.test') RETURNING id`)).rows[0].id;

  // ══ 1. Scope: mine, plus the unassigned queue ════════════════════════════
  //
  // The queue is in on purpose. Those are the conversations routing could not
  // place — nobody's, and invisible to everybody if the badge showed only your
  // own.
  {
    await convo('+919000000001', { owner: AMAN,  name: 'Aman customer' });
    await convo('+919000000002', { owner: PRIYA, name: 'Priya customer' });
    await convo('+919000000003', { owner: null,  name: 'Nobody yet' });

    assert.strictEqual(await count(AMAN),  2, 'own + unassigned');   n++;
    assert.strictEqual(await count(PRIYA), 2, 'own + unassigned');   n++;

    const mine = (await list(AMAN)).map(r => r.mobile);
    assert.ok(mine.includes('+919000000001'));                       n++;
    assert.ok(mine.includes('+919000000003'));                       n++;
    assert.ok(!mine.includes('+919000000002'),
      "another advisor's conversation must not appear");              n++;
  }

  // ══ 2. Reading is PER USER ═══════════════════════════════════════════════
  //
  // The assertion most likely to be broken by a later simplification to one
  // column on the conversation. Aman opening the unassigned thread must not
  // clear it for Priya, who would then never learn the customer wrote.
  {
    await read(AMAN, '+919000000003');

    assert.strictEqual(await count(AMAN),  1);                       n++;
    assert.strictEqual(await count(PRIYA), 2,
      "one advisor reading a shared conversation must not clear another's badge"); n++;

    const rows = await list(AMAN);
    assert.strictEqual(rows.find(r => r.mobile === '+919000000003').is_unread, false); n++;
    assert.strictEqual(rows.find(r => r.mobile === '+919000000001').is_unread, true);  n++;
    // Read conversations stay in the LIST — a list that empties itself as you
    // look at it cannot be used to find the message you just read.
    assert.strictEqual(rows.length, 2);                              n++;
  }

  // ══ 3. The cursor moves; a NEW message after it counts again ═════════════
  //
  // read_at is a cursor, not a flag, which is what makes this work with no
  // write anywhere when a message arrives.
  {
    await pool.query(
      `INSERT INTO wa_messages (direction, to_number, body_rendered, status)
       VALUES ('in', '+919000000003', 'Are you there?', 'received')`);

    assert.strictEqual(await count(AMAN), 2,
      'a message after the read cursor is unread again');            n++;
  }

  // ══ 4. Our own replies do not light the badge ════════════════════════════
  {
    await read(AMAN, '+919000000003');
    await pool.query(
      `INSERT INTO wa_messages (direction, to_number, body_rendered, status)
       VALUES ('out', '+919000000003', 'On our way', 'sent')`);

    assert.strictEqual(await count(AMAN), 1,
      'an outbound message must not count as unread');               n++;

    // …but it IS the last message, and the row says so, or a conversation you
    // have already answered still reads as the customer waiting.
    const row = (await list(AMAN)).find(r => r.mobile === '+919000000003');
    assert.strictEqual(row.last_direction, 'out');                   n++;
    assert.strictEqual(row.last_message, 'On our way');              n++;
    assert.strictEqual(row.is_unread, false);                        n++;
  }

  // ══ 5. Never opened means everything unread ══════════════════════════════
  //
  // The zero-row case, and the common one: it is every conversation nobody has
  // touched. A LEFT JOIN with a NULL check that fell the other way would ship
  // a badge that reads 0 on a full inbox.
  {
    const fresh = await count(PRIYA);
    assert.ok(fresh > 0, 'a user with no read rows at all sees unread');  n++;
  }

  // ══ 6. Ordering: unread first, then newest ═══════════════════════════════
  //
  // Sorting purely by time buries a customer who wrote this morning under
  // conversations already dealt with since.
  {
    await convo('+919000000004', { owner: AMAN, name: 'Old but unread', agoMin: 600 });
    const rows = await list(AMAN);
    const firstRead = rows.findIndex(r => !r.is_unread);
    const lastUnread = rows.map(r => r.is_unread).lastIndexOf(true);
    assert.ok(firstRead === -1 || lastUnread < firstRead,
      'every unread row must sort above every read one');            n++;
  }

  // ══ 7. The window, which is why this is not just another bell ════════════
  //
  // window_expires_at is passed through untouched; the countdown is rendered in
  // the browser. Asserted here so a future "tidy-up" of the SELECT cannot drop
  // the one column that makes this control worth having.
  {
    await convo('+919000000005', { owner: AMAN, name: 'Nearly closed', windowHours: 1 });
    const row = (await list(AMAN)).find(r => r.mobile === '+919000000005');
    assert.ok(row.window_expires_at instanceof Date);                n++;
    const hoursLeft = (row.window_expires_at - Date.now()) / 3_600_000;
    assert.ok(hoursLeft > 0.9 && hoursLeft < 1.1);                   n++;
  }

  // ══ 8. Display name: lead, then conversation, then the number ════════════
  {
    const l = await pool.query(
      `INSERT INTO leads (name, mobile) VALUES ('Yuvraj Solanki','+919000000006') RETURNING id`);
    await convo('+919000000006', { owner: AMAN, name: 'yuvraj (whatsapp profile)' });
    await pool.query(`UPDATE wa_conversations SET lead_id = $2 WHERE mobile = $1`,
      ['+919000000006', l.rows[0].id]);

    const row = (await list(AMAN)).find(r => r.mobile === '+919000000006');
    assert.strictEqual(row.display_name, 'Yuvraj Solanki',
      "the lead's name beats the WhatsApp profile name");            n++;
    assert.strictEqual(row.lead_id, l.rows[0].id,
      'the row must carry the lead it opens');                       n++;
  }
  {
    // No lead, no customer_name — the number itself, which is at least dialable.
    await convo('+919000000007', { owner: AMAN, name: null });
    const row = (await list(AMAN)).find(r => r.mobile === '+919000000007');
    assert.strictEqual(row.display_name, '+919000000007');           n++;
  }

  // ══ 9. A conversation with no messages is not a row ══════════════════════
  //
  // wa_conversations is upserted by the webhook before the message is stored,
  // and applyWorkflow can create one for a bot greeting that never became an
  // enquiry. An empty conversation in the dropdown is a blank line.
  {
    await pool.query(
      `INSERT INTO wa_conversations (mobile, assigned_user_id) VALUES ('+919000000008', $1)`,
      [AMAN]);
    const rows = await list(AMAN);
    assert.ok(!rows.some(r => r.mobile === '+919000000008'));         n++;
    // …and it must not be counted either, or the badge would show a number the
    // list cannot explain.
    const before = await count(AMAN);
    await read(AMAN, '+919000000008');
    assert.strictEqual(await count(AMAN), before);                    n++;
  }

  // ══ 10. Mark all read is scoped to what the badge counts ═════════════════
  //
  // Not "every conversation in the database". Marking a colleague's read for
  // yourself means never seeing it if one is reassigned to you tomorrow.
  {
    await readAll(AMAN);
    assert.strictEqual(await count(AMAN), 0);                        n++;
    assert.ok(await count(PRIYA) > 0,
      "mark-all must not touch another advisor's conversations");     n++;

    const leaked = await pool.query(
      `SELECT 1 FROM wa_conversation_reads WHERE user_id = $1 AND mobile = '+919000000002'`,
      [AMAN]);
    assert.strictEqual(leaked.rowCount, 0,
      'mark-all must not bookmark a conversation outside your scope'); n++;
  }

  // ══ 11. A bad number is refused, not stored ══════════════════════════════
  {
    let code = null;
    await new Promise((resolve, reject) =>
      ctrl.markRead({ user: asUser(AMAN), body: { mobile: 'not a number' } },
        { status(c) { code = c; return this; }, json: resolve }, reject));
    assert.strictEqual(code, 400);                                    n++;
  }

  // ══ 11b. Clear: the row goes, and comes back by itself ══════════════════
  //
  // Read and Clear are two different verbs. Read drops the badge and keeps the
  // row — a list that empties as you look at it cannot be used to find the
  // message you just read. Clear removes the row.
  //
  // The part worth protecting is the RETURN. A boolean "dismissed" would have
  // to be unset from the webhook for every user who had cleared it, and one
  // missed update is a customer's reply landing somewhere invisible. A cursor
  // needs no such update, and this is the proof.
  {
    // Unassigned on purpose: both advisors can see it, which is what makes the
    // per-user assertion below meaningful. An Aman-owned conversation is
    // invisible to Priya for a different reason entirely, and the test would
    // pass while proving nothing.
    await convo('+919000000040', { owner: null, name: 'Cleared away' });
    assert.ok((await list(AMAN)).some(r => r.mobile === '+919000000040'));  n++;

    const cameIn = await count(AMAN);
    await clear(AMAN, '+919000000040');
    assert.ok(!(await list(AMAN)).some(r => r.mobile === '+919000000040'),
      'a cleared conversation leaves the list');                     n++;

    // Clearing implies read. A badge counting something you can no longer see
    // is the exact failure that makes people stop trusting badges — so this is
    // asserted on the COUNT, not on the column. read_at is NOT NULL DEFAULT
    // NOW(), so "is it set" is true even when it was set to the epoch and the
    // conversation is still unread.
    assert.strictEqual(cameIn - 1, await count(AMAN),
      'clearing a conversation must take it out of the badge too');   n++;

    const rows = await pool.query(
      `SELECT dismissed_at FROM wa_conversation_reads
        WHERE user_id = $1 AND mobile = '+919000000040'`, [AMAN]);
    assert.ok(rows.rows[0].dismissed_at);                            n++;

    // Nothing was deleted — the messages are still there.
    const kept = await pool.query(
      `SELECT COUNT(*)::int AS n FROM wa_messages WHERE to_number = '+919000000040'`);
    assert.strictEqual(kept.rows[0].n, 1);                           n++;

    // And Priya, who cleared nothing, still sees it.
    assert.ok((await list(PRIYA)).some(r => r.mobile === '+919000000040'),
      'clearing is per user, like reading');                          n++;

    // ── The customer writes again ──────────────────────────────────────────
    await pool.query(
      `INSERT INTO wa_messages (direction, to_number, body_rendered, status)
       VALUES ('in', '+919000000040', 'Hello? Anyone there?', 'received')`);

    assert.ok((await list(AMAN)).some(r => r.mobile === '+919000000040'),
      'a newer message brings a cleared conversation back');          n++;
    const back = (await list(AMAN)).find(r => r.mobile === '+919000000040');
    assert.strictEqual(back.is_unread, true,
      '…and it is unread again, because the read cursor is older too'); n++;
  }

  // ══ 11c. Clear all, scoped like mark-all-read ════════════════════════════
  {
    const before = (await list(PRIYA)).length;
    assert.ok(before > 0);                                           n++;

    await clearAll(PRIYA);
    assert.strictEqual((await list(PRIYA)).length, 0);               n++;
    assert.strictEqual(await count(PRIYA), 0);                       n++;

    // Aman's own list is untouched — a different user's cursors entirely.
    assert.ok((await list(AMAN)).length > 0,
      "clear-all must not empty another advisor's list");             n++;

    // …and the scoping asserted where it can actually be seen: Priya must not
    // have bookmarked a conversation she cannot see. Checking her LIST cannot
    // catch an unscoped clear-all, because those rows were never in it — only
    // the cursor table shows the overreach.
    const overreach = await pool.query(
      `SELECT 1 FROM wa_conversation_reads r
         JOIN wa_conversations c ON c.mobile = r.mobile
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE r.user_id = $1
          AND r.dismissed_at IS NOT NULL
          AND COALESCE(c.assigned_user_id, l.assigned_to) IS NOT NULL
          AND COALESCE(c.assigned_user_id, l.assigned_to) <> $1`, [PRIYA]);
    assert.strictEqual(overreach.rowCount, 0,
      'clear-all must not bookmark conversations outside your scope'); n++;

    // A broom, not a mute: the next message reappears immediately.
    await convo('+919000000041', { owner: PRIYA, name: 'Right after' });
    assert.strictEqual((await list(PRIYA)).length, 1);               n++;
  }

  // ══ 12. The owner sees everything ════════════════════════════════════════
  //
  // The failure that produced this rule: the business owner watched a customer
  // message arrive, saw no badge, and could not tell that it was working
  // exactly as specified. It had been routed to an advisor, and "mine plus
  // unassigned" excluded it — silently, which is the worst way for a scope to
  // be right.
  //
  // The rule is the SAME one the Leads page uses (is_super_admin, then
  // VIEW_LEAD), deliberately: "see everything" meaning two different things on
  // two screens is a CRM nobody can reason about.
  {
    // A third user, owning a conversation neither AMAN nor PRIYA can see.
    const RAJ = (await pool.query(
      `INSERT INTO users (name,email) VALUES ('Raj','r@x.test') RETURNING id`)).rows[0].id;
    await convo('+919000000100', { owner: RAJ, name: "Raj's customer" });

    assert.strictEqual(
      (await list(AMAN)).some(r => r.mobile === '+919000000100'), false,
      "an advisor must not see another advisor's conversation");     n++;

    for (const opts of [{ super: true }, { perms: ['VIEW_LEAD'] }]) {
      const rows = await list(AMAN, opts);
      assert.ok(rows.some(r => r.mobile === '+919000000100'),
        'super admin / VIEW_LEAD sees every conversation');          n++;
      assert.ok(rows.some(r => r.mobile === '+919000000002'),
        "…including the other advisor's");                            n++;
    }

    // The count agrees with the list. A badge saying 3 over a dropdown with 5
    // rows is the bug this pairing exists to catch.
    const wide = await count(AMAN, { super: true });
    const narrow = await count(AMAN);
    assert.ok(wide > narrow);                                        n++;
    assert.strictEqual(
      wide, (await list(AMAN, { super: true })).filter(r => r.is_unread).length); n++;
  }

  // ══ 13. Ownership falls back to the LEAD ═════════════════════════════════
  //
  // Routing writes both columns. Assigning a lead by hand writes only
  // leads.assigned_to and never touches the conversation — so a lead plainly
  // owned by Aman on the Leads page had nobody on its conversation. Three
  // things went wrong at once: the dropdown said "Unassigned" next to a leads
  // row saying "Aman", the conversation counted in EVERYONE'S badge as though
  // it were queue work, and the push went to nobody.
  {
    const l = await pool.query(
      `INSERT INTO leads (name, mobile, assigned_to) VALUES ('Manual Ravi','+919000000101',$1)
       RETURNING id`, [PRIYA]);
    await convo('+919000000101', { owner: null, name: null });
    await pool.query(`UPDATE wa_conversations SET lead_id = $2 WHERE mobile = $1`,
      ['+919000000101', l.rows[0].id]);

    const forPriya = (await list(PRIYA)).find(r => r.mobile === '+919000000101');
    assert.ok(forPriya, 'a manually assigned lead reaches its owner');  n++;
    assert.strictEqual(forPriya.assigned_user_id, PRIYA);            n++;
    assert.strictEqual(forPriya.assigned_to_name, 'Priya',
      'the dropdown must name the same person the Leads page does');  n++;

    // …and it is no longer everybody's queue work.
    assert.strictEqual(
      (await list(AMAN)).some(r => r.mobile === '+919000000101'), false,
      'a lead with an owner must leave the shared unassigned queue'); n++;
  }

  // ══ 12. Schema drift guard ═══════════════════════════════════════════════
  {
    const src = require('fs').readFileSync(
      path.join(BE, 'src/controllers/whatsapp.inbox.controller.js'), 'utf8');
    const sql = (src.match(/`[^`]*`/g) || [])
      .filter(t => /\b(SELECT|INSERT|UPDATE)\b/.test(t))
      .join('\n').replace(/--[^\n]*/g, '');
    const TABLE = { c: 'wa_conversations', m: 'wa_messages',
                    r: 'wa_conversation_reads', l: 'leads', u: 'users' };
    const missing = [];
    for (const [alias, table] of Object.entries(TABLE)) {
      const have = new Set((await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table])).rows.map(x => x.column_name));
      for (const mm of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)\\b`, 'g'))) {
        if (!have.has(mm[1])) missing.push(`${alias}.${mm[1]} (${table})`);
      }
    }
    assert.deepStrictEqual([...new Set(missing)], [],
      'the inbox reads columns this database does not have');          n++;
  }

  await pool.end();
  console.log(`wainbox (postgres): ${n} checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
