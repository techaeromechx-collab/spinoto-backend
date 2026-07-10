'use strict';
// One-off fix for a bug in the original hubCode.js: it took a word's literal
// first character instead of its first letter, so hub names with
// parentheses/punctuation right at the start of a word (e.g. "Kaarwash_24_Gota
// (Spinoto)") produced broken codes like "K(S". Fixed in hubCode.js.
//
// This finds any EXISTING hub_code containing a non-alphanumeric character
// and resets it to NULL — every already-correct hub_code (the vast majority)
// is left completely untouched. Run this, then re-run backfill_hub_codes.js
// to regenerate just the cleared ones with the fixed algorithm.
//
//   node backend/scripts/fix_broken_hub_codes.js
//   node backend/scripts/backfill_hub_codes.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, hub_name, hub_code FROM hubs
       WHERE hub_code IS NOT NULL AND hub_code !~ '^[A-Z0-9]+$'`
    );

    console.log(`[fix] ${rows.length} hub(s) have a broken hub_code:`);
    for (const h of rows) {
      console.log(`[fix]  hub #${h.id} "${h.hub_name}" — was "${h.hub_code}", clearing`);
    }

    if (rows.length > 0) {
      await client.query(`UPDATE hubs SET hub_code = NULL WHERE id = ANY($1)`, [rows.map(r => r.id)]);
    }

    console.log(`[fix] Done — ${rows.length} cleared. Now run backfill_hub_codes.js to regenerate them.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[fix] Fatal:', err.message);
  process.exit(1);
});
