'use strict';

const { pool } = require('../config/db');
const { parseKey, verifyKey, keyStatus } = require('../utils/apiKeys');

/**
 * Authenticate a machine caller by API key and check it holds a scope.
 *
 *   router.get('/services', requireApiScope('services:read'), handler)
 *
 * This is NOT requireAuth. A key belongs to a system, not a person: there is
 * no req.user, no role and no hub, and nothing here may be reused to serve a
 * logged-in human. Keeping the two paths separate is what stops a partner key
 * ever inheriting a staff permission by accident.
 */

// last_used_at is for the admin screen ("is anyone still using this?"), not
// analytics. Writing it on every request would mean a database write per API
// call — enough on a serverless Postgres to stop the compute ever suspending,
// which is most of what a small bill is made of. Once every 15 minutes answers
// the question just as well.
const LAST_USED_THROTTLE_MS = 15 * 60 * 1000;

function requireApiScope(...requiredScopes) {
  if (!requiredScopes.length) throw new Error('requireApiScope needs at least one scope');

  return async function apiKeyGate(req, res, next) {
    try {
      const parsed = parseKey(req.headers['x-api-key']);
      // Malformed or missing — answer without touching the database. An
      // unauthenticated caller must not be able to make us run a query.
      if (!parsed) return unauthorized(res);

      const { rows } = await pool.query(
        `SELECT id, name, key_hash, scopes, revoked_at, expires_at, last_used_at
           FROM api_keys
          WHERE key_prefix = $1`,
        [parsed.prefix]
      );
      const row = rows[0];

      // Verify BEFORE checking status, and always verify even when the prefix
      // matched nothing: otherwise the response time tells an attacker which
      // prefixes exist.
      const hashOk = verifyKey(parsed.key, row ? row.key_hash : 'x'.repeat(64));
      if (!row || !hashOk) return unauthorized(res);

      const status = keyStatus(row);
      // Deliberately the same 401 and the same message as a bad key. A caller
      // holding a revoked key learns only that it does not work — not that it
      // was once real, which would confirm they had a valid credential.
      if (!status.ok) return unauthorized(res);

      const held = new Set(row.scopes || []);
      const missing = requiredScopes.filter(s => !held.has(s));
      if (missing.length) {
        // 403, not 401, and the missing scope IS named. The key is genuine and
        // its holder is entitled to know what to ask you for.
        return res.status(403).json({
          error: 'Insufficient scope',
          required: requiredScopes,
          missing,
        });
      }

      req.apiKey = { id: row.id, name: row.name, scopes: [...held] };
      touchLastUsed(row);
      return next();
    } catch (err) {
      // The table only exists from migration 103. Say so rather than emitting
      // a bare 500 — same treatment the invoice controllers give a missing
      // column (42703).
      if (err && err.code === '42P01') {
        console.error('[apiKey] api_keys table missing — run: npm run db:migrate');
        return res.status(503).json({
          error: 'API access is not configured yet. Database is behind the code — run npm run db:migrate.',
          code: 'MIGRATION_PENDING',
        });
      }
      return next(err);
    }
  };
}

function unauthorized(res) {
  return res.status(401).json({ error: 'Invalid or missing API key' });
}

/**
 * Fire-and-forget, throttled, and never able to fail a request: this is
 * bookkeeping, and a request that returned good data should not turn into a
 * 500 because a metadata write lost a race.
 */
function touchLastUsed(row) {
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
  pool
    .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
    .catch(err => console.warn('[apiKey] last_used_at update failed:', err.message));
}

module.exports = { requireApiScope, LAST_USED_THROTTLE_MS };
