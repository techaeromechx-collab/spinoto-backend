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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected error on idle client', err);
});

module.exports = { pool };
