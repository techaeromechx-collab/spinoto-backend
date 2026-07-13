'use strict';
// One-off backfill for migrations 085/086 (public_token routing identifiers).
//
// Assigns a random public_token to every existing row in leads,
// appointments, estimates, purchase_invoices, and customer_invoices that
// doesn't have one yet, and backfills customer_identities with one row per
// distinct mobile number seen across appointments, customer_invoices, and
// standalone estimates.
//
// Run once, after migrations 085 and 086 have been applied:
//   node backend/scripts/backfill_public_tokens.js
//
// Safe to re-run — rows that already have a public_token (or mobiles that
// already have a customer_identities row) are skipped.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(10).toString('base64url');
}

// Assigns a unique token to every row in `table` where public_token IS NULL,
// one UPDATE per row (so a collision on one row can't affect the others).
async function backfillTable(client, table) {
  const { rows } = await client.query(`SELECT id FROM ${table} WHERE public_token IS NULL`);
  console.log(`[backfill] ${table}: ${rows.length} row(s) need a token.`);

  let done = 0;
  for (const row of rows) {
    let attempts = 0;
    for (;;) {
      attempts++;
      const token = generateToken();
      try {
        await client.query(`UPDATE ${table} SET public_token = $1 WHERE id = $2`, [token, row.id]);
        done++;
        break;
      } catch (err) {
        if (err.code === '23505' && attempts < 5) continue; // collision, retry with a new token
        throw err;
      }
    }
  }
  console.log(`[backfill] ${table}: done — ${done} row(s) assigned a token.`);
}

async function backfillCustomerIdentities(client) {
  const { rows: mobiles } = await client.query(`
    SELECT DISTINCT mobile FROM (
      SELECT mobile FROM appointments       WHERE mobile IS NOT NULL AND mobile <> ''
      UNION
      SELECT mobile FROM customer_invoices  WHERE mobile IS NOT NULL AND mobile <> ''
      UNION
      SELECT mobile FROM estimates          WHERE mobile IS NOT NULL AND mobile <> ''
    ) m
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_identities ci WHERE ci.mobile = m.mobile
    )
  `);
  console.log(`[backfill] customer_identities: ${mobiles.length} mobile(s) need an identity.`);

  let done = 0;
  for (const { mobile } of mobiles) {
    let attempts = 0;
    for (;;) {
      attempts++;
      const token = generateToken();
      try {
        await client.query(
          `INSERT INTO customer_identities (mobile, public_token) VALUES ($1, $2)`,
          [mobile, token]
        );
        done++;
        break;
      } catch (err) {
        if (err.code === '23505' && attempts < 5) continue; // token collision, retry
        throw err;
      }
    }
  }
  console.log(`[backfill] customer_identities: done — ${done} mobile(s) assigned an identity.`);
}

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    for (const table of ['leads', 'appointments', 'estimates', 'purchase_invoices', 'customer_invoices']) {
      await backfillTable(client, table);
    }
    await backfillCustomerIdentities(client);
    console.log('[backfill] All done.');
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
