'use strict';

/**
 * integrationSettings.service.js — DB-stored provider credentials, readable
 * SYNCHRONOUSLY.
 *
 * The consumers of these values are synchronous by design and must stay so:
 * interakt.js's isConfigured() is called inline by the outbox worker and the
 * templates endpoint, and the webhook's signature check runs inside a 3-second
 * budget where an extra DB round trip is exactly what the ack-first design
 * exists to avoid. So this module keeps an in-memory cache and exposes a sync
 * getter; the cache is primed at boot, refreshed on a timer, and updated
 * in-process the moment an admin saves — which is why a save takes effect
 * immediately on the instance that handled it and within a minute anywhere
 * else.
 *
 * ── Precedence ───────────────────────────────────────────────────────────────
 *
 * getSetting(key, envName): DB value if a row exists, else the env var, else
 * ''. The DB wins because it is the one an admin can see and change; the env
 * var stays as the fallback so a deployment configured the old way keeps
 * working without touching anything.
 *
 * ── Fails soft, deliberately ─────────────────────────────────────────────────
 *
 * A missing table (migration 152 not run) or an unreachable database leaves
 * the cache as it was — at worst empty, which makes every getter fall back to
 * env vars, which is exactly the pre-152 behaviour. Messaging configuration
 * must never be the thing that stops the server booting.
 */

const KNOWN_KEYS = Object.freeze([
  // ── WhatsApp (Interakt) ──
  'interakt_api_key',
  'interakt_webhook_secret',
  'whatsapp_test_number',
  // Whether advisors may attach a photo from their own computer — the
  // paperclip in the WhatsApp composer. Not a credential, and it is here
  // anyway: this table is "one value, read by the app, written from a settings
  // screen", which is exactly what it is, and a table of its own for a single
  // boolean would be a table to maintain forever.
  //
  // Stored as the string 'true' / 'false'. Never '' — putSetting DELETES the
  // row for an empty value, and an absent row means ON (see
  // whatsapp.library.controller's localUploadAllowed), so writing '' would
  // turn "switch it off" into "switch it on".
  //
  // No ENV_FALLBACK entry on purpose. There is no deployment configured the
  // old way to keep working — the setting did not exist before — and an env
  // var that silently overrode the screen would be a switch that does nothing
  // for reasons nobody can see from the CRM.
  'wa_allow_local_upload',
  // ── Payments (Razorpay) ──
  //
  // Note the ordering rule these obey and the WhatsApp ones do not: the
  // razorpay adapter used to read process.env into module CONSTANTS at import
  // time, so a value saved here would have changed nothing until the server was
  // restarted — the screen would say "saved from the database" while the
  // gateway kept using the old key. Those constants are now functions calling
  // getSetting(). If you add another credential here, check the same thing at
  // its consumer: a settings row that silently loses to a frozen constant is
  // worse than no settings row, because it looks like it worked.
  'razorpay_key_id',
  'razorpay_key_secret',
  'razorpay_webhook_secret',
  'public_api_base_url',
  'payment_link_ttl_days',
]);

const ENV_FALLBACK = Object.freeze({
  interakt_api_key:        'INTERAKT_API_KEY',
  interakt_webhook_secret: 'INTERAKT_WEBHOOK_SECRET',
  whatsapp_test_number:    'WHATSAPP_TEST_NUMBER',
  razorpay_key_id:         'RAZORPAY_KEY_ID',
  razorpay_key_secret:     'RAZORPAY_KEY_SECRET',
  razorpay_webhook_secret: 'RAZORPAY_WEBHOOK_SECRET',
  public_api_base_url:     'PUBLIC_API_BASE_URL',
  payment_link_ttl_days:   'PAYMENT_LINK_TTL_DAYS',
});

let cache = Object.create(null);
let primed = false;

/** Re-read every row. Called at boot, on the interval, and after every save. */
async function refreshIntegrationSettings(pool) {
  try {
    const r = await pool.query(`SELECT key, value FROM integration_settings`);
    const next = Object.create(null);
    for (const row of r.rows) next[row.key] = row.value;
    cache = next;
    primed = true;
  } catch (err) {
    if (err.code === '42P01') {
      // Migration 152 not run yet — env-only mode, silently. The table
      // appearing later is picked up by the interval without a restart.
      primed = true;
      return;
    }
    console.error('[integrationSettings] refresh failed:', err.message);
  }
}

/**
 * The current value for a key: DB row → env var → ''.
 * Synchronous by contract; see the module header for why.
 */
function getSetting(key) {
  const db = cache[key];
  if (db !== undefined && String(db).trim() !== '') return String(db).trim();
  const env = ENV_FALLBACK[key] ? (process.env[ENV_FALLBACK[key]] || '') : '';
  return env.trim();
}

/** Where the current value comes from — the UI says this out loud. */
function settingSource(key) {
  if (cache[key] !== undefined && String(cache[key]).trim() !== '') return 'database';
  if (ENV_FALLBACK[key] && (process.env[ENV_FALLBACK[key]] || '').trim() !== '') return 'environment';
  return null;
}

/**
 * Write (or clear) one key, stamped with who. Empty/null value DELETES the
 * row — falling back to env — rather than storing an empty string that would
 * shadow a working env var with nothing.
 *
 * Updates the in-process cache immediately, so the admin's next click sees
 * the value they just saved rather than a stale interval.
 */
async function putSetting(pool, key, value, userId = null) {
  if (!KNOWN_KEYS.includes(key)) {
    throw new Error(`Unknown integration setting '${key}'`);
  }
  const v = value == null ? '' : String(value).trim();
  if (!v) {
    await pool.query(`DELETE FROM integration_settings WHERE key = $1`, [key]);
    delete cache[key];
    return;
  }
  await pool.query(
    `INSERT INTO integration_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, v, userId]
  );
  cache[key] = v;
}

/**
 * Prime the cache and keep it fresh. Called once from server.js.
 * 60s matches the outbox tick — a key rotated on another instance is live
 * everywhere within a minute, the same latency the queue already has.
 */
function startIntegrationSettings(pool) {
  refreshIntegrationSettings(pool);
  const handle = setInterval(() => refreshIntegrationSettings(pool), 60 * 1000);
  if (typeof handle.unref === 'function') handle.unref();
}

module.exports = {
  KNOWN_KEYS, ENV_FALLBACK,
  getSetting, settingSource, putSetting,
  refreshIntegrationSettings, startIntegrationSettings,
  /** Test hook: has the first refresh happened? */
  _isPrimed: () => primed,
};
