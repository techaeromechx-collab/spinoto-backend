'use strict';

/**
 * The ONE place a purchase invoice's paid state is derived.
 *
 * This is the money-out mirror of services/invoiceBalance.service.js, and it
 * exists for the same reason that one does: `amount_paid` and `payment_status`
 * are DERIVED from the payment rows, never set from what a caller believes it
 * just did. A handler that computes "paid = old + this one" is right until a
 * second row is inserted concurrently, or a row is deleted, or a payout is
 * reversed — and then it is quietly wrong in a table three other features read.
 *
 * ── WHY THIS IS A MODULE AND NOT A PRIVATE FUNCTION ─────────────────────────
 * The recalculation and the installment waterfall were written out longhand in
 * four handlers in purchase_invoices.controller.js. Three of them ran both
 * steps; bulkPayment ran only the first, so a bulk payment against a split
 * schedule left pi_payment_schedule showing installments as unpaid that had in
 * fact been paid. That is what a fourth copy of a money rule looks like, and
 * gateway payouts would have been the fifth.
 *
 * Every path that changes hub_payments now calls recalcHubInvoiceState, and the
 * derivation exists once.
 *
 * ── IT TAKES A CLIENT, NOT THE POOL ─────────────────────────────────────────
 * Always called inside the caller's transaction, so a failure after the ledger
 * write rolls the derived state back with it. Passing the pool would let a
 * deleted payment stay counted in amount_paid when the surrounding transaction
 * aborted.
 */

/**
 * @param client an open pg client INSIDE a transaction
 * @param purchaseInvoiceId
 * @returns { amount_paid, payment_status, grand_total }
 */
async function recalcHubInvoiceState(client, purchaseInvoiceId) {
  const r = await client.query(
    `SELECT pi.grand_total, COALESCE(SUM(hp.amount), 0) AS paid
       FROM purchase_invoices pi
       LEFT JOIN hub_payments hp ON hp.purchase_invoice_id = pi.id
      WHERE pi.id = $1
      GROUP BY pi.grand_total`,
    [purchaseInvoiceId]
  );
  if (!r.rows[0]) return null;

  const amtPaid = parseFloat(r.rows[0].paid);
  const total   = parseFloat(r.rows[0].grand_total);

  // The 0.011 tolerance is the existing one, kept exactly. Rupee amounts that
  // have been through a GST split can miss by a paisa, and an invoice stuck at
  // 'partially_paid' for one paisa blocks the payout it was meant to release.
  const status = amtPaid <= 0
    ? 'pending'
    : amtPaid >= total - 0.011 ? 'paid' : 'partially_paid';

  await client.query(
    `UPDATE purchase_invoices
        SET amount_paid = $1, payment_status = $2, updated_at = NOW()
      WHERE id = $3`,
    [amtPaid.toFixed(2), status, purchaseInvoiceId]
  );

  await _applyInstallmentWaterfall(client, purchaseInvoiceId, amtPaid);

  return { amount_paid: amtPaid, payment_status: status, grand_total: total };
}

/**
 * Spreads the total paid across the installments, oldest first.
 *
 * Recomputed from the total on every call rather than incremented, so it is
 * self-correcting: a deleted payment or a reversed payout walks the schedule
 * back down without needing to know which installment the money had been
 * credited to. Same reason amount_paid above is a SUM and not an addition.
 *
 * Math.max(0, …) on the remainder guards the case where a schedule's amounts do
 * not add up to grand_total — legal, since a schedule can be edited after the
 * fact — and stops a negative remainder marking every later installment 'paid'.
 */
async function _applyInstallmentWaterfall(client, purchaseInvoiceId, amountPaid) {
  const pi = await client.query(
    `SELECT payout_schedule FROM purchase_invoices WHERE id = $1`, [purchaseInvoiceId]);
  if (pi.rows[0]?.payout_schedule !== 'split') return;

  const schedule = await client.query(
    `SELECT id, amount_due FROM pi_payment_schedule
      WHERE purchase_invoice_id = $1 ORDER BY installment_no`,
    [purchaseInvoiceId]);

  let remaining = Number(amountPaid) || 0;
  for (const inst of schedule.rows) {
    const due     = parseFloat(inst.amount_due);
    const paidAmt = Math.min(remaining, due);
    const status  = paidAmt <= 0 ? 'pending' : paidAmt >= due ? 'paid' : 'partially_paid';
    await client.query(
      `UPDATE pi_payment_schedule
          SET paid_amount = $1, status = $2, updated_at = NOW()
        WHERE id = $3`,
      [paidAmt.toFixed(2), status, inst.id]);
    remaining = Math.max(0, remaining - paidAmt);
  }
}

module.exports = { recalcHubInvoiceState };
