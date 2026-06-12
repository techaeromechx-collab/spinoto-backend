const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../config/db');
const { logLogin } = require('../services/activityLog.service');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.is_active, u.is_super_admin,
              u.mobile, u.department, u.joining_date, u.profile_photo,
              u.notification_settings, u.manager_id, u.hub_id, u.last_login,
              m.name AS manager_name,
              h.hub_name,
              COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       LEFT JOIN users m ON m.id = u.manager_id
       LEFT JOIN hubs h ON h.id = u.hub_id
       WHERE u.email = $1
       GROUP BY u.id, m.name, h.hub_name`,
      [email.toLowerCase()]
    );
    const ip        = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (r.rowCount === 0) {
      logLogin({ userId: null, email, success: false, ip, userAgent });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = r.rows[0];

    // Verify the password BEFORE revealing account state — returning
    // "Account is disabled" on a bad password would confirm the account
    // exists (user enumeration).
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logLogin({ userId: user.id, email, success: false, ip, userAgent });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      logLogin({ userId: user.id, email, success: false, ip, userAgent });
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    // Record last login — fire-and-forget
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => {});
    logLogin({ userId: user.id, email, success: true, ip, userAgent });

    res.json({
      token,
      user: {
        id:                   user.id,
        name:                 user.name,
        email:                user.email,
        is_super_admin:       user.is_super_admin,
        permissions:          user.permissions,
        mobile:               user.mobile        || null,
        department:           user.department    || null,
        joining_date:         user.joining_date  || null,
        profile_photo:        user.profile_photo || null,
        notification_settings: user.notification_settings || {},
        manager_id:           user.manager_id   || null,
        manager_name:         user.manager_name || null,
        hub_id:               user.hub_id       || null,
        hub_name:             user.hub_name     || null,
        last_login:           user.last_login || null,
      },
    });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid login payload' });
    next(err);
  }
}

module.exports = { login };
