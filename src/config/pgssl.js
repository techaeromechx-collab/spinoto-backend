'use strict';

/**
 * Should this connection use TLS, and should it verify the certificate?
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * Because two places connect to Postgres — the app (src/config/db.js) and the
 * migrator (db/migrate.js) — and they used to answer this question
 * differently. The app derived SSL from NODE_ENV; the migrator hardcoded
 * `rejectUnauthorized: false`.
 *
 * That disagreement is not cosmetic. It means `npm run db:migrate` can succeed
 * against a database the application then cannot connect to — you deploy, the
 * migrations report success, and the server will not start. Both callers now
 * import this, so there is one answer and it cannot drift.
 *
 * ── Why NODE_ENV was the wrong input ────────────────────────────────────────
 *
 * The old rule was "production means TLS". But whether TLS is available is a
 * property of the DATABASE, not of the app's build mode:
 *
 *   Postgres on the same droplet   NODE_ENV=production, and no TLS at all.
 *                                  The old rule forced TLS on and the
 *                                  connection was refused — with, in the
 *                                  runbook's own words, no useful error.
 *   DO Managed Postgres            TLS required, signed by DigitalOcean's own
 *                                  CA. The old rule turned verification on
 *                                  against a CA Node does not trust, so it
 *                                  failed with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * So the host decides, not the environment. Both deploy runbooks in this repo
 * prescribe exactly this change; this is the union of the two, so it is correct
 * for either target and you do not have to pick one to make it work.
 *
 * ── The rules, in order ─────────────────────────────────────────────────────
 *
 *   1. `sslmode=` in the connection string wins. It is the standard way to say
 *      this and it travels with the URL, so staging and production can differ
 *      without a code change.
 *   2. Otherwise: TLS in production UNLESS the host is local. A local socket
 *      has nothing to intercept, and demanding TLS from a Postgres that does
 *      not offer it is the failure above.
 *   3. Verification: a CA at PGSSL_CA_PATH is verified properly. PGSSL_NO_VERIFY
 *      turns verification off — it works, and it drops MITM protection, so it
 *      is an escape hatch and not a destination.
 */

const fs = require('fs');

/** Hosts where TLS is meaningless — nothing sits between the app and the socket. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * @param {string} [url]  the connection string; defaults to DATABASE_URL
 * @returns {false | { ca?: string, rejectUnauthorized: boolean }} a `pg` ssl option
 */
function pgSsl(url = process.env.DATABASE_URL || '') {
  // ── 1. sslmode= in the URL is explicit and wins ──────────────────────────
  const mode = /[?&]sslmode=([a-z-]+)/i.exec(url)?.[1]?.toLowerCase();

  let wantsSsl;
  if (mode) {
    // 'disable' and 'allow'/'prefer' → no TLS. 'prefer' would ideally try TLS
    // and fall back, which node-postgres cannot express; treating it as off
    // keeps a local database working, which is what anyone writing 'prefer'
    // on a local URL meant.
    wantsSsl = ['require', 'verify-ca', 'verify-full'].includes(mode);
  } else {
    // ── 2. No sslmode: the HOST decides, not NODE_ENV ─────────────────────
    wantsSsl = process.env.NODE_ENV === 'production' && !LOCAL_HOSTS.has(hostOf(url));
  }

  if (!wantsSsl) return false;

  // ── 3. Verify against a real CA when we have one ─────────────────────────
  //
  // DO Managed Postgres signs with its own CA — download ca-certificate.crt
  // from the cluster's connection panel and point PGSSL_CA_PATH at it.
  //
  // Read once at module load. A cert that is missing or unreadable must be
  // loud: falling back to unverified TLS would mean the one setting whose
  // entire job is verification silently doing nothing.
  const caPath = process.env.PGSSL_CA_PATH;
  if (caPath) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  // verify-full/verify-ca asked for verification explicitly, so honour it even
  // without a CA file — Node will use its built-in trust store, which is right
  // for a publicly-trusted certificate.
  if (mode === 'verify-full' || mode === 'verify-ca') {
    return { rejectUnauthorized: true };
  }

  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== 'true' };
}

/** One line at boot saying what was decided, so a TLS failure is diagnosable. */
function describePgSsl(ssl) {
  if (ssl === false) return 'off (local or sslmode=disable)';
  if (ssl.ca) return 'on, verified against PGSSL_CA_PATH';
  return ssl.rejectUnauthorized
    ? 'on, verified against the system trust store'
    : 'on, NOT verified (PGSSL_NO_VERIFY=true)';
}

module.exports = { pgSsl, describePgSsl };
