const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// GET /api/notifications  — last 30 notifications for the logged-in user
function listNotifications(req, res, next) {
  handle(req, res, next, async () => {
    const userId = req.user.id;
    const r = await pool.query(
      `SELECT n.id, n.type, n.title, n.body, n.lead_id, n.is_read, n.created_at,
              l.name  AS lead_name,
              l.mobile AS lead_mobile
       FROM notifications n
       LEFT JOIN leads l ON l.id = n.lead_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 30`,
      [userId]
    );
    res.json({ items: r.rows });
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
