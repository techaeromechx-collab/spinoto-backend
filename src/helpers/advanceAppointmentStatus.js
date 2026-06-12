'use strict';
const { pool } = require('../config/db');

/**
 * Advances an appointment's status_id to the system status matching `slug`.
 * Silent no-op if the slug doesn't exist or appointmentId is falsy.
 * Safe to call fire-and-forget inside any controller.
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
    await pool.query(
      `UPDATE appointments SET status_id = $1, updated_at = NOW() WHERE id = $2`,
      [statusRow.rows[0].id, appointmentId]
    );
  } catch (err) {
    // Never crash the request — just log
    console.error(`[advanceAppointmentStatus] appt #${appointmentId} → '${slug}' failed:`, err.message);
  }
}

module.exports = advanceAppointmentStatus;
