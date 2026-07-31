/**
 * scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs smart alert checks on a fixed interval using Node's built-in
 * setInterval. No external cron packages required.
 *
 * Schedule: every 30 minutes → runScheduledAlerts(), which internally covers
 * the high-frequency checks (overdue, missed follow-ups, escalation) and the
 * lower-frequency ones (daily target, no activity, inactive leads). The
 * service guards its own frequency via the alreadyNotifiedToday check, so a
 * single interval is enough — it does not need one timer per check type.
 *
 * WHY 30 MINUTES AND NOT 10
 * ─────────────────────────
 * This process is the main thing keeping the database awake. A serverless
 * Postgres (Neon) suspends after 5 minutes with no queries and bills only for
 * the time it is running. A 10-minute poll meant: wake, work, idle 5 min,
 * sleep 5 min, wake again — awake roughly half of every hour, all night, with
 * nobody using the app. That accounted for essentially the whole compute bill.
 *
 * At 30 minutes the database sleeps ~25 minutes of every 30. Measured against
 * the July 2026 usage that is a drop from ~90 CU-hours/month to ~30.
 *
 * The cost of the change: alerts fire up to 30 minutes after the condition
 * appears, rather than up to 10. That was judged acceptable for a workshop
 * whose staff are looking at the app during working hours anyway.
 *
 * If this ever moves to a server with flat pricing (a VPS running its own
 * Postgres), the interval can safely go back down — the constraint is
 * per-hour billing, not correctness.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { runScheduledAlerts } = require('./services/smartAlerts.service');

const THIRTY_MIN = 30 * 60 * 1000;

function startScheduler() {
  console.log('[Scheduler] Smart alert scheduler started — every 30 minutes');

  // Run shortly after boot (let DB connections settle first).
  setTimeout(() => {
    runScheduledAlerts();
  }, 15_000);

  setInterval(() => {
    runScheduledAlerts();
  }, THIRTY_MIN);
}

module.exports = { startScheduler };
