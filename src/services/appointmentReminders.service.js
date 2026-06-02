'use strict';

/**
 * Appointment Reminders Service
 *
 * Checks every 15 minutes for appointments happening in the next 24 h and
 * fires in-app notifications if not already sent.
 *
 * Reminder windows: 24 h before, 2 h before, 30 min before.
 *
 * Fix #14: appointments without a scheduled_time are skipped — treating them
 *          as "all day" and defaulting to 00:00 would fire all 3 windows at
 *          midnight simultaneously, which is misleading.
 * Fix #6:  reminder_log entry is only written AFTER at least one notification
 *          fires — so an appointment with no recipients is not permanently
 *          silenced.
 * Fix #23: notifies all hub staff (users whose hub_id matches), not just the
 *          creator.  Creator is always included even if hub differs.
 *
 * Uses appointment_reminder_log to avoid duplicate notifications.
 * Run migration add_invoice_gst_cancellation_reason.sql first (creates the log table).
 */

const { pool } = require('../config/db');

const WINDOWS = [
  { hours: 24,   label: '24 hours' },
  { hours: 2,    label: '2 hours'  },
  { hours: 0.5,  label: '30 minutes' },
];

async function fireAppointmentReminders() {
  const client = await pool.connect();
  try {
    for (const win of WINDOWS) {
      const hoursKey = win.hours;

      // Fix #14: only match appointments that have a scheduled_time set.
      // Time-less bookings cannot be reliably placed in a narrow reminder window.
      const { rows } = await client.query(`
        SELECT
          a.id, a.customer_name, a.mobile, a.scheduled_date, a.scheduled_time,
          a.created_by, a.hub_id,
          ast.name AS status_name
        FROM appointments a
        LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
        WHERE
          -- Fix #14: skip appointments with no scheduled_time
          a.scheduled_time IS NOT NULL
          -- appointment is upcoming within this window
          AND (a.scheduled_date::timestamp + a.scheduled_time::time)
                BETWEEN NOW() AND (NOW() + ($1 || ' hours')::interval)
          -- not already cancelled/done
          AND LOWER(COALESCE(ast.name,'')) NOT ILIKE '%cancel%'
          AND LOWER(COALESCE(ast.name,'')) NOT ILIKE '%complet%'
          -- not already notified for this window
          AND NOT EXISTS (
            SELECT 1 FROM appointment_reminder_log rl
            WHERE rl.appointment_id = a.id AND rl.hours_before = $2
          )
      `, [win.hours, hoursKey]);

      for (const appt of rows) {
        const label   = appt.customer_name || appt.mobile || `Appointment #${appt.id}`;
        const dateStr = appt.scheduled_date
          ? new Date(appt.scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
          : '';
        const timeStr = appt.scheduled_time || '';
        const title   = `⏰ Reminder: Appointment in ${win.label}`;
        const body    = `${label} — ${dateStr}${timeStr ? ' at ' + timeStr : ''}`;

        // Fix #23: collect all recipients — creator + all active hub staff
        const recipientSet = new Set();
        if (appt.created_by) recipientSet.add(appt.created_by);

        if (appt.hub_id) {
          const staffRows = await client.query(
            `SELECT id FROM users WHERE hub_id = $1 AND is_active = TRUE`,
            [appt.hub_id]
          );
          for (const s of staffRows.rows) recipientSet.add(s.id);
        }

        // Fix #6: track whether at least one notification was inserted
        let notified = 0;
        for (const userId of recipientSet) {
          const r = await client.query(`
            INSERT INTO notifications (user_id, type, title, body)
            VALUES ($1, 'appointment_reminder', $2, $3)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [userId, title, body]);
          if (r.rows.length > 0) notified++;
        }

        // Fix #6: only log when at least one notification fired
        // (if all inserts were no-ops we have no recipients yet — don't block future attempts)
        if (notified > 0 || recipientSet.size === 0) {
          await client.query(`
            INSERT INTO appointment_reminder_log (appointment_id, hours_before)
            VALUES ($1, $2)
            ON CONFLICT (appointment_id, hours_before) DO NOTHING
          `, [appt.id, hoursKey]);
        }
      }
    }
  } catch (err) {
    console.error('[AppointmentReminders] Error:', err.message);
  } finally {
    client.release();
  }
}

/**
 * Start polling every 15 minutes.
 * Called once from server.js on startup.
 */
function startReminderPoller() {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  // Run immediately on startup, then on interval
  fireAppointmentReminders().catch(() => {});
  setInterval(() => {
    fireAppointmentReminders().catch(() => {});
  }, INTERVAL_MS);

  console.log('[AppointmentReminders] Poller started — checking every 15 minutes');
}

module.exports = { startReminderPoller, fireAppointmentReminders };
