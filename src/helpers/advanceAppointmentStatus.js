'use strict';
const { pool } = require('../config/db');
const { fireWhatsAppEventDetached } = require('../services/whatsappAutomations.service');

/**
 * Advances an appointment's status_id to the system status matching `slug`.
 * Silent no-op if the slug doesn't exist or appointmentId is falsy.
 * Safe to call fire-and-forget inside any controller.
 *
 * ── Also the single place customer WhatsApp messages fire from ───────────────
 *
 * Every system status change in the application funnels through here —
 * estimates, invoices, warranty claims and appointments all call it. So this is
 * the one function that needs to know about messaging, rather than five
 * controllers each remembering to.
 *
 * Which template fires is NOT hardcoded. Any template whose
 * `trigger_status_slug` matches the slug being advanced to will send, so an
 * admin repointing "Service Completed" at a different status in
 * Settings → WhatsApp takes effect immediately with no code change.
 */
async function advanceAppointmentStatus(appointmentId, slug) {
  if (!appointmentId || !slug) return;
  try {
    // Resolve the status first — if the slug doesn't exist, skip the update
    // entirely instead of setting status_id = NULL (which would wipe the
    // appointment's current status).
    const statusRow = await pool.query(
      `SELECT id FROM appointment_statuses WHERE slug = $1 AND is_system = TRUE LIMIT 1`,
      [slug]
    );
    if (statusRow.rowCount === 0) {
      console.warn(`[advanceAppointmentStatus] no system status with slug '${slug}' — skipping`);
      return;
    }
    const newStatusId = statusRow.rows[0].id;

    // ── Fire on the TRANSITION, not on the write ────────────────────────────
    //
    // The UPDATE below is idempotent, so re-running it is harmless. A customer
    // message is not: without this check, anything that re-advances an
    // appointment to a status it is already in would send "your service is
    // complete" a second time.
    //
    // RETURNING tells us whether a row actually changed, in one statement — a
    // separate SELECT first would leave a window for two concurrent requests to
    // both read the old status and both decide to send.
    const upd = await pool.query(
      `UPDATE appointments
          SET status_id = $1, updated_at = NOW()
        WHERE id = $2
          AND (status_id IS DISTINCT FROM $1)
        RETURNING id`,
      [newStatusId, appointmentId]
    );

    if (upd.rowCount === 0) return; // already in this status — nothing changed

    await fireStatusMessages(appointmentId, slug);
  } catch (err) {
    // Never crash the request — just log
    console.error(`[advanceAppointmentStatus] appt #${appointmentId} → '${slug}' failed:`, err.message);
  }
}

/**
 * Queue whatever the Automations table says fires on this status.
 *
 * Since migration 151 the lookup is wa_automations
 * (event 'appointment.status_changed', match_value = slug) rather than the
 * deprecated trigger_status_slug column — the admin now manages these rows in
 * Settings → WhatsApp → Automations, and more than one template per status is
 * an ordinary configuration instead of impossible.
 *
 * fireWhatsAppEventDetached owns the connection, the transaction, the
 * per-template loop and the quiet/loud logging split. Failures are logged and
 * swallowed there: a messaging problem must never undo a status change that
 * has already been committed above.
 */
async function fireStatusMessages(appointmentId, slug) {
  await fireWhatsAppEventDetached(pool, {
    event: 'appointment.status_changed',
    matchValue: slug,
    entityId: appointmentId,
    // The transition identity. Two advances to the same status for the same
    // appointment collapse to one message even if the caller's IS DISTINCT
    // FROM guard is somehow bypassed — a flapping status cannot spam a
    // customer.
    dedupeKey: `status:${slug}`,
  });
}

module.exports = advanceAppointmentStatus;
module.exports.fireStatusMessages = fireStatusMessages;
