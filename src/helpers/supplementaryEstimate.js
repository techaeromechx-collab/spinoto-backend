'use strict';

/**
 * May this estimate be created for this appointment?
 *
 * ══ WHY THIS IS A HELPER AND NOT SIX LINES IN THE CONTROLLER ═══════════════
 *
 * estimates.controller.js is 125KB of money code with a dependency tree that
 * cannot be stood up in a test harness. The rules below are the whole of what
 * migration 193 changed about who may create what, so they live here where
 * they can be driven directly and proved.
 *
 * ══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * NO PARENT — this is an ordinary estimate, and the existing rule is
 *   unchanged: one per appointment. A second one is a double-submitted form,
 *   not a decision, and is still refused.
 *
 * A PARENT — this is a supplementary, which IS a decision. It must:
 *   · belong to the same appointment as the estimate it extends, or it bills
 *     one customer for another's work;
 *   · extend an ORIGINAL, never another supplementary. One level only, so
 *     "what does this visit cost" is always the original plus its direct
 *     children and never a tree walk that two screens could answer
 *     differently;
 *   · have an appointment at all — a standalone estimate has no visit to be
 *     supplementary to.
 *
 * Returns null when the create may proceed, or {status, body} to send back
 * verbatim. It never throws and never touches the response, because the
 * caller is long-standing code whose error handling must not change.
 */

async function checkEstimateParentage(db, { appointmentId, parentEstimateId }) {
  if (parentEstimateId && !appointmentId) {
    return {
      status: 400,
      body: { error: 'A supplementary estimate needs the appointment it belongs to.',
              code: 'SUPPLEMENTARY_NEEDS_APPOINTMENT' },
    };
  }
  if (!appointmentId) return null;                       // standalone — unchanged

  if (!parentEstimateId) {
    /* The original rule, narrowed by exactly one clause: it now counts
       ORIGINALS. Before migration 193 every estimate was one, so this is the
       same query it has always been. */
    const dupe = (await db.query(
      `SELECT id, status FROM estimates
        WHERE appointment_id = $1 AND parent_estimate_id IS NULL LIMIT 1`,
      [appointmentId])).rows[0];
    if (dupe) {
      return {
        status: 409,
        body: {
          error: `An estimate already exists for appointment #${appointmentId} (estimate #${dupe.id}, status: ${dupe.status}). Raise a supplementary estimate if more work was found.`,
          existing_estimate_id: dupe.id,
          code: 'ESTIMATE_EXISTS',
        },
      };
    }
    return null;
  }

  const parent = (await db.query(
    `SELECT id, appointment_id, parent_estimate_id, status
       FROM estimates WHERE id = $1`, [parentEstimateId])).rows[0];

  if (!parent) {
    return { status: 404,
             body: { error: 'The estimate being extended was not found.',
                     code: 'PARENT_NOT_FOUND' } };
  }
  if (Number(parent.appointment_id) !== Number(appointmentId)) {
    return { status: 400,
             body: { error: 'A supplementary estimate must belong to the same appointment as the estimate it extends.',
                     code: 'PARENT_WRONG_APPOINTMENT' } };
  }
  if (parent.parent_estimate_id) {
    return { status: 400,
             body: { error: 'That is already a supplementary estimate. Extend the original instead.',
                     existing_estimate_id: parent.parent_estimate_id,
                     code: 'PARENT_IS_SUPPLEMENTARY' } };
  }
  return null;
}

module.exports = { checkEstimateParentage };
