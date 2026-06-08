/**
 * push.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles PWA push subscription management and super-admin push panel.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { pool }    = require('../config/db');
const { sendPush } = require('../utils/sendPush');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// ── POST /api/push/subscribe ──────────────────────────────────────────────────
// Save (or update) a device push subscription for the logged-in user.
// Body: { endpoint, keys: { p256dh, auth } }
function subscribe(req, res, next) {
  handle(req, res, next, async () => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    // Upsert — same endpoint may re-subscribe with fresh keys
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             p256dh  = EXCLUDED.p256dh,
             auth    = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );

    res.json({ ok: true });
  });
}

// ── DELETE /api/push/subscribe ────────────────────────────────────────────────
// Remove a device subscription when user denies permission or logs out.
// Body: { endpoint }
function unsubscribe(req, res, next) {
  handle(req, res, next, async () => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
      [endpoint, req.user.id]
    );

    res.json({ ok: true });
  });
}

// ── GET /api/push/admin/stats ─────────────────────────────────────────────────
// Super admin: get device subscription counts per user.
function adminStats(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user.is_super_admin) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        COUNT(ps.id)::int AS device_count,
        MAX(ps.created_at) AS last_subscribed
      FROM users u
      LEFT JOIN push_subscriptions ps ON ps.user_id = u.id
      WHERE u.is_active = TRUE
      GROUP BY u.id, u.name, u.email
      ORDER BY device_count DESC, u.name ASC
    `);

    const total = await pool.query(`SELECT COUNT(*) AS c FROM push_subscriptions`);

    res.json({
      total_devices: parseInt(total.rows[0].c, 10),
      users: rows,
    });
  });
}

// ── POST /api/push/admin/test ─────────────────────────────────────────────────
// Super admin: send a custom push to a specific user (or themselves).
// Body: { user_id?, title, message }
function adminTest(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user.is_super_admin) return res.status(403).json({ error: 'Forbidden' });

    const { user_id, title, message, url } = req.body || {};

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const targetId = user_id || req.user.id;

    const { rows } = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [targetId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No subscribed devices for this user' });
    }

    const webpush = require('web-push');
    const payload = JSON.stringify({
      title: title.trim(),
      body:  (message || '').trim(),
      url:   url || '/',
      type:  'custom',
    });

    const results = await Promise.allSettled(
      rows.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 }
        )
      )
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    res.json({ ok: true, sent, failed });
  });
}

// ── GET /api/push/vapid-public-key ────────────────────────────────────────────
// Returns the VAPID public key for frontend subscription.
function vapidPublicKey(req, res) {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key });
}

module.exports = { subscribe, unsubscribe, adminStats, adminTest, vapidPublicKey };
