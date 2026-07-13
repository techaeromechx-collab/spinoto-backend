'use strict';

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Generates a random, URL-safe, non-enumerable public token for use in
// shareable detail-page URLs (e.g. /customers/:token, /estimates/:token).
//
// 10 random bytes, base64url-encoded -> 14 characters, ~80 bits of entropy —
// enough that guessing or enumerating another record's token is infeasible,
// while staying short and URL-friendly.
//
// No external dependency: nanoid's current major versions are ESM-only,
// which conflicts with this backend's CommonJS setup ("type": "commonjs" in
// package.json). crypto.randomBytes is built into Node and does the same
// job without adding a package.
// ─────────────────────────────────────────────────────────────────────────────
function generatePublicToken() {
  return crypto.randomBytes(10).toString('base64url');
}

// Runs `insertFn` (an async function that performs an INSERT using a freshly
// generated token, e.g. `(token) => client.query('INSERT ... VALUES ($1, ...)', [token, ...])`)
// and retries with a newly generated token if Postgres reports a unique
// violation (23505) — the token column is expected to be the only thing that
// could collide across retries. Collisions are astronomically unlikely at
// this entropy, but this keeps callers correct rather than assuming zero
// probability, mirroring the defensive spirit of the existing
// hubCode.js / appointmentCode.js utilities.
async function withTokenRetry(insertFn, { maxAttempts = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = generatePublicToken();
    try {
      return await insertFn(token);
    } catch (err) {
      if (err.code === '23505') { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

// Ensures a customer_identities row exists for `mobile` (idempotent — a
// no-op if one already exists, via ON CONFLICT DO NOTHING). Call this
// anywhere a mobile number could be seen for the first time — creating an
// appointment, a standalone estimate, or a customer profile — so every
// customer eventually has a public_token even if a customer_profiles row
// is never created for them (customer_profiles is optional/profile data;
// customer_identities is the routing identity and must exist for anyone
// who can be viewed as "a customer").
//
// `queryable` is either the shared pool or an in-transaction client — both
// expose `.query()`, matching the flexible pattern used elsewhere in this
// codebase.
async function ensureCustomerIdentity(queryable, mobile) {
  if (!mobile) return;
  await queryable.query(
    `INSERT INTO customer_identities (mobile, public_token)
     VALUES ($1, $2)
     ON CONFLICT (mobile) DO NOTHING`,
    [mobile, generatePublicToken()]
  );
}

// Resolves a public_token to the row's internal numeric id for a given
// table. `table` must always be a hardcoded string literal from trusted
// controller code (never derived from request input) — it's interpolated
// directly since Postgres doesn't allow parameterized identifiers, but
// every call site in this codebase passes a fixed table name.
async function resolveTokenToId(queryable, table, token) {
  if (!token) return null;
  const r = await queryable.query(`SELECT id FROM ${table} WHERE public_token = $1`, [token]);
  return r.rows[0]?.id ?? null;
}

module.exports = { generatePublicToken, withTokenRetry, ensureCustomerIdentity, resolveTokenToId };
