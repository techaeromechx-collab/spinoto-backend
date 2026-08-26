'use strict';
/**
 * retargetSweep.service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Moves a lead off Lost when the car it was lost with becomes due again.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * "Competitor Service" does not mean the customer is gone. It means somebody
 * else did the job on a known day, and three months later that car needs doing
 * again. Until now that lead sat in Lost — locked, closed, and on a list nobody
 * works — and the moment to ring them passed unnoticed.
 *
 * leads.retarget_due_date is stamped when the lead is marked lost (see
 * resolveLostReason in leads.controller.js). This reads it.
 *
 * ── The three things it deliberately does ───────────────────────────────────
 *
 * 1. IT BYPASSES is_locked. Lost is a locked status — the UI shows a padlock
 *    and the bulk endpoint refuses it. That rule exists to stop a PERSON
 *    walking a finished lead backwards by accident. This is not a person, it
 *    is the rule the workshop asked for, and the activity row it writes says
 *    so rather than blaming whoever next opens the lead.
 *
 * 2. IT LEAVES THE RETARGET TASK OPEN. The lead_events row written when the
 *    lead was marked lost is the thing an agent has to do. Closing it here
 *    would move the lead and then hide the reason it moved.
 *
 * 3. IT SKIPS A CUSTOMER WHO HAS ALREADY COME BACK. is_closed (migration 156)
 *    means a new WhatsApp message from a Lost customer starts a FRESH lead. So
 *    a customer who messaged in month two already has a live lead somebody is
 *    working. Retargeting the old one puts a second agent on the phone to the
 *    same person about the same car.
 *
 * ── Why it is safe to run repeatedly ────────────────────────────────────────
 *
 * Moving a lead clears its retarget_due_date, so the second run of the day
 * finds nothing, moves nothing and notifies nobody. There is no "have I run
 * today" flag because the work itself is the flag — which is the only kind
 * that survives a restart.
 */

const { pool }  = require('../config/db');
const { sendPush } = require('../utils/sendPush');
const { isNotificationEnabled } = require('../utils/notificationPrefs');

/* Not before eight in the morning.
 *
 * The scheduler ticks every 30 minutes, all night. Without this the first tick
 * after midnight does the day's work and fires everybody's phone at 00:07 —
 * technically on the right day, and the fastest way to get an app muted.
 *
 * The hour is the SERVER's, which is the same clock every other date in this
 * codebase is compared against (see the ::date comparisons in listLeads).
 */
const EARLIEST_HOUR = 8;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] run regardless of the hour — for scripts and tests
 */
async function runRetargetSweep(opts = {}) {
  if (!opts.force && new Date().getHours() < EARLIEST_HOUR) return { skipped: 'too early' };

  const client = await pool.connect();
  try {
    // ── Where do they go? ────────────────────────────────────────────────
    //
    // A flag, not the string 'Retargeting'. leads.status stores the NAME, and
    // code holding a name breaks silently the moment somebody renames the
    // status on the Master Data screen — the sweep would simply stop matching
    // and raise nothing. Migration 173 guarantees at most one holder.
    const dest = await client.query(
      `SELECT name FROM lead_statuses WHERE is_retarget_target AND is_active LIMIT 1`);
    if (!dest.rows[0]) {
      console.warn('[retarget] no active retarget destination status — '
                 + 'leads are accumulating a due date and nothing can move them. '
                 + 'Tick one in Settings → Master Data → Lead Status.');
      return { moved: 0, skipped: 'no destination' };
    }
    const target = dest.rows[0].name;

    /* ── Who is due ──────────────────────────────────────────────────────
       Read and moved inside one transaction, FOR UPDATE SKIP LOCKED on the
       leads: two app instances behind a load balancer both tick, and without
       this they would both move the same lead and send two notifications
       about it. SKIP LOCKED rather than a plain lock so the second instance
       does nothing rather than waiting for the first. */
    await client.query('BEGIN');

    const due = await client.query(
      `SELECT l.id, l.name, l.mobile, l.status, l.assigned_to, l.created_by,
              l.retarget_due_date, l.competitor_service_date,
              c.name AS competitor_name,
              /* Has this customer already come back on a newer lead that is
                 still open? Matched on the last ten digits, the same
                 normalisation utils/phone.js and migrations 155/161 use,
                 because appointments.mobile and leads.mobile are free text and
                 '+91 97241 90308' and '9724190308' are one person. */
              EXISTS (
                SELECT 1 FROM leads n
                 WHERE n.id <> l.id
                   AND n.created_at > l.created_at
                   AND RIGHT(regexp_replace(COALESCE(n.mobile, ''), '\\D', '', 'g'), 10)
                     = RIGHT(regexp_replace(COALESCE(l.mobile, ''), '\\D', '', 'g'), 10)
                   AND NOT EXISTS (
                     SELECT 1 FROM lead_statuses s2
                      WHERE s2.name = n.status AND s2.is_closed)
              ) AS came_back
         FROM leads l
         LEFT JOIN competitors c ON c.id = l.lost_competitor_id
        WHERE l.retarget_due_date IS NOT NULL
          AND l.retarget_due_date <= CURRENT_DATE
          /* Still sitting where it was left. If somebody has already moved this
             lead by hand there is nothing to do, and dragging it back to
             Retargeting on top of their work is the worst thing this could do. */
          AND EXISTS (SELECT 1 FROM lead_statuses s
                       WHERE s.name = l.status AND s.needs_lost_reason)
        ORDER BY l.retarget_due_date, l.id
        FOR UPDATE OF l SKIP LOCKED`);

    if (!due.rowCount) { await client.query('COMMIT'); return { moved: 0 }; }

    const moving = due.rows.filter(r => !r.came_back);
    const back   = due.rows.filter(r =>  r.came_back);

    /* ── The ones who already came back ──────────────────────────────────
       The due date is CLEARED rather than left, deliberately. Left in place,
       every one of these is re-examined by this query every single day for the
       rest of the install's life, and the answer is always the same.

       Recorded on the timeline so it is a decision somebody can see, not a
       lead that quietly never retargeted. */
    if (back.length) {
      const ids = back.map(r => r.id);
      await client.query(
        `UPDATE leads SET retarget_due_date = NULL, updated_at = NOW() WHERE id = ANY($1)`, [ids]);
      await client.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
         SELECT id, 'status_changed', NULL, NULL,
                'Retarget cancelled automatically — this customer already came back on a newer lead.',
                NULL
           FROM unnest($1::int[]) AS t(id)`, [ids]);
      console.log(`[retarget] ${back.length} lead(s) skipped — customer already back on a newer lead`);
    }

    if (!moving.length) { await client.query('COMMIT'); return { moved: 0, skipped_returned: back.length }; }

    const ids = moving.map(r => r.id);

    // ── The move ─────────────────────────────────────────────────────────
    //
    // No is_locked check, and that is the point of this whole file. The due
    // date is cleared in the same statement so a second tick finds nothing.
    await client.query(
      `UPDATE leads SET status = $2, retarget_due_date = NULL, updated_at = NOW()
        WHERE id = ANY($1)`, [ids, target]);

    /* created_by NULL — nobody did this.
       Attributing it to a user id would put a real person's name against a
       move they did not make, in the one place the lead's history is supposed
       to be trustworthy. The note carries the explanation instead. */
    for (const r of moving) {
      const why = r.competitor_name
        ? `Moved automatically — ${r.competitor_name} serviced this vehicle`
          + `${r.competitor_service_date ? ` on ${new Date(r.competitor_service_date).toISOString().slice(0,10)}` : ''}`
          + `, so it is due again.`
        : 'Moved automatically — this lead reached its retarget date.';
      await client.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
         VALUES ($1, 'status_changed', $2, $3, $4, NULL)`,
        [r.id, r.status, target, why]);
    }

    await client.query('COMMIT');
    console.log(`[retarget] moved ${moving.length} lead(s) to "${target}"`);

    // ── Telling somebody ─────────────────────────────────────────────────
    //
    // After the commit, on the pool: a push provider being slow must not hold
    // a transaction open over every lead that moved, and a lead that has moved
    // has moved whether or not the phone buzzed.
    await notifyOwners(moving, target);

    return { moved: moving.length, skipped_returned: back.length, target };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    console.error('[retarget] sweep failed:', err.message);
    return { moved: 0, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * One notification per person, not one per lead.
 *
 * A sweep after a busy quarter moves forty leads. Forty pushes is not forty
 * times as useful as one — it is how an app gets muted, and a muted app cannot
 * tell you anything at all. So the leads are grouped by who owns them and each
 * owner gets a single line with a number in it.
 *
 * Falls back to the lead's creator when nobody is assigned: an unassigned lead
 * with nobody told is a lead that silently does not get called, which is the
 * exact failure this whole feature exists to prevent.
 */
async function notifyOwners(rows, target) {
  const byUser = new Map();
  for (const r of rows) {
    const uid = r.assigned_to || r.created_by;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }

  for (const [uid, leads] of byUser) {
    const n     = leads.length;
    const first = leads[0].name || leads[0].mobile || `Lead #${leads[0].id}`;
    const title = 'Due for retargeting';
    const body  = n === 1
      ? `${first} is due for service again — moved to ${target}.`
      : `${n} leads are due for service again — moved to ${target}.`;

    try {
      if (await isNotificationEnabled(pool, uid, 'lead_retarget_due')) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, lead_id)
           VALUES ($1, 'lead_retarget_due', $2, $3, $4)`,
          // The lead_id only when there is exactly one — a summary that deep
          // links to an arbitrary one of forty is worse than one that opens
          // the list they all live on.
          [uid, title, body, n === 1 ? leads[0].id : null]);
      }
      await sendPush(uid, 'lead_retarget_due', title, body, '/leads');
    } catch (err) {
      // A notification failing must never be the reason a lead stays lost.
      console.error(`[retarget] notify user ${uid} failed:`, err.message);
    }
  }
}

module.exports = { runRetargetSweep, EARLIEST_HOUR };
