const { Pool } = require('pg');
const { pgSsl, describePgSsl } = require('./pgssl');

// Whether to use TLS, and whether to verify the certificate, is decided in
// config/pgssl.js — and db/migrate.js imports the SAME function.
//
// That sharing is the point. These two used to disagree: this file derived SSL
// from NODE_ENV while the migrator hardcoded `rejectUnauthorized: false`. The
// consequence is a deploy where `npm run db:migrate` reports success against a
// database the server then cannot connect to.
const sslConfig = pgSsl();

// Said out loud once at boot. A TLS failure from node-postgres is famously
// unhelpful ("the app will refuse to connect and you will not get a useful
// error message", per this repo's own deploy runbook), so the one line that
// makes it diagnosable is worth printing.
console.log(`[pg] ssl: ${describePgSsl(sslConfig)}`);

/* ── The session timezone ──────────────────────────────────────────────────
   The workshop is in India; a managed Postgres defaults to UTC and nothing
   here ever told it otherwise. That decides what `timestamptz::date`,
   CURRENT_DATE and date_trunc() mean — about a hundred places across this
   codebase — so a payment taken at 3am IST was being filed against yesterday,
   and a follow-up completed at 2am IST counted against the wrong day's
   compliance.

   Sent in the STARTUP PACKET (`options`), not as a `SET TIME ZONE` after
   connecting. A SET has to be issued once per connection, and a pool opens new
   connections whenever it pleases — through the 'connect' event, through a
   reconnect after a network blip. Miss one and a single query, occasionally,
   silently answers in UTC. Intermittent and invisible is the worst shape this
   bug could take; the startup packet makes it impossible, because the session
   is never in any other zone.

   This does NOT change how timestamps travel: node-postgres parses timestamptz
   using the offset the server sends, so JS Date objects remain the same
   absolute instants they always were. What changes is only the answer to
   "which calendar day is this", which is the question that was wrong. */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  options: '-c timezone=Asia/Kolkata',
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected error on idle client', err);
});

module.exports = { pool };
