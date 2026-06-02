/**
 * Logs controller  (Super Admin only)
 *
 * GET /api/logs/logins     — paginated login attempts
 * GET /api/logs/activity   — paginated write actions
 */

const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// ── Login logs ───────────────────────────────────────────────────────────────
function getLoginLogs(req, res, next) {
  handle(req, res, next, async () => {
    const limit  = Math.min(parseInt(req.query.limit  || 50, 10), 200);
    const offset = parseInt(req.query.offset || 0, 10);
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const success = req.query.success !== undefined ? req.query.success === 'true' : null;

    const conditions = [];
    const params     = [];

    if (userId !== null)  { params.push(userId);  conditions.push(`ll.user_id = $${params.length}`); }
    if (success !== null) { params.push(success);  conditions.push(`ll.success = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      pool.query(`
        SELECT ll.id, ll.user_id, u.name AS user_name, ll.email,
               ll.success, ll.ip_address, ll.user_agent, ll.created_at
          FROM login_logs ll
          LEFT JOIN users u ON u.id = ll.user_id
          ${where}
         ORDER BY ll.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) AS total FROM login_logs ll ${where}`, params),
    ]);

    res.json({ items: rows.rows, total: Number(count.rows[0].total) });
  });
}

// ── Activity logs ─────────────────────────────────────────────────────────────
function getActivityLogs(req, res, next) {
  handle(req, res, next, async () => {
    const limit  = Math.min(parseInt(req.query.limit  || 50, 10), 200);
    const offset = parseInt(req.query.offset || 0, 10);
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const action = req.query.action  || null;
    const entity = req.query.entity  || null;

    const conditions = [];
    const params     = [];

    if (userId) { params.push(userId); conditions.push(`al.user_id = $${params.length}`); }
    if (action) { params.push(action); conditions.push(`al.action  = $${params.length}`); }
    if (entity) { params.push(entity); conditions.push(`al.entity  = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      pool.query(`
        SELECT al.id, al.user_id, al.user_name, al.action,
               al.entity, al.entity_id, al.description, al.created_at
          FROM activity_logs al
          ${where}
         ORDER BY al.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) AS total FROM activity_logs al ${where}`, params),
    ]);

    res.json({ items: rows.rows, total: Number(count.rows[0].total) });
  });
}

module.exports = { getLoginLogs, getActivityLogs };
