#!/usr/bin/env node
'use strict';

/**
 * Where did this number's message go, and why was no lead created?
 *
 * wa-events.js answers "did Interakt deliver it". This answers the next
 * question: it arrived, it was processed without error, and yet nothing new
 * appeared in Leads.
 *
 * There are only four possible answers, and the webhook does not record which
 * one it took — so this re-runs the SAME queries, in the SAME order, that
 * services/waInboundLead.service.js runs, and prints which branch claimed the
 * message. Read-only: it opens no transaction and writes nothing.
 *
 *   node scripts/wa-why.js 9712301573
 *   node scripts/wa-why.js +919712301573
 *
 * Run it from backend/, where .env has DATABASE_URL.
 */

require('dotenv').config();
const { Pool } = require('pg');

// The app's own normaliser, not a copy. A second implementation that drifts by
// one character would make this tool confidently describe a different number
// than the webhook actually looked up.
const { toE164, toNational } = require('../src/utils/phone');

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/wa-why.js <mobile>');
  process.exit(1);
}

// Kept character-identical to waInboundLead.service.js. If that file changes,
// this must change with it or the two will disagree about the same database.
const NAT = (col) => `RIGHT(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g'), 10)`;
const CLOSED_LEAD = `(
  EXISTS (SELECT 1 FROM lead_statuses ls
           WHERE LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status)) AND ls.is_closed)
  OR EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id)
)`;

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } }
    : {}
);

const H = (t) => console.log(`\n  ── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`);
const yn = (b) => (b ? 'yes' : 'no');

(async () => {
  const c = await pool.connect();
  try {
    const e164 = toE164(raw);
    const national = toNational(raw);

    console.log(`\n  Input      ${raw}`);
    console.log(`  E.164      ${e164 || '(unparseable)'}`);
    console.log(`  National   ${national || '(unparseable)'}`);
    if (!national) {
      console.log('\n  ✗ This number does not normalise to a 10-digit Indian mobile, so the');
      console.log('    webhook stored the message and stopped. Nothing else below applies.\n');
      return;
    }

    // ── Has migration 156 actually been applied here? ───────────────────────
    // Without is_closed every "is this lead finished" test silently answers no,
    // and messages pile onto dead leads. Cheap to check, and the answer changes
    // how everything below should be read.
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lead_statuses' AND column_name = 'is_closed'`);
    if (!col.rowCount) {
      console.log('\n  ✗ lead_statuses.is_closed does not exist — migration 156 has not run on');
      console.log('    THIS database. Run `npm run db:migrate`, then run this again.\n');
      return;
    }

    // ── The message itself ──────────────────────────────────────────────────
    H('The last inbound message from this number');
    const msg = await c.query(
      `SELECT id, created_at, entity_type, entity_id, LEFT(COALESCE(body_rendered,''), 60) AS body
         FROM wa_messages
        WHERE direction = 'in' AND ${NAT('to_number')} = $1
        ORDER BY id DESC LIMIT 1`, [national]);

    if (!msg.rowCount) {
      console.log('  none stored. Interakt has not delivered a message from this number,');
      console.log('  or it was rejected before the insert. Check: node scripts/wa-events.js 10');
    } else {
      const m = msg.rows[0];
      console.log(`  #${m.id}  ${new Date(m.created_at).toLocaleString('en-IN')}  ${JSON.stringify(m.body)}`);
      console.log(`  filed on: ${m.entity_type ? `${m.entity_type} #${m.entity_id}` : 'NOTHING (stored, but attached to no record)'}`);
    }

    // ── Branch A: the conversation's remembered lead ────────────────────────
    H('Branch A — the remembered lead (wa_conversations.lead_id)');
    const conv = await c.query(
      `SELECT mobile, lead_id, last_inbound_at FROM wa_conversations WHERE mobile = $1`, [e164]);
    if (!conv.rowCount) {
      console.log(`  no wa_conversations row for ${e164}.`);
      // Worth saying out loud: the row is keyed on the EXACT E.164 string, so a
      // number stored in another format has its own row and its own memory.
      const other = await c.query(
        `SELECT mobile, lead_id FROM wa_conversations WHERE ${NAT('mobile')} = $1`, [national]);
      if (other.rowCount) {
        console.log('  but rows exist for the same number in another format:');
        for (const r of other.rows) console.log(`    ${r.mobile}  → lead ${r.lead_id ?? '(none)'}`);
      }
    } else {
      const r = conv.rows[0];
      console.log(`  ${r.mobile}  → lead_id ${r.lead_id ?? '(none)'}  last inbound ${r.last_inbound_at ? new Date(r.last_inbound_at).toLocaleString('en-IN') : '—'}`);
    }
    const known = await c.query(
      `SELECT l.id FROM wa_conversations cv JOIN leads l ON l.id = cv.lead_id
        WHERE cv.mobile = $1 AND NOT ${CLOSED_LEAD}`, [e164]);
    const branchA = known.rows[0]?.id || null;
    console.log(`  → ${branchA ? `CLAIMS IT: lead #${branchA} (remembered and still open)` : 'passes (no remembered lead, or it is closed)'}`);

    // ── Every lead on this number, and whether it counts as finished ────────
    H('Every lead with this number');
    const leads = await c.query(
      `SELECT l.id, l.name, l.mobile, l.status, l.lead_source, l.created_at,
              EXISTS (SELECT 1 FROM lead_statuses ls
                       WHERE LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status)) AND ls.is_closed) AS status_closed,
              EXISTS (SELECT 1 FROM lead_statuses ls
                       WHERE LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status)))               AS status_known,
              EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id)             AS has_appt
         FROM leads l
        WHERE (${NAT('l.mobile')} = $1 OR ${NAT('l.whatsapp')} = $1)
        ORDER BY l.created_at DESC, l.id DESC`, [national]);

    if (!leads.rowCount) {
      console.log('  none.');
    } else {
      for (const l of leads.rows) {
        const closed = l.status_closed || l.has_appt;
        console.log(`  #${l.id}  ${(l.name || '(no name)').padEnd(20).slice(0, 20)} ${String(l.status || 'New Lead').padEnd(22).slice(0, 22)} ${closed ? 'CLOSED' : 'open  '}  src=${l.lead_source || '—'}`);
        console.log(`        status flagged closed: ${yn(l.status_closed)}${l.status && !l.status_known ? '  ← this status has NO row in lead_statuses, so it can never be flagged' : ''}   has appointment: ${yn(l.has_appt)}`);
      }
    }

    // ── Branch B: the newest OPEN lead ──────────────────────────────────────
    H('Branch B — newest open lead on this number');
    const openLead = await c.query(
      `SELECT l.id FROM leads l
        WHERE (${NAT('l.mobile')} = $1 OR ${NAT('l.whatsapp')} = $1)
          AND NOT ${CLOSED_LEAD}
        ORDER BY l.created_at DESC, l.id DESC LIMIT 1`, [national]);
    const branchB = openLead.rows[0]?.id || null;
    console.log(`  → ${branchB ? `CLAIMS IT: lead #${branchB}` : 'passes (every lead on this number is closed, or there are none)'}`);

    // ── An existing customer ────────────────────────────────────────────────
    //
    // This used to be branch C and used to STOP lead creation. It no longer
    // does — it only supplies the name — so it is reported here as context
    // rather than as a decision, and the verdict below must not treat it as one.
    H('Existing customer profile (name only — no longer blocks lead creation)');
    const cust = await c.query(
      `SELECT mobile, display_name FROM customer_profiles
        WHERE mobile = $1 AND is_deleted = FALSE`, [national]);
    const isCustomer = cust.rowCount > 0;
    if (isCustomer) {
      console.log(`  ${cust.rows[0].display_name || '(no name)'}  ${cust.rows[0].mobile}`);
      console.log('  → a new lead from this number is named from this profile.');
    } else {
      console.log('  no customer_profiles row for this number.');
    }

    // ── Verdict ─────────────────────────────────────────────────────────────
    H('So what happened');
    if (branchA) {
      console.log(`  The message went onto lead #${branchA}, which wa_conversations remembers`);
      console.log('  and which is still open. Nothing new is created while that lead is open —');
      console.log('  this is the same enquiry continuing. Close that lead and the next message');
      console.log('  starts a fresh one.');
    } else if (branchB) {
      console.log(`  The message went onto lead #${branchB} — the newest OPEN lead on this number.`);
      console.log('  Same reason: an open lead means the conversation is still being worked.');
    } else {
      console.log(`  Nothing claimed it, so the webhook SHOULD have created a lead${isCustomer ? ',' : '.'}`);
      if (isCustomer) console.log('  named from the customer profile above.');
      console.log('');
      console.log('  If no such lead exists, the message never got as far as the resolver —');
      console.log('  check node scripts/wa-events.js 10 for a process_error on that event.');
      console.log('');
      console.log('  Messages received BEFORE this rule changed have no lead and will not grow');
      console.log('  one retrospectively. They are still readable on the Customer page.');
    }
    console.log('');
  } catch (e) {
    console.error('\n  Could not read the database:', e.message);
    console.error('  Run this from the backend/ folder, where .env has DATABASE_URL.\n');
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
