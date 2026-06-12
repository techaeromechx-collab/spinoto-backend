const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

// Verify the server certificate by default (Neon uses publicly-trusted CAs,
// so this works out of the box). Set PGSSL_NO_VERIFY=true only for hosts
// with self-signed certs — it disables MITM protection.
const sslConfig = isProduction
  ? { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== 'true' }
  : false;

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
