'use strict';
// One-off backfill for migration 084 (human-readable hub_code).
//
// Generates hub_code for every existing hub that doesn't already have one,
// processed in hub-id order so results are reproducible if re-run. Run this
// BEFORE backfill_appointment_codes.js — appointment codes are built from
// hub_code, so hubs need theirs first.
//
// Run once, after applying migration 084:
//   node backend/scripts/backfill_hub_codes.js
//
// Safe to re-run — hubs that already have a hub_code are skipped.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const { baseHubCode, resolveUniqueCode } = require('../src/utils/hubCode');

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows: existing } = await client.query(
      `SELECT hub_code FROM hubs WHERE hub_code IS NOT NULL`
    );
    const usedCodes = new Set(existing.map(r => r.hub_code));

    const { rows: hubs } = await client.query(
      `SELECT id, hub_name FROM hubs WHERE hub_code IS NULL ORDER BY id ASC`
    );
    console.log(`[backfill] ${hubs.length} hub(s) need a hub_code.`);

    let done = 0;
    for (const hub of hubs) {
      const code = resolveUniqueCode(baseHubCode(hub.hub_name), usedCodes);
      usedCodes.add(code);
      await client.query(`UPDATE hubs SET hub_code = $1 WHERE id = $2`, [code, hub.id]);
      console.log(`[backfill]  hub #${hub.id} "${hub.hub_name}" -> ${code}`);
      done++;
    }

    console.log(`[backfill] Done — ${done} hub(s) assigned a code.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
