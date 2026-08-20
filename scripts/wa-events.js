#!/usr/bin/env node
'use strict';

/**
 * What has Interakt actually sent us?
 *
 * Every webhook that passes the signature check is written to wa_events BEFORE
 * anything tries to interpret it — including event types we do not handle. So
 * this table is the honest answer to "did the message arrive?", as opposed to
 * "did a lead appear?", which is a different question with several possible
 * causes.
 *
 *   node scripts/wa-events.js          last 15 events
 *   node scripts/wa-events.js 40       last 40
 *
 * Reads DATABASE_URL from backend/.env the same way the app does.
 */

require('dotenv').config();
const { Pool } = require('pg');

const LIMIT = Math.min(Math.max(Number(process.argv[2]) || 15, 1), 200);

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } }
    : {}
);

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

(async () => {
  try {
    const ev = await pool.query(
      `SELECT id, event_type, process_error, processed_at, received_at,
              -- fake-inbound.js stamps its ids 'wamid.test.…'. Without this the
              -- verdict below counts locally-injected events as proof Interakt
              -- is delivering, which is the one thing this script exists to
              -- answer and the one way it can be confidently wrong.
              (provider_message_id LIKE 'wamid.test.%') AS is_fake,
              payload #>> '{data,customer,channel_phone_number}' AS from_number,
              LEFT(COALESCE(payload #>> '{data,message,message}', ''), 42) AS body
         FROM wa_events
        ORDER BY id DESC
        LIMIT $1`, [LIMIT]);

    if (!ev.rowCount) {
      console.log('\n  wa_events is EMPTY — no webhook has ever passed the signature check.');
      console.log('  Either nothing is arriving, or every request is being rejected 401.\n');
    } else {
      console.log(`\n  Last ${ev.rowCount} webhook events (newest first)\n`);
      console.log('  ' + pad('WHEN', 17) + pad('TYPE', 26) + pad('SOURCE', 12) + pad('FROM', 15) + pad('RESULT', 22) + 'MESSAGE');
      console.log('  ' + '─'.repeat(120));
      for (const r of ev.rows) {
        const when = new Date(r.received_at).toLocaleString('en-IN',
          { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const result = r.process_error ? r.process_error : (r.processed_at === null ? '—' : 'ok');
        const src = r.is_fake ? 'LOCAL TEST' : 'interakt';
        console.log('  ' + pad(when, 17) + pad(r.event_type, 26) + pad(src, 12) + pad(r.from_number, 15) + pad(result, 22) + (r.body || '').replace(/\n/g, ' ⏎ '));
      }

      // ONLY real ones count. A local test proves the CRM works; it proves
      // nothing whatsoever about whether Interakt will deliver.
      const real = ev.rows.filter(r => r.event_type === 'message_received' && !r.is_fake).length;
      const fake = ev.rows.filter(r => r.event_type === 'message_received' && r.is_fake).length;
      const otherReal = ev.rows.filter(r => r.event_type !== 'message_received' && !r.is_fake).length;
      console.log('');
      if (real) {
        console.log(`  ✓ ${real} incoming customer message(s) delivered BY INTERAKT. Incoming messages work.`);
      } else if (otherReal) {
        console.log('  ⚠ Interakt is delivering events, but NOT ONE incoming customer message.');
        console.log(`    (${otherReal} real event(s) here, all other types${fake ? `; ${fake} message_received came from fake-inbound.js, not Interakt` : ''}.)`);
        console.log('');
        console.log('    The webhook is reachable and the signature passes — those other events');
        console.log('    prove both. So the message is not leaving Interakt. Check, in order:');
        console.log('      1. Does the message appear in Interakt\'s own Inbox? If not, it never');
        console.log('         reached them — wrong number, or sent from the business number itself.');
        console.log('      2. Developer Settings — is there a per-event toggle for incoming messages?');
        console.log('      3. Is a Workflow/chatbot handling the message before the webhook fires?');
        console.log('      4. Plan: incoming messages need Advanced or Enterprise (Growth does not');
        console.log('         include them). If you are already on Advanced, this is a support ticket.');
      } else if (fake) {
        console.log(`  ⚠ ${fake} message_received, but ALL from fake-inbound.js. Interakt has delivered nothing.`);
      } else {
        console.log('  ⚠ No incoming customer messages at all.');
      }
    }

    // Leads the webhook has created, so "did it work" needs no interpretation.
    const leads = await pool.query(
      `SELECT id, name, mobile, status, created_at
         FROM leads WHERE lead_source = 'WhatsApp'
        ORDER BY id DESC LIMIT 5`);
    console.log(`\n  Leads created from WhatsApp: ${leads.rowCount}`);
    for (const l of leads.rows) {
      console.log(`    #${l.id}  ${pad(l.name || '(no name)', 22)} ${pad(l.mobile, 16)} ${l.status || 'New Lead'}`);
    }

    const skips = await pool.query(
      `SELECT reason, COUNT(*)::int n FROM wa_send_skips GROUP BY reason ORDER BY n DESC LIMIT 5`
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (skips.rowCount) {
      console.log('\n  Recent refusals:');
      for (const s of skips.rows) console.log(`    ${s.n} × ${s.reason}`);
    }
    console.log('');
  } catch (e) {
    console.error('\n  Could not read the database:', e.message);
    console.error('  Run this from the backend/ folder, where .env has DATABASE_URL.\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
