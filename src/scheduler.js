/**
 * scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs smart alert checks on fixed intervals using Node's built-in setInterval.
 * No external cron packages required.
 *
 * Schedule:
 *   Every 10 minutes  → high-frequency checks (overdue, missed follow-ups, escalation)
 *   Every 30 minutes  → medium checks (daily target, no activity)
 *   Every 60 minutes  → low-frequency checks (inactive leads)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { runScheduledAlerts } = require('./services/smartAlerts.service');

const TEN_MIN  = 10 * 60 * 1000;   // 10 minutes
const ONE_HOUR = 60 * 60 * 1000;   // 60 minutes

function startScheduler() {
  console.log('[Scheduler] Smart alert scheduler started');

  // Run immediately on boot after a 15-second delay (let DB connections settle)
  setTimeout(() => {
    runScheduledAlerts();
  }, 15_000);

  // Then run every 10 minutes
  setInterval(() => {
    runScheduledAlerts();
  }, TEN_MIN);

  // Hourly inactive-lead check is folded into runScheduledAlerts; the service
  // itself guards frequency via the alreadyNotifiedToday check.
  // Extra hourly safety sweep:
  setInterval(() => {
    runScheduledAlerts();
  }, ONE_HOUR);
}

module.exports = { startScheduler };
