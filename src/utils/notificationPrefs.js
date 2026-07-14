/**
 * notificationPrefs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared helper to check a user's notification_settings toggle (the same
 * settings shown in ProfilePage → Settings → Notifications tab) before
 * creating an in-app (bell icon) notification.
 *
 * Mirrors the same "explicit false = skip" logic already used by sendPush.js
 * for push notifications, so both channels respect the same toggle.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db — pool or client (works inside or outside a transaction)
 * @param {number} userId
 * @param {string} type — notification type key (must match notification_settings keys)
 * @returns {Promise<boolean>} true if the notification should be created
 */
async function isNotificationEnabled(db, userId, type) {
  try {
    const { rows } = await db.query(
      `SELECT notification_settings FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows.length) return true; // unknown user — don't block, let caller decide
    const settings = rows[0].notification_settings || {};
    // Only an explicit `false` disables it — missing key / anything else = enabled
    if (Object.prototype.hasOwnProperty.call(settings, type) && settings[type] === false) {
      return false;
    }
    return true;
  } catch (err) {
    // Never block notification creation due to a lookup error
    console.error('[notificationPrefs] error:', err.message);
    return true;
  }
}

module.exports = { isNotificationEnabled };
