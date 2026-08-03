'use strict';

const crypto = require('crypto');

/**
 * Generation and verification of master-data API keys.
 *
 * Key shape:  spk_live_<8 hex>_<48 hex>
 *             └── prefix ────┘ └ secret ┘
 *
 * The prefix is stored in clear and is the lookup key, so verifying a request
 * is one indexed row fetch. The secret half is never stored — only a SHA-256
 * of the whole key. See migration 103 for why SHA-256 rather than bcrypt.
 *
 * `spk_` makes the string greppable in logs and searchable in secret scanners
 * if one is ever leaked into a repository.
 */

const PREFIX_NS = 'spk';
const SECRET_BYTES = 24;   // 48 hex chars — 192 bits
const PREFIX_BYTES = 4;    // 8 hex chars

/** Live vs test, so a staging key can never be mistaken for a production one. */
function envTag() {
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

/**
 * Mint a new key. Returns { key, prefix, hash }.
 * `key` is the ONLY time the full value exists — hand it to the caller and
 * forget it.
 */
function generateKey() {
  const prefix = `${PREFIX_NS}_${envTag()}_${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const key = `${prefix}_${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Split an inbound key into its lookup prefix and the whole string.
 * Returns null for anything malformed, so the caller never runs a query on
 * attacker-shaped input.
 */
function parseKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  // ns_env_prefix_secret — exactly four parts.
  const parts = key.split('_');
  if (parts.length !== 4) return null;
  const [ns, env, pfx, secret] = parts;
  if (ns !== PREFIX_NS) return null;
  if (env !== 'live' && env !== 'test') return null;
  if (!/^[0-9a-f]+$/.test(pfx) || !/^[0-9a-f]+$/.test(secret)) return null;
  return { key, prefix: `${ns}_${env}_${pfx}` };
}

/**
 * Constant-time comparison of the presented key against a stored hash.
 *
 * timingSafeEqual rather than `===`: a plain comparison returns as soon as two
 * bytes differ, and that difference is measurable. Both sides are fixed-length
 * hex digests here, so the length guard can never itself leak anything.
 */
function verifyKey(key, storedHash) {
  const a = Buffer.from(hashKey(key), 'hex');
  let b;
  try {
    b = Buffer.from(String(storedHash || ''), 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Is this row usable right now? Reasons are for logs, never for the client. */
function keyStatus(row, now = new Date()) {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at && new Date(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

module.exports = {
  generateKey, hashKey, parseKey, verifyKey, keyStatus,
  PREFIX_NS, SECRET_BYTES,
};
