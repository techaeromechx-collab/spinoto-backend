'use strict';

/**
 * Recording which line items a customer accepted, and what that makes the
 * estimate.
 *
 * WHY THIS IS A SERVICE AND NOT TWO CONTROLLERS
 * ────────────────────────────────────────────
 * Two paths reach this decision:
 *
 *   staff     POST /api/estimates/:id/customer-approval
 *             — an advisor ticking boxes while the customer is on the phone
 *   customer  POST /api/public/documents/estimate/:token/decision
 *             — the customer deciding for themselves from a WhatsApp link
 *
 * They must produce IDENTICAL database state for identical input. Before this
 * file they did not come close: the public endpoint wrote a word straight into
 * estimates.status and never touched estimate_items at all, so a customer
 * "approving" left every item NULL, nothing entered the work queue, and the
 * next staff recount would flip the status back.
 *
 * THE STATUS IS DERIVED, NEVER WRITTEN
 * ────────────────────────────────────
 * An estimate's status is a FUNCTION of its items. Writing a status directly is
 * how it comes to disagree with the lines underneath it, and once they disagree
 * there is no way to tell which one is right. So callers hand over decisions;
 * this function decides what that makes the estimate.
 *
 * Lifted from estimates.controller.js customerApproval() — moved, not copied.
 * The rules below are that function's, unchanged.
 */

/**
 * The statuses estimates.status is allowed to hold (migration 052, re-declared
 * in 028). Kept here as a named list because this file is the only place that
 * writes the column, and because a value outside it fails as a Postgres CHECK
 * violation — a 500 with no useful message. The public endpoint shipped exactly
 * that bug: it wrote 'approved', which is not a status this system has.
 */
const ESTIMATE_STATUSES = Object.freeze([
  'draft', 'pending_company_review', 'sent_to_customer',
  'partially_approved', 'fully_approved', 'revision_requested',
  'work_in_progress', 'work_completed',
]);

/**
 * Decides an estimate's status from its item counts.
 *
 * Pure, so it can be tested without a database and so both callers demonstrably
 * share one rule.
 *
 * @param currentStatus  where the estimate is now — work states are terminal
 * @param counts         { total, approved_count, rejected_count }
 */
function deriveStatus(currentStatus, { total, approved_count, rejected_count }) {
  // Work already under way is not re-opened by a recount. An estimate whose
  // items are being fitted has moved past approval, and dropping it back to
  // 'partially_approved' would take it out of the workshop's queue mid-job.
  if (['work_in_progress', 'work_completed'].includes(currentStatus)) return currentStatus;

  if (approved_count === total && total > 0) return 'fully_approved';
  if (approved_count > 0)                    return 'partially_approved';
  // Everything refused. 'revision_requested' rather than a rejected state,
  // because this system has no 'rejected' status and because it is the one
  // that re-opens the estimate for editing — which is what should happen next
  // when a customer says no to all of it.
  if (rejected_count === total && total > 0) return 'revision_requested';

  // Some items still undecided. Deliberately NOT a decided state: the estimate
  // is still waiting on the customer, and saying otherwise would put a
  // half-answered quote into the workshop's queue.
  return 'sent_to_customer';
}

/**
 * Writes item decisions, resets work status, derives and stores the estimate's
 * status. Call INSIDE a transaction — the items and the status they imply must
 * commit together or not at all.
 *
 * @param {object} client     in-transaction pg client, NOT the pool
 * @param {number} estimateId
 * @param {Array<{item_id:number, approved:boolean}>} approvals
 * @returns {Promise<{status, total, approved_count, rejected_count, pending_count, allRejected}>}
 */
async function applyItemApprovals(client, estimateId, approvals) {
  const cur = await client.query(`SELECT status FROM estimates WHERE id = $1`, [estimateId]);
  if (!cur.rows[0]) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  for (const { item_id, approved } of approvals) {
    // AND estimate_id = $3 is load-bearing, not defensive tidiness. On the
    // public endpoint the item ids arrive in a request body from an
    // unauthenticated caller; without this scope a forwarded link becomes a way
    // to approve line items on somebody else's estimate.
    await client.query(
      `UPDATE estimate_items
          SET customer_approved = $1, updated_at = NOW()
        WHERE id = $2 AND estimate_id = $3`,
      [approved, item_id, estimateId]
    );
  }

  // Every approved item goes back to 'pending' work.
  //
  // ALL approved items, not just the ones in this call: an estimate can be
  // re-approved after a revision, and an item that was already fitted under a
  // previous approval has to re-enter the queue rather than silently counting
  // as done. Carried over from the staff handler unchanged.
  await client.query(
    `UPDATE estimate_items SET work_status = 'pending'
      WHERE estimate_id = $1 AND customer_approved = TRUE`,
    [estimateId]
  );

  const stats = await client.query(
    `SELECT COUNT(*)::int                                          AS total,
            COUNT(*) FILTER (WHERE customer_approved = TRUE)::int  AS approved_count,
            COUNT(*) FILTER (WHERE customer_approved = FALSE)::int AS rejected_count,
            COUNT(*) FILTER (WHERE customer_approved IS NULL)::int AS pending_count
       FROM estimate_items
      WHERE estimate_id = $1`,
    [estimateId]
  );
  const counts = stats.rows[0];
  const status = deriveStatus(cur.rows[0].status, counts);

  // Belt and braces against the failure this file's header describes. A status
  // outside the CHECK constraint surfaces as a bare 500 from Postgres with
  // nothing to point at; this says which value and where it came from.
  if (!ESTIMATE_STATUSES.includes(status)) {
    throw new Error(`deriveStatus produced '${status}', which estimates.status cannot hold`);
  }

  await client.query(
    `UPDATE estimates SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, estimateId]
  );

  return {
    ...counts,
    status,
    // The caller cancels the appointment on this. Expressed here so "the
    // customer refused everything" has one definition rather than each caller
    // re-deriving it from counts.
    allRejected: counts.total > 0 && counts.rejected_count === counts.total,
  };
}

module.exports = { applyItemApprovals, deriveStatus, ESTIMATE_STATUSES };
