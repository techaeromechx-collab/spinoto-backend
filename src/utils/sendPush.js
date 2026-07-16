/**
 * sendPush.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends a Web Push notification to all subscribed devices of a user,
 * but ONLY if the user has that notification type enabled in their
 * notification_settings (the same toggles shown in ProfilePage → Settings tab).
 *
 * This utility is called from smartAlerts.service.js notify() helper.
 * It never throws — all errors are swallowed so existing notification logic
 * is never interrupted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const webpush = require('web-push');
const { pool }  = require('../config/db');
const { CircuitBreaker } = require('./circuitBreaker');

// Configure VAPID once on first require
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@spinoto.in',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
} else {
  console.warn('[sendPush] VAPID keys not set — push notifications disabled');
}

// Most callers of sendPush() are fire-and-forget (not awaited), so a hanging
// push provider wouldn't block a user-facing request — but it would still
// leak an unresolved promise/socket per call, and a burst of them (e.g. a
// summary push to every user) could still pile up unbounded concurrent
// connections to the push provider. The one place this DOES block a request
// is push.controller.js's admin test-push endpoint, which now also goes
// through this same breaker via sendToSubscription().
const breaker = new CircuitBreaker('web-push', {
  failureThreshold: 6,
  failureWindowMs: 30_000,
  resetTimeoutMs: 15_000,
  requestTimeoutMs: 6_000,
  maxConcurrent: 10,
});

/**
 * sendToSubscription(sub, payload, options)
 * Breaker-protected single Web Push send. Resolves { ok:true } or
 * { ok:false, status } — never throws — so callers can fan out with
 * Promise.all instead of Promise.allSettled and still get a clean result
 * per device.
 */
async function sendToSubscription(sub, payload, options = {}) {
  try {
    await breaker.fire(() =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        options
      )
    );
    return { id: sub.id, ok: true };
  } catch (err) {
    return { id: sub.id, ok: false, status: err.statusCode };
  }
}

/**
 * sendPush(userId, type, title, body, url)
 *
 * @param {number} userId  — target user
 * @param {string} type    — notification type key (must match notification_settings keys)
 * @param {string} title   — push notification title
 * @param {string} body    — push notification body
 * @param {string} [url]   — URL to open on click (defaults to '/')
 */
async function sendPush(userId, type, title, body, url = '/') {
  // Skip silently if VAPID not configured
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  try {
    // 1. Check user's notification_settings — respect their toggle preference
    const userRow = await pool.query(
      `SELECT notification_settings FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRow.rows.length) return;

    const settings = userRow.rows[0].notification_settings || {};
    // If the key exists and is explicitly false, skip
    if (Object.prototype.hasOwnProperty.call(settings, type) && settings[type] === false) return;

    // 2. Fetch all push subscriptions for this user
    const subs = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );
    if (!subs.rows.length) return;

    const payload = JSON.stringify({ title, body, url, type });

    // 3. Send to each subscribed device in parallel. sendToSubscription()
    //    is breaker-protected and never throws, so a slow/down push
    //    provider fails each of these fast instead of hanging — and the
    //    concurrency cap inside the breaker keeps a big fan-out (e.g. a
    //    summary push to a user with many devices) from opening unbounded
    //    connections to the provider all at once.
    const results = await Promise.all(
      subs.rows.map(sub => sendToSubscription(sub, payload, { TTL: 60 * 60 * 24 })) // 24h TTL
    );

    // 4. Remove dead/expired subscriptions (410 Gone = unsubscribed device)
    const deadIds = results
      .filter(r => !r.ok && r.status === 410)
      .map(r => r.id);

    if (deadIds.length) {
      await pool.query(
        `DELETE FROM push_subscriptions WHERE id = ANY($1::int[])`,
        [deadIds]
      );
    }
  } catch (err) {
    // Never interrupt the caller — just log
    console.error('[sendPush] error:', err.message);
  }
}

module.exports = { sendPush, sendToSubscription, _breaker: breaker };
