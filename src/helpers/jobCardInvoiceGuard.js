'use strict';

/**
 * Should this visit be invoiced yet?
 *
 * ══ THE RULE ═══════════════════════════════════════════════════════════════
 *
 * Today a Purchase Invoice can be raised the moment an estimate reads
 * `work_completed` — which is BEFORE the quality check has started. The hub
 * gets billed for work nobody has checked, and if the check then fails the
 * money has already moved.
 *
 * So: where a job card exists, neither invoice may be raised until that card
 * reaches `ready` — QC passed and the compliance gates green.
 *
 * ══ AND THE THREE THINGS THAT KEEP IT FROM BREAKING A WORKING TUESDAY ══════
 *
 * 1. NO JOB CARD, NO CHANGE. An appointment without a card behaves exactly as
 *    it does today. So does a standalone estimate with no appointment at all.
 *    On the day this deploys, every job already in flight keeps working, and
 *    the rule only starts applying to visits opened after it.
 *
 * 2. A CANCELLED OR CLOSED CARD DOES NOT BLOCK. A cancelled visit may still
 *    need an invoice — for the diagnosis, for parts already fitted — and
 *    refusing there would be a trap with no way out but an override.
 *
 * 3. A SUPER ADMIN CAN OVERRIDE, with a reason, written to the job card's
 *    timeline. A hub must not be left unpaid because one checklist row is
 *    stuck, and the person who decided that has to be findable afterwards.
 *
 * This helper only ANSWERS. It never sends a response and never throws — the
 * two controllers that call it are long-standing money code, and a helper that
 * can throw from the middle of them is a helper that can change their error
 * handling by accident.
 */

const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');

/* Statuses that do not block. `ready` and beyond is the rule; `cancelled` is
   the trapdoor in point 2 above. */
const INVOICEABLE = new Set(['ready', 'delivered', 'closed', 'cancelled']);

const LABEL = {
  open: 'Open', inspection: 'Inspection', awaiting_estimate: 'Awaiting estimate',
  awaiting_approval: 'Awaiting approval', in_progress: 'Work in progress',
  on_hold: 'On hold', work_done: 'Work done', qc: 'Quality check',
};

/**
 * @param {number|null} appointmentId
 * @param {object} opts
 * @param {object} opts.user            req.user
 * @param {string} [opts.overrideReason]
 * @param {string} opts.document        'purchase invoice' | 'customer invoice'
 * @returns {Promise<null | {status:number, body:object}>}
 *          null = go ahead. Otherwise the refusal to send back verbatim.
 */
async function blockedFromInvoicing(appointmentId, { user, overrideReason, document } = {}) {
  if (!appointmentId) return null;                 // standalone estimate

  let card;
  try {
    const r = await pool.query(
      `SELECT id, job_card_no, status FROM job_cards WHERE appointment_id = $1`,
      [appointmentId]);
    card = r.rows[0];
  } catch (err) {
    /* If this lookup fails — the table is missing because migrations have not
       run yet, the database hiccups — invoicing must NOT stop. A compliance
       check that takes the billing system down with it when it breaks is worse
       than the problem it was added to solve. Logged loudly, then allowed. */
    console.error('[jobCardInvoiceGuard] lookup failed, allowing invoice:', err.message);
    return null;
  }

  if (!card) return null;                          // no job card — today's behaviour
  if (INVOICEABLE.has(card.status)) return null;

  const reason = (overrideReason || '').trim();
  if (user?.is_super_admin && reason) {
    /* Recorded in both places on purpose: the job card timeline is where
       somebody reviewing this visit will look, and activity_logs is where
       somebody auditing overrides across the business will. */
    try {
      await pool.query(
        `INSERT INTO job_card_activities (job_card_id, type, old_value, new_value, note, created_by)
         VALUES ($1, 'invoice:override', $2, $3, $4, $5)`,
        [card.id, card.status, document, reason, user?.id ?? null]);
    } catch (err) {
      console.error('[jobCardInvoiceGuard] could not log override:', err.message);
    }
    logActivity({
      userId: user?.id, userName: user?.name,
      action: 'UPDATE', entity: 'job_card', entityId: card.id,
      description: `${document} raised on ${card.job_card_no} before Ready (${card.status}): ${reason}`,
    });
    return null;
  }

  const where = LABEL[card.status] || card.status;
  return {
    status: 409,
    body: {
      error: `Job card ${card.job_card_no} is at ${where}. A ${document} cannot be raised until it reaches Ready — the quality check has to pass first.`,
      code: user?.is_super_admin ? 'JOB_CARD_NOT_READY_OVERRIDABLE' : 'JOB_CARD_NOT_READY',
      job_card_id: card.id,
      job_card_no: card.job_card_no,
      job_card_status: card.status,
    },
  };
}

module.exports = { blockedFromInvoicing, INVOICEABLE };
