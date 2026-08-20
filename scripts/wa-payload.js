#!/usr/bin/env node
'use strict';

/**
 * Show the RAW payload Interakt sent, for one event type.
 *
 * Every webhook that passes the signature check is stored whole in
 * wa_events.payload before anything tries to interpret it — including the types
 * the CRM does not handle. So the answer to "does Interakt tell us X?" is
 * already sitting in your database; it just has nobody reading it out.
 *
 *   node scripts/wa-payload.js                       list what types exist
 *   node scripts/wa-payload.js workflow_response_update
 *   node scripts/wa-payload.js message_received 3    the last 3 of that type
 *
 * Printed in full and unedited. The point is to see what is actually there,
 * which a summary would defeat.
 */

require('dotenv').config();
const { Pool } = require('pg');

const type  = process.argv[2] || null;
const count = Math.min(Math.max(Number(process.argv[3]) || 1, 1), 10);

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } }
    : {}
);

(async () => {
  try {
    if (!type) {
      const t = await pool.query(
        `SELECT event_type, COUNT(*)::int n, MAX(received_at) newest
           FROM wa_events GROUP BY event_type ORDER BY newest DESC`);
      console.log('\n  Event types Interakt has actually sent you:\n');
      for (const r of t.rows) {
        console.log(`    ${String(r.n).padStart(4)} ×  ${r.event_type.padEnd(28)} newest ${new Date(r.newest).toLocaleString('en-IN')}`);
      }
      console.log('\n  Then: node scripts/wa-payload.js <type>\n');
      return;
    }

    const ev = await pool.query(
      `SELECT id, event_type, received_at, payload
         FROM wa_events
        WHERE event_type = $1
        ORDER BY id DESC
        LIMIT $2`, [type, count]);

    if (!ev.rowCount) {
      console.log(`\n  No '${type}' event stored. Run with no argument to see which types exist.\n`);
      return;
    }

    for (const r of ev.rows) {
      console.log(`\n  ── #${r.id}  ${r.event_type}  ${new Date(r.received_at).toLocaleString('en-IN')} ${'─'.repeat(20)}\n`);
      console.log(JSON.stringify(r.payload, null, 2));
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
