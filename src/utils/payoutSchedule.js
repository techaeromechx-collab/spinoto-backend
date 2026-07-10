'use strict';

// Hub payout due-date logic — anchored to Customer Invoice payment, not PI
// approval date. Replaces the old "approval_date + hub.payout_cycle_days"
// model (migration 029 / 083).
//
// Rule: a PI's payout has no due date until its linked CI is fully paid. The
// moment the CI reaches 'paid' (amount_paid >= grand_total), the due date
// becomes the next Tuesday on/after that payment's date. If a payment is
// later deleted and the CI drops back below 'paid', the due date is cleared
// again — it always reflects the CI's *current* paid state, not history.
//
// Call syncPayoutDueDate() any time either side of the PI↔CI pair changes:
//   - purchase_invoices.controller.js  → right after a PI is approved
//     (handles the CI-already-paid-before-approval edge case)
//   - customer_invoices.controller.js  → after every CI payment add/delete
//     (via _recalcStatus)

// Returns YYYY-MM-DD for the next Tuesday on/after `date`. If `date` already
// falls on a Tuesday, that same day is returned (0-day roll).
function nextTuesday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun .. 6=Sat, Tuesday=2
  d.setDate(d.getDate() + ((2 - day + 7) % 7));
  return d.toISOString().split('T')[0];
}

// Resolves the PI↔CI pair from whichever id is known, then sets/clears
// payout due date(s) based on the CI's current paid status.
//
//   syncPayoutDueDate(client, { purchaseInvoiceId: 42 })
//   syncPayoutDueDate(client, { customerInvoiceId: 17 })
//
// For payout_schedule='split', all 3 pi_payment_schedule installments land on
// consecutive Tuesdays (next Tuesday, +7d, +14d) after the CI is paid — since
// there's no cycle length left to spread them across. The PI-level
// payout_due_date is mirrored to the *last* installment's date, matching the
// pre-existing convention (listPayouts' urgency bucketing/sort only reads
// purchase_invoices.payout_due_date, so split PIs need it set too).
async function syncPayoutDueDate(client, { purchaseInvoiceId = null, customerInvoiceId = null }) {
  const piRes = await client.query(
    `SELECT pi.id, pi.status, pi.payout_schedule
     FROM purchase_invoices pi
     WHERE pi.id = $1
        OR pi.id = (SELECT purchase_invoice_id FROM customer_invoices WHERE id = $2)
        OR pi.estimate_id = (SELECT estimate_id FROM customer_invoices WHERE id = $2)
     LIMIT 1`,
    [purchaseInvoiceId, customerInvoiceId]
  );
  const pi = piRes.rows[0];
  // No linked PI yet, or PI hasn't been approved — nothing to schedule.
  if (!pi || pi.status !== 'approved') return;

  const ciRes = await client.query(
    `SELECT ci.status,
            (SELECT MAX(paid_at) FROM customer_invoice_payments WHERE customer_invoice_id = ci.id) AS last_paid_at
     FROM customer_invoices ci
     WHERE ci.purchase_invoice_id = $1
        OR ci.estimate_id = (SELECT estimate_id FROM purchase_invoices WHERE id = $1)
     LIMIT 1`,
    [pi.id]
  );
  const ci = ciRes.rows[0];
  const isPaid = !!ci && ci.status === 'paid';
  const anchor = isPaid ? nextTuesday(ci.last_paid_at || new Date()) : null;

  if (pi.payout_schedule === 'split') {
    const schedRes = await client.query(
      `SELECT id FROM pi_payment_schedule WHERE purchase_invoice_id = $1 ORDER BY installment_no`,
      [pi.id]
    );
    let lastDueDate = null;
    for (let i = 0; i < schedRes.rows.length; i++) {
      let dueDate = null;
      if (anchor) {
        const d = new Date(anchor + 'T00:00:00');
        d.setDate(d.getDate() + i * 7);
        dueDate = d.toISOString().split('T')[0];
      }
      lastDueDate = dueDate;
      await client.query(
        `UPDATE pi_payment_schedule SET due_date=$1, updated_at=NOW() WHERE id=$2`,
        [dueDate, schedRes.rows[i].id]
      );
    }
    await client.query(`UPDATE purchase_invoices SET payout_due_date=$1 WHERE id=$2`, [lastDueDate, pi.id]);
  } else {
    await client.query(`UPDATE purchase_invoices SET payout_due_date=$1 WHERE id=$2`, [anchor, pi.id]);
  }
}

module.exports = { nextTuesday, syncPayoutDueDate };
