'use strict';

/**
 * Admin CRUD for master-data API keys (Settings → API Keys).
 *
 * Human-authenticated and permission-gated — the opposite side of
 * middleware/apiKey.middleware.js, which authenticates the machines these
 * keys belong to.
 *
 * There is no update. A key's scopes are fixed at creation: silently widening
 * a key a partner already holds is a change of access with no moment where
 * anyone decided to grant it. Wider access means a new key and a revoked old
 * one, which leaves a trail.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { generateKey } = require('../utils/apiKeys');
const { SCOPES, validateScopes } = require('../utils/apiScopes');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch(err => {
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error: 'API keys are not set up yet. Database is behind the code — run npm run db:migrate.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: err.errors[0]?.message || 'Invalid input' });
    }
    next(err);
  });
}

const idParam = z.coerce.number().int().positive();

/**
 * The columns safe to list. key_hash is absent on purpose and must stay that
 * way: a screen that renders it, or an admin who copies it out of a network
 * tab, turns a hash-only design back into a stored-credential one.
 */
const LIST_COLS = `
  k.id, k.name, k.key_prefix, k.scopes, k.notes,
  k.created_at, k.last_used_at, k.expires_at, k.revoked_at,
  u.name  AS created_by_name,
  ru.name AS revoked_by_name,
  (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > NOW())) AS is_active`;

function listApiKeys(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT ${LIST_COLS}
         FROM api_keys k
         LEFT JOIN users u  ON u.id  = k.created_by
         LEFT JOIN users ru ON ru.id = k.revoked_by
        ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`
    );
    // Revoked keys are listed too, at the bottom. "Which partners have we cut
    // off, and when" is a question that gets asked, and deleting the row makes
    // it unanswerable.
    res.json({ items: r.rows, available_scopes: SCOPES });
  });
}

const createSchema = z.object({
  name:   z.string().trim().min(1).max(120),
  scopes: z.array(z.string()).min(1),
  notes:  z.string().trim().max(2000).optional().nullable(),
  // Optional. An expiry is the difference between "we gave a contractor
  // access" and "we gave a contractor access forever".
  expires_at: z.string().optional().nullable(),
});

function createApiKey(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);

    const v = validateScopes(data.scopes);
    if (!v.ok) {
      return res.status(422).json({
        error: v.reason || `Unknown scope: ${v.invalid.join(', ')}`,
        valid_scopes: Object.keys(SCOPES),
      });
    }

    let expires = null;
    if (data.expires_at) {
      const d = new Date(data.expires_at);
      if (isNaN(d)) return res.status(422).json({ error: 'expires_at is not a valid date' });
      if (d <= new Date()) return res.status(422).json({ error: 'expires_at must be in the future' });
      expires = d.toISOString();
    }

    const { key, prefix, hash } = generateKey();

    const r = await pool.query(
      `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, notes, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, key_prefix, scopes, notes, created_at, expires_at`,
      [data.name, prefix, hash, data.scopes, data.notes || null, expires, req.user?.id || null]
    );

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'api_keys',
      entityId: r.rows[0].id,
      // The scopes are in the log deliberately: "who granted pricing access to
      // an outside party, and when" is exactly the question this answers.
      description: `Issued API key "${data.name}" (${prefix}) with scopes: ${data.scopes.join(', ')}`,
    });

    // 201 with the ONLY copy of the key that will ever exist.
    res.status(201).json({
      item: r.rows[0],
      key,
      warning: 'Copy this key now — it is stored only as a hash and cannot be shown again. If it is lost, revoke it and issue a new one.',
    });
  });
}

function revokeApiKey(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // Guarded on revoked_at IS NULL so a second revoke is a no-op rather than
    // rewriting who revoked it and when — that history is the point.
    const r = await pool.query(
      `UPDATE api_keys
          SET revoked_at = NOW(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, name, key_prefix, revoked_at`,
      [id, req.user?.id || null]
    );

    if (!r.rows[0]) {
      const exists = await pool.query('SELECT id, revoked_at FROM api_keys WHERE id = $1', [id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'API key not found' });
      return res.status(409).json({ error: 'This key is already revoked', revoked_at: exists.rows[0].revoked_at });
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'api_keys',
      entityId: id,
      description: `Revoked API key "${r.rows[0].name}" (${r.rows[0].key_prefix})`,
    });

    res.json({ item: r.rows[0] });
  });
}

module.exports = { listApiKeys, createApiKey, revokeApiKey };
