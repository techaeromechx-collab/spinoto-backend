const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// GET /api/notifications
// — VIEW_ALL_NOTIFICATIONS: returns last 100 notifications for the whole team
// — Otherwise: returns last 30 notifications for the logged-in user only
function listNotifications(req, res, next) {
  handle(req, res, next, async () => {
    const canViewAll = req.user.is_super_admin || req.user.permissions.has('VIEW_ALL_NOTIFICATIONS');

    if (canViewAll) {
      const r = await pool.query(
        `SELECT n.id, n.type, n.title, n.body, n.lead_id, n.is_read, n.created_at,
                n.user_id,
                u.name   AS user_name,
                l.name   AS lead_name,
                l.mobile AS lead_mobile
         FROM notifications n
         LEFT JOIN leads l ON l.id = n.lead_id
         LEFT JOIN users u ON u.id = n.user_id
         ORDER BY n.created_at DESC
         LIMIT 100`
      );
      return res.json({ items: r.rows, scope: 'all' });
    }

    const r = await pool.query(
      `SELECT n.id, n.type, n.title, n.body, n.lead_id, n.is_read, n.created_at,
              l.name   AS lead_name,
              l.mobile AS lead_mobile
       FROM notifications n
       LEFT JOIN leads l ON l.id = n.lead_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json({ items: r.rows, scope: 'own' });
  });
}

// GET /api/notifications/unread-count
function unreadCount(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ count: parseInt(r.rows[0].count, 10) });
  });
}

// PATCH /api/notifications/:id/read
function markRead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  });
}

// PATCH /api/notifications/read-all
function markAllRead(req, res, next) {
  handle(req, res, next, async () => {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ ok: true });
  });
}

// DELETE /api/notifications  — clear (delete) all notifications for the logged-in user
function clearAll(req, res, next) {
  handle(req, res, next, async () => {
    await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  });
}

module.exports = { listNotifications, unreadCount, markRead, markAllRead, clearAll };
