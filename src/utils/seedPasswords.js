/**
 * On boot, ensure the seeded Super Admin has a bcrypt hash matching the
 * password documented in the README. Lets you log in immediately after
 * running seed.sql without manually generating a hash.
 *
 * Safe to run on every boot — only updates a user when the stored hash
 * does NOT already validate the documented password.
 */
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

const SEED_USERS = [
  { email: 'super@spinoto.local', password: 'super123' },
];

async function ensureSeedPasswords() {
  // SAFETY: never run in production — this would silently reset the super
  // admin password back to the documented dev password on every boot,
  // undoing any password change the admin made.
  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED_PASSWORDS !== 'true') {
    return;
  }
  for (const { email, password } of SEED_USERS) {
    const r = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    if (r.rowCount === 0) continue;
    const ok = await bcrypt.compare(password, r.rows[0].password_hash).catch(() => false);
    if (ok) continue;
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, r.rows[0].id]);
    console.log(`[seed] refreshed password for ${email}`);
  }
}

module.exports = { ensureSeedPasswords };
