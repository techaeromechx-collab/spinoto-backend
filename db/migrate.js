const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { pgSsl, describePgSsl } = require('../src/config/pgssl');

const migrationsDir = path.join(__dirname, 'migrations');

async function migrate() {
  // The SAME ssl decision the app makes — see src/config/pgssl.js.
  //
  // This used to be `isProduction ? { rejectUnauthorized: false } : false`,
  // which is not what src/config/db.js did. Migrations would apply happily
  // over an unverified connection and then the server would refuse to start
  // against the very database that had just been migrated. One function now,
  // imported by both, so they cannot drift apart again.
  const ssl = pgSsl();
  console.log(`[migrate] ssl: ${describePgSsl(ssl)}`);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl,
  });
  await client.connect();

  try {
    // ── 1. Ensure tracking table exists ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // ── 2. Get already-applied migrations ────────────────────────────────────
    const { rows } = await client.query(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(rows.map(r => r.filename));

    // ── 3. Read & sort all .sql files ────────────────────────────────────────
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`[migrate] ${files.length} total migrations, ${applied.size} already applied.`);

    let ran = 0;
    let skipped = 0;

    for (const file of files) {
      if (applied.has(file)) {
        skipped++;
        continue; // already ran — skip
      }

      process.stdout.write(`[migrate] Applying ${file}... `);

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log('✅');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log(`❌  ${err.message}`);
        // Stop on first error — don't apply migrations out of order
        process.exit(1);
      }
    }

    if (ran === 0) {
      console.log('[migrate] Nothing to apply — database is up to date.');
    } else {
      console.log(`[migrate] Done — ${ran} migration(s) applied, ${skipped} skipped.`);
    }

  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
