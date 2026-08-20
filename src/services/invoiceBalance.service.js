'use strict';

/**
 * The one function that decides how much a customer invoice has been paid and
 * what its status therefore is.
 *
 * WHERE THIS CAME FROM
 * ────────────────────
 * This was `_recalcStatus`, a private function inside
 * controllers/customer_invoices.controller.js. It was moved here — not copied —
 * when gateway payments were added, because a second implementation of "what is
 * this invoice's status" is how an invoice ends up PAID on one screen and
 * PARTIALLY PAID on another. The controller now requires it from here and its
 * behaviour is unchanged.
 *
 * WHAT CHANGED IN THE MOVE
 * ────────────────────────
 * One thing: refunds are subtracted.
 *
 *     amount_paid = SUM(payments) − SUM(refunds WHERE status = 'processed')
 *
 * With no refunds in the system that is arithmetically identical to what the
 * function did before, so every existing call site keeps its exact behaviour.
 * It matters because the alternative — editing the original payment row down
 * when money is sent back — destroys the record that the customer ever paid the
 * full amount, which is unauditable and wrong for GST. Payment rows are
 * append-only; the balance is derived.
 *
 * Only 'processed' refunds count. A refund that has been REQUESTED but not yet
 * settled is money the customer does not have back yet, and a refund that
 * FAILED never left at all. Marking the invoice unpaid at request time would
 * show an outstanding balance for money nobody is owed, and leave nothing to
 * correct it with if the refund then fails.
 *
 * SUBQUERIES, NOT JOINS
 * ─────────────────────
 * Two one-to-many tables joined onto the same parent multiply each other's
 * rows: three payments and two refunds produce six rows, and SUM() over that is
 * wrong in both columns. Independent scalar subqueries are the correct shape
 * and also drop the GROUP BY the original needed.
 *
 * Always call inside a transaction, passing the client — the caller's INSERT
 * and this recalculation must commit or roll back together.
 */

const { syncPayoutDueDate } = require('../utils/payoutSchedule');

/**
 * Recomputes amount_paid and status for one customer invoice and writes them.
 *
 * @param {object} client  an in-transaction pg client (NOT the pool)
 * @param {number} ciId
 * @returns {Promise<{status, appointment_id, estimate_id, amount_paid, grand_total, balance}>}
 */
async function recalcInvoiceState(client, ciId) {
  const r = await client.query(
    `SELECT ci.grand_total,
            ci.status AS current_status,
            ci.appointment_id,
            ci.estimate_id,
            -- ALLOCATIONS, not payments (migration 133).
            --
            -- Identical arithmetic for every payment that predates that
            -- migration, because the backfill wrote one full-amount allocation
            -- per payment. What it adds is the ability for money to exist
            -- before the invoice it settles: an advance is a payment with no
            -- allocation yet, and it correctly contributes nothing here until
            -- somebody applies it.
            (SELECT COALESCE(SUM(l.amount), 0)
               FROM invoice_payment_lines l
              WHERE l.customer_invoice_id = ci.id) AS paid_gross,
            (SELECT COALESCE(SUM(rf.amount), 0)
               FROM payment_refunds rf
              WHERE rf.customer_invoice_id = ci.id
                AND rf.status = 'processed')       AS refunded
       FROM customer_invoices ci
      WHERE ci.id = $1`,
    [ciId]
  );
  if (!r.rows[0]) {
    const err = new Error('Customer invoice not found');
    err.status = 404;
    throw err;
  }

  const { grand_total, current_status, appointment_id, estimate_id, paid_gross, refunded } = r.rows[0];
  const gross    = parseFloat(paid_gross);
  const refunds  = parseFloat(refunded);
  const amtPaid  = gross - refunds;
  const total    = parseFloat(grand_total);

  // The 0.011 tolerance is carried over verbatim from the original. It exists
  // because grand_total is rounded to paise while payments are entered by
  // humans, and an invoice one paisa short of its total is paid in every sense
  // that matters — including to the hub, whose payout this gates.
  let status;
  if (amtPaid >= total - 0.011 && total > 0) {
    status = 'paid';
  } else if (amtPaid > 0) {
    status = 'partially_paid';
  } else {
    // Preserve 'approved' if the company already approved — don't revert to
    // 'generated'. Unchanged from the original.
    status = current_status === 'approved' ? 'approved' : 'generated';
  }

  await client.query(
    `UPDATE customer_invoices SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3`,
    [amtPaid.toFixed(2), status, ciId]
  );

  // Hub payout due date is anchored to this CI's payment, not PI approval —
  // resync on every payment add/delete. Handles both directions: reaching
  // 'paid' sets the due date (next Tuesday after last payment), dropping back
  // below 'paid' clears it again. See utils/payoutSchedule.js.
  //
  // This is exactly why a refund has to flow through this function rather than
  // being recorded off to the side: a refund that drops an invoice out of
  // 'paid' must also pull back the hub payout it triggered.
  await syncPayoutDueDate(client, { customerInvoiceId: ciId });

  // ── Tell the customer their invoice is settled ─────────────────────────────
  //
  // HERE because this function is the single writer of invoice status — every
  // path money can arrive by (counter payment, gateway capture, credit
  // application, refund reversal) funnels through it, so one hook covers them
  // all instead of five call sites each remembering to.
  //
  // On the TRANSITION only: recalc runs on every payment edit, and an invoice
  // already 'paid' being recalculated must not re-message the customer. The
  // dedupe key is the second line of defence — even if a refund drops the
  // invoice out of 'paid' and a new payment brings it back, `paid:{id}` has
  // already been used and the unique index collapses the repeat.
  //
  // On the CALLER'S CLIENT, so the message commits or rolls back with the
  // money. The dispatcher takes its own SAVEPOINT and never throws; a
  // messaging problem cannot fail a payment. Lazy require, matching
  // advances.service.js, so a future import cycle cannot break module load.
  if (status === 'paid' && current_status !== 'paid') {
    const { fireWhatsAppEvent } = require('./whatsappAutomations.service');
    await fireWhatsAppEvent(client, {
      event: 'invoice.paid',
      entityId: ciId,
      dedupeKey: `paid:${ciId}`,
    });
  }

  return {
    status,
    appointment_id,
    estimate_id,
    amount_paid: amtPaid,
    grand_total: total,
    balance: Number((total - amtPaid).toFixed(2)),
  };
}

/**
 * What is still owed, read-only, outside a transaction.
 *
 * Used before creating a gateway order. It reads the same way recalc computes,
 * rather than trusting customer_invoices.amount_paid, because the stored column
 * is a cache — and an order created against a stale cache is an overcharge the
 * customer notices before we do.
 */
async function readInvoiceBalance(db, ciId) {
  // customer_name and mobile fall back to the appointment: customer_invoices
  // stores its own copies but they can be NULL on rows created through paths
  // that never set them, and CI_SELECT in the controller has always COALESCEd
  // them the same way. Reading ci.mobile alone would hand the pay page a
  // nameless invoice with no number to notify.
  //
  // There is no invoice_number column — the printed number is derived from the
  // id through invoice_config's prefix and padding (templates/documentAdapter
  // formatNumber). Callers that need to display it format it there, so the two
  // can never disagree.
  const r = await db.query(
    `SELECT ci.id, ci.public_token, ci.status, ci.hub_id,
            ci.grand_total, ci.appointment_id, ci.estimate_id,
            COALESCE(ci.customer_name, a.customer_name) AS customer_name,
            COALESCE(ci.mobile,        a.mobile)        AS mobile,
            COALESCE(ci.vehicle_number, a.vehicle_number) AS vehicle_number,
            -- ALLOCATIONS, not payments (migration 133).
            --
            -- Identical arithmetic for every payment that predates that
            -- migration, because the backfill wrote one full-amount allocation
            -- per payment. What it adds is the ability for money to exist
            -- before the invoice it settles: an advance is a payment with no
            -- allocation yet, and it correctly contributes nothing here until
            -- somebody applies it.
            (SELECT COALESCE(SUM(l.amount), 0)
               FROM invoice_payment_lines l
              WHERE l.customer_invoice_id = ci.id) AS paid_gross,
            (SELECT COALESCE(SUM(rf.amount), 0)
               FROM payment_refunds rf
              WHERE rf.customer_invoice_id = ci.id
                AND rf.status = 'processed')       AS refunded
       FROM customer_invoices ci
       LEFT JOIN appointments a ON a.id = ci.appointment_id
      WHERE ci.id = $1`,
    [ciId]
  );
  const row = r.rows[0];
  if (!row) return null;

  const paid = parseFloat(row.paid_gross) - parseFloat(row.refunded);
  const total = parseFloat(row.grand_total);
  return {
    ...row,
    amount_paid: Number(paid.toFixed(2)),
    grand_total: total,
    balance: Number((total - paid).toFixed(2)),
  };
}

module.exports = { recalcInvoiceState, readInvoiceBalance };
