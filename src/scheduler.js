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

const { runScheduledAlerts }  = require('./services/smartAlerts.service');
const { runRetargetSweep }    = require('./services/retargetSweep.service');
const { pool }                = require('./config/db');

const THIRTY_MIN = 30 * 60 * 1000;

/* ── Chat retention ─────────────────────────────────────────────────────────
 *
 * Purges chat messages that were soft-deleted more than 90 days ago.
 *
 * ── Why this ships WITH the table and not later ──
 *
 * wa_events is at 316MB with no retention job, and `notifications` has none
 * either. Neither of those was an oversight anybody made twice: the table
 * shipped, the sweep was "next week", and nobody was ever coming back for it.
 * chat_messages will outgrow both, so the sweep goes in with migration 197.
 *
 * ── Why only DELETED rows ──
 *
 * Deleting live messages is a business decision about what a workshop keeps,
 * and it is not mine to make. A soft-deleted row is different: somebody already
 * said they wanted it gone. The body and the record pointer were nulled at that
 * moment, so all this removes is a tombstone whose only job was to stop the
 * thread renumbering under whoever was reading it — a job that is long finished
 * 90 days later.
 *
 * When a retention rule for live messages does arrive, extend THIS statement
 * rather than adding a second sweep beside it.
 *
 * One statement, no transaction, no client checked out — it runs on the same
 * 30-minute tick, and on all but one tick in ~1,400 it deletes nothing.
 */
const DELETED_KEEP_DAYS = 90;

async function purgeDeletedChatMessages() {
  const r = await pool.query(
    `DELETE FROM chat_messages
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' days')::interval`,
    [DELETED_KEEP_DAYS]
  );
  if (r.rowCount) {
    console.log(`[Scheduler] chat: purged ${r.rowCount} message(s) deleted over ${DELETED_KEEP_DAYS} days ago`);
  }
}

/* ── Why the retarget sweep rides the same timer ─────────────────────────────
 *
 * It is a once-a-day job, and the obvious implementation is a once-a-day timer.
 * A once-a-day timer in setInterval is also the one that quietly stops
 * happening: the process restarts at 09:05 for a deploy, the timer starts
 * counting from then, and the sweep now runs at 09:05 tomorrow — or never, if
 * the next deploy lands before it fires.
 *
 * Riding the 30-minute tick has neither problem. The sweep clears each lead's
 * due date as it moves it, so a second run finds nothing, moves nothing and
 * notifies nobody — the work is its own "already done today" flag, and it is
 * the only kind of flag that survives a restart. It declines to run before
 * 08:00 itself, so the tick at 00:07 costs one indexed lookup and nothing else.
 */
function startScheduler() {
  console.log('[Scheduler] Smart alerts + retarget sweep + chat purge — every 30 minutes');

  const tick = () => {
    runScheduledAlerts();
    // Not awaited and never allowed to throw: a failing sweep must not be able
    // to stop the alerts, and vice versa. Both log their own failures.
    runRetargetSweep().catch(err => console.error('[Scheduler] retarget sweep:', err.message));
    // Same rule. In particular this one must survive chat_messages not existing
    // yet — migration 197 sits behind ten unapplied ones (187-196), so on a
    // server that has not caught up this throws 42P01 every tick and must not
    // take the alerts down with it.
    purgeDeletedChatMessages().catch(err => {
      if (err.code === '42P01') return;          // table not there yet; fine
      console.error('[Scheduler] chat purge:', err.message);
    });
  };

  // Run shortly after boot (let DB connections settle first).
  setTimeout(tick, 15_000);
  setInterval(tick, THIRTY_MIN);
}

module.exports = { startScheduler };
