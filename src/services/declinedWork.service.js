'use strict';

const { pool } = require('../config/db');

/**
 * Work this customer was quoted for this car, refused, and has not had done
 * since.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A declined line already survives. `applyItemApprovals` writes
 * `customer_approved = FALSE` and leaves the row exactly where it is — that was
 * deliberate, and the job card says so on screen: "a declined line stays on the
 * estimate as a record of the refusal".
 *
 * What never happened is anyone being told about it again. The car comes back
 * four months later, the same worn pads are still worn, and the advisor writing
 * the new estimate has no idea they were quoted at ₹2,000 and refused. The
 * record was kept and never read.
 *
 * ── WHY IT IS A SERVICE ─────────────────────────────────────────────────────
 * Three screens ask this question — the job card, the estimate form, and the
 * vehicle history — and "declined and not since done" has to mean the same
 * thing on all three. Two implementations of that rule is two answers to
 * "should I offer this again", and nobody can tell which is right.
 *
 * Same reason invoiceBalance.service.js exists.
 *
 * ── WHAT COUNTS AS THE SAME PIECE OF WORK ───────────────────────────────────
 * `service_id`, else `part_id`, else the lowercased description. There is no
 * identity on an estimate line beyond those, and inventing one would be a
 * guess. A free-typed line spelled differently on two visits therefore reads as
 * two different jobs — which is the safe failure: it offers the work twice
 * rather than silently swallowing one.
 *
 * ── WHAT SUPPRESSES A DECLINE ───────────────────────────────────────────────
 * The same key appearing on that visit or a LATER one as anything other than
 * another refusal — approved, or quoted and not yet answered.
 *
 * Approved, not completed: a line the customer has just said yes to is already
 * on the table, and offering it again in the same breath is how somebody gets
 * billed twice for one job.
 *
 * Unanswered counts too, and that is the case that matters most in practice:
 * the advisor reads this list, puts the work back on today's estimate, and the
 * new line is NULL because nobody has asked the customer yet. If only TRUE
 * suppressed, the list would go on saying "declined, still outstanding" about
 * something sitting on the screen beside it.
 *
 * A cancelled estimate authorises nothing and is excluded from both sides.
 *
 * Note what is NOT suppressed: a decline that was later deleted off its
 * estimate is gone, because the row is gone. The update path deletes items
 * dropped from the payload (estimates.controller.js). Deleting a line is a
 * deliberate act by a person, so this does not try to resurrect it — but it
 * does mean "declined" here means "declined and the line still exists".
 */

/* One expression for "the same piece of work", written once. Used on both
   sides of the NOT EXISTS below, so the rule that finds a decline and the rule
   that cancels it cannot drift apart. */
/* A free-typed line falls back to its wording, normalised: lowercased, trimmed,
   and runs of whitespace collapsed to one space. "Cabin  filter" and "Cabin
   filter" are the same job to anybody reading them, and offering the work twice
   because somebody double-tapped the spacebar would be a bug nobody could
   explain. That is as far as it goes — no stemming, no fuzzy matching. A line
   genuinely spelled differently reads as a different job, which is the safe
   failure: it offers work twice rather than silently swallowing it. */
const ITEM_KEY = `
  CASE
    WHEN ei.service_id IS NOT NULL THEN 's' || ei.service_id
    WHEN ei.part_id    IS NOT NULL THEN 'p' || ei.part_id
    ELSE 'd' || LOWER(BTRIM(REGEXP_REPLACE(COALESCE(ei.description, ''), '\\s+', ' ', 'g')))
  END`;

/* Visits are ordered by the date the customer came in, not by row id: estimates
   are backdated in this system (SPEC_backdated_customer_invoice), so id order
   and calendar order are not the same thing. The id is the tie-break for two
   visits on one day, and the COALESCE keeps a null date at the beginning of
   time rather than dropping the row out of every comparison. */
const VISIT_ORDER = `(COALESCE(a.scheduled_date, DATE '1900-01-01'), a.id)`;

/**
 * @param {object} db            pool, or an in-transaction client
 * @param {object} opts
 * @param {string} opts.mobile         the customer — this system keys customers on it
 * @param {string} opts.vehicleNumber  registration, in any spelling
 * @param {number} [opts.excludeAppointmentId]  a visit to leave out, normally
 *        the one being looked at: its own declines are already on the screen
 *        asking, and repeating them as HISTORY reads as a second refusal
 * @param {number} [opts.hubId]  when set, only visits AT THAT HUB are looked at
 *        — both for finding declines and for cancelling them. A hub login must
 *        not be shown what a customer was quoted, or refused, at a competitor.
 *        Callers pass it for a hub session and leave it null for staff.
 * @param {number} [opts.limit=20]
 */
async function readDeclinedWork(db = pool, {
  mobile, vehicleNumber, excludeAppointmentId = null, hubId = null, limit = 20,
} = {}) {
  if (!mobile || !vehicleNumber) return [];

  const r = await db.query(`
    WITH visit AS (
      SELECT ei.id            AS estimate_item_id,
             ei.estimate_id,
             ei.item_type, ei.service_id, ei.part_id, ei.description,
             ei.quantity, ei.customer_rate, ei.gst_percent, ei.total_inc_gst,
             ei.customer_approved, ei.work_status,
             a.id             AS appointment_id,
             a.scheduled_date,
             a.hub_id,
             ${ITEM_KEY}      AS item_key,
             ${VISIT_ORDER}   AS visit_order,
             /* Every time this job has been refused, counted HERE rather than
                in the outer query. Out there the window would run after the
                NOT EXISTS below and count only the refusals still outstanding —
                so work refused, later agreed, then refused again would report
                "1× declined" when it has been turned down twice. An advisor
                about to raise it for the third time should be told that. */
             COUNT(*) FILTER (WHERE ei.customer_approved IS FALSE)
               OVER (PARTITION BY ${ITEM_KEY})::int AS times_declined
        FROM estimate_items ei
        JOIN estimates    e ON e.id = ei.estimate_id
        JOIN appointments a ON a.id = e.appointment_id
       WHERE a.mobile = $1
         AND UPPER(REPLACE(a.vehicle_number, ' ', '')) = UPPER(REPLACE($2, ' ', ''))
         AND e.status <> 'cancelled'
         /* Inside the CTE, so it narrows what counts as a decline AND what
            counts as having said yes since. Filtering only the outer query
            would let a hub see a decline whose later approval it is not allowed
            to see — and it would offer the work again after the customer had
            already agreed to it elsewhere. */
         AND ($5::int IS NULL OR a.hub_id = $5::int)
    )
    SELECT DISTINCT ON (d.item_key)
           d.item_key, d.estimate_item_id, d.estimate_id, d.appointment_id,
           d.item_type, d.service_id, d.part_id, d.description,
           d.quantity, d.customer_rate, d.gst_percent,
           d.total_inc_gst AS quoted_at,
           TO_CHAR(d.scheduled_date, 'YYYY-MM-DD') AS declined_on,
           h.hub_name,
           d.times_declined,
           /* Whether the service master still sells it, so the estimate form
              can tell a live service from a line typed by hand two years ago. */
           s.name       AS service_name,
           s.is_active  AS service_is_active,
           p.name       AS part_name
      FROM visit d
      LEFT JOIN hubs     h ON h.id = d.hub_id
      LEFT JOIN services s ON s.id = d.service_id
      LEFT JOIN parts    p ON p.id = d.part_id
     WHERE d.customer_approved IS FALSE
       AND ($3::int IS NULL OR d.appointment_id <> $3::int)
       /* Raised again since — on that visit or a later one, and not as another
          refusal. IS DISTINCT FROM FALSE covers both TRUE (they agreed) and
          NULL (it is on an estimate and nobody has asked them yet). */
       AND NOT EXISTS (
             SELECT 1 FROM visit again
              WHERE again.item_key = d.item_key
                AND again.customer_approved IS DISTINCT FROM FALSE
                AND again.visit_order >= d.visit_order
           )
     ORDER BY d.item_key, d.visit_order DESC, d.estimate_item_id DESC
     LIMIT $4
  `, [mobile, vehicleNumber, excludeAppointmentId, limit, hubId]);

  /* Sorted for the screen AFTER the DISTINCT ON, which had to order by the key
     to pick the most recent decline per job. Most recently refused first: that
     is the one the customer remembers saying no to. */
  return r.rows.sort((x, y) => String(y.declined_on || '').localeCompare(String(x.declined_on || '')));
}

module.exports = { readDeclinedWork, ITEM_KEY, VISIT_ORDER };
