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
    await pool.query(
      `UPDATE appointments
       SET    status_id  = (SELECT id FROM appointment_statuses WHERE slug = $1 AND is_system = TRUE LIMIT 1),
              updated_at = NOW()
       WHERE  id = $2`,
      [slug, appointmentId]
    );
  } catch (err) {
    // Never crash the request — just log
    console.error(`[advanceAppointmentStatus] appt #${appointmentId} → '${slug}' failed:`, err.message);
  }
}

module.exports = advanceAppointmentStatus;
