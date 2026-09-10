'use strict';

/**
 * hubNotify.js
 * ─────────────────────────────────────────────────────────────────────────
 * Notifies hub-portal login users (users.hub_id) about changes that affect
 * their hub:
 *   - pricing_changed          — a pricing rule on a service/category the
 *                                 hub is mapped to (hub_service_mappings /
 *                                 hub_category_mappings) was added, updated,
 *                                 toggled, or removed.
 *   - reference_data_changed   — a CC category (2W-only reference data used
 *                                 in pricing specificity matching) was
 *                                 updated or deactivated/removed.
 *
 * Mirrors the insert-then-push pattern already used elsewhere
 * (leads.controller.js, appointmentReminders.service.js): check
 * isNotificationEnabled → INSERT into notifications → fire-and-forget
 * sendPush. Never throws — errors are logged and swallowed so a
 * notification failure can never break the calling pricing/reference-data
 * request.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { sendPush } = require('./sendPush');
const { isNotificationEnabled } = require('./notificationPrefs');

/** Active hub-portal user ids mapped to a service via hub_service_mappings. */
async function hubUserIdsForService(db, serviceId) {
  const r = await db.query(
    `SELECT DISTINCT u.id
       FROM hub_service_mappings hsm
       JOIN users u ON u.hub_id = hsm.hub_id
      WHERE hsm.service_id = $1 AND u.is_active = TRUE`,
    [serviceId]
  );
  return r.rows.map((row) => row.id);
}

/** Active hub-portal user ids mapped to a category via hub_category_mappings. */
async function hubUserIdsForCategory(db, categoryId) {
  const r = await db.query(
    `SELECT DISTINCT u.id
       FROM hub_category_mappings hcm
       JOIN users u ON u.hub_id = hcm.hub_id
      WHERE hcm.category_id = $1 AND u.is_active = TRUE`,
    [categoryId]
  );
  return r.rows.map((row) => row.id);
}

/**
 * Active hub-portal user ids belonging to a 2W-capable hub — used for CC
 * category changes, since CC category ranges only ever affect 2W pricing.
 */
async function hubUserIdsFor2W(db) {
  const r = await db.query(
    `SELECT DISTINCT u.id
       FROM hubs h
       JOIN users u ON u.hub_id = h.id
      WHERE h.vehicle_class IN ('2w', 'both')
        AND h.deleted_at IS NULL
        AND u.is_active = TRUE`
  );
  return r.rows.map((row) => row.id);
}

/** Insert + push a notification to a list of user ids, respecting each user's toggle. */
async function notifyUsers(db, userIds, type, title, body, url) {
  for (const uid of userIds) {
    if (await isNotificationEnabled(db, uid, type)) {
      await db.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, $2, $3, $4)`,
        [uid, type, title, body]
      );
    }
    sendPush(uid, type, title, body, url);
  }
}

/**
 * Notify hubs mapped to a service or category that its pricing changed.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {object} opts
 * @param {number|null} opts.serviceId
 * @param {number|null} opts.categoryId
 * @param {string} opts.targetName — service or category display name
 * @param {'added'|'updated'|'removed'|'activated'|'deactivated'} opts.action
 * @param {number|null} [opts.price]
 */
async function notifyHubsPricingChange(db, { serviceId, categoryId, targetName, action, price }) {
  try {
    const userIds = serviceId
      ? await hubUserIdsForService(db, serviceId)
      : await hubUserIdsForCategory(db, categoryId);
    if (!userIds.length) return;

    const ACTION_LABEL = {
      added: 'Pricing Added', updated: 'Pricing Updated', removed: 'Pricing Removed',
      activated: 'Pricing Activated', deactivated: 'Pricing Deactivated',
    };
    const title = `${ACTION_LABEL[action] || 'Pricing Changed'} — ${targetName}`;
    const body = price != null
      ? `${targetName}: new price ₹${Number(price).toLocaleString('en-IN')}`
      : `Pricing rule ${action} for ${targetName}`;

    await notifyUsers(db, userIds, 'pricing_changed', title, body, '/hub');
  } catch (err) {
    console.error('[hubNotify] pricing change error:', err.message);
  }
}

/**
 * Notify all 2W-capable hubs that a piece of reference data (currently:
 * CC category ranges) changed, since it can silently reprice their 2W
 * services via the pricing lookup's specificity matching.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 */
async function notifyHubsReferenceDataChange(db, { title, body }) {
  try {
    const userIds = await hubUserIdsFor2W(db);
    if (!userIds.length) return;
    await notifyUsers(db, userIds, 'reference_data_changed', title, body, '/hub');
  } catch (err) {
    console.error('[hubNotify] reference data change error:', err.message);
  }
}

/** Active hub-portal user ids for ONE hub. */
async function hubUserIdsForHub(db, hubId) {
  const r = await db.query(
    `SELECT id FROM users WHERE hub_id = $1 AND is_active = TRUE`,
    [hubId]
  );
  return r.rows.map((row) => row.id);
}

/**
 * Tell a hub that an appointment on its bench was booked, moved or cancelled.
 *
 * ── Why the actor check is the first thing here ────────────────────────────
 *
 * `actorHubId === hubId` means the hub did this itself, and a portal that
 * chimes at you for the thing you just clicked teaches people to ignore the
 * chime. The rule the workshop actually asked for is "tell me when SPINOTO
 * schedules something", and that is exactly this comparison — not a permission
 * check, because a Spinoto admin who happens to have no hub_id and a hub user
 * are distinguished by which hub they belong to, not by what they may do.
 *
 * ── And why the socket nudge carries no content ────────────────────────────
 *
 * getIO().emit reaches EVERY connected browser. The customer's name and
 * registration go into the notifications row — which is per-user and read back
 * through the user's own scoped endpoint — while the wire carries only "your
 * notifications changed". A payload here would put one hub's customer in every
 * other hub's socket frame.
 *
 * Never throws: a booking that saved must not fail because a chime did not.
 */
async function notifyHubAppointment(db, { hubId, actorHubId, kind, appointmentId, customer, vehicle, when }) {
  try {
    if (!hubId) return;
    if (actorHubId && Number(actorHubId) === Number(hubId)) return;

    const userIds = await hubUserIdsForHub(db, hubId);
    if (!userIds.length) return;

    const who = [customer, vehicle].filter(Boolean).join(' · ') || `Appointment #${appointmentId}`;
    const copy = {
      created:     { type: 'appointment_scheduled', title: 'New appointment scheduled' },
      rescheduled: { type: 'appointment_rescheduled', title: 'Appointment rescheduled' },
      cancelled:   { type: 'appointment_cancelled', title: 'Appointment cancelled' },
    }[kind];
    if (!copy) return;

    const body = when ? `${who} — ${when}` : who;
    await notifyUsers(db, userIds, copy.type, copy.title, body, '/hub/appointments');

    // After the rows exist, so a client that reacts instantly finds them.
    try {
      require('../socket').getIO().emit('invalidate', { topic: 'notifications' });
    } catch { /* no socket server in this process — the 120s poll still catches it */ }
  } catch (err) {
    console.error('[hubNotify] appointment notify error:', err.message);
  }
}

module.exports = {
  notifyHubsPricingChange,
  notifyHubsReferenceDataChange,
  notifyHubAppointment,
};
