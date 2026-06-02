/**
 * activityLog.service.js
 *
 * Lightweight helpers to record login attempts and write actions.
 * All writes are fire-and-forget — errors are swallowed so they never
 * break the main request flow.
 */

const { pool } = require('../config/db');

/**
 * Log a login attempt.
 * @param {object} opts
 * @param {number|null} opts.userId   - null on failed login
 * @param {string}      opts.email
 * @param {boolean}     opts.success
 * @param {string}      [opts.ip]
 * @param {string}      [opts.userAgent]
 */
function logLogin({ userId, email, success, ip, userAgent }) {
  pool.query(
    `INSERT INTO login_logs (user_id, email, success, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, email || null, success, ip || null, userAgent || null]
  ).catch(err => console.warn('[activityLog] login insert failed:', err.message));
}

/**
 * Log a write action (CREATE / UPDATE / DELETE).
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.userName
 * @param {string}  opts.action      - 'CREATE' | 'UPDATE' | 'DELETE'
 * @param {string}  opts.entity      - e.g. 'lead', 'appointment'
 * @param {string|number} opts.entityId
 * @param {string}  [opts.description]
 */
function logActivity({ userId, userName, action, entity, entityId, description }) {
  pool.query(
    `INSERT INTO activity_logs (user_id, user_name, action, entity, entity_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId || null, userName || null, action, entity, String(entityId || ''), description || null]
  ).catch(err => console.warn('[activityLog] activity insert failed:', err.message));
}

module.exports = { logLogin, logActivity };
