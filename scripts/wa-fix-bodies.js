#!/usr/bin/env node
'use strict';

/**
 * Make the messages you have ALREADY received readable.
 *
 * When a customer taps a button or a list row in your Interakt flow, WhatsApp
 * sends an interactive reply rather than text, and Interakt hands it over as a
 * JSON string. Every one of those already in the database was stored verbatim:
 *
 *   {"type": "list_reply", "list_reply": {"id": "without_faq__c078…", "title": "AC Service/Repair"}}
 *
 * The webhook now unwraps these as they arrive. This rewrites the ones that
 * came in before it did.
 *
 *   node scripts/wa-fix-bodies.js            show what WOULD change, change nothing
 *   node scripts/wa-fix-bodies.js --apply    write the changes
 *
 * It uses the SAME unwrapInteractive() the webhook uses — not a second copy of
 * the rule in SQL, which would be free to disagree with it.
 *
 * Nothing is destroyed: wa_events still holds the original payload of every
 * message, ids included, so this is reversible from the source data.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { unwrapInteractive } = require('../src/services/waInboundLead.service');

const APPLY = process.argv.includes('--apply');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } }
    : {}
);

(async () => {
  try {
    // Only inbound, only rows that look like JSON. The LIKE is a cheap filter;
    // unwrapInteractive() below is the actual decision, so a row that merely
    // starts with a brace but is not one of these shapes comes back unchanged
    // and is skipped.
    const rows = await pool.query(
      `SELECT id, body_rendered
         FROM wa_messages
        WHERE direction = 'in'
          AND body_rendered LIKE '{%'
        ORDER BY id`);

    const changes = [];
    for (const r of rows.rows) {
      const next = unwrapInteractive(r.body_rendered);
      if (next !== r.body_rendered) changes.push({ id: r.id, from: r.body_rendered, to: next });
    }

    if (!rows.rowCount) {
      console.log('\n  No inbound message starts with "{". Nothing to do.\n');
      return;
    }

    console.log(`\n  ${rows.rowCount} inbound message(s) look like JSON; ${changes.length} can be unwrapped.\n`);
    for (const c of changes) {
      console.log(`  #${String(c.id).padEnd(6)} ${JSON.stringify(c.from).slice(0, 72)}`);
      console.log(`           → ${JSON.stringify(c.to)}`);
    }

    const skipped = rows.rowCount - changes.length;
    if (skipped) {
      console.log(`\n  ${skipped} left alone — brace-shaped but not a reply this understands.`);
    }

    if (!changes.length) { console.log(''); return; }

    if (!APPLY) {
      console.log('\n  Dry run. Re-run with --apply to write these.\n');
      return;
    }

    // One transaction: either the whole conversation reads correctly or none of
    // it does. A half-rewritten thread is the hardest state to reason about
    // later, because it looks like the tool worked.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const ch of changes) {
        await c.query('UPDATE wa_messages SET body_rendered = $2 WHERE id = $1', [ch.id, ch.to]);
      }
      await c.query('COMMIT');
      console.log(`\n  ✓ ${changes.length} message(s) rewritten.\n`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    console.error('\n  Failed:', e.message);
    console.error('  Run this from the backend/ folder, where .env has DATABASE_URL.\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
