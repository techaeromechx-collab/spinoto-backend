'use strict';

// Hub payout due-date logic — anchored to Customer Invoice payment, not PI
// approval date. Replaces the old "approval_date + hub.payout_cycle_days"
// model (migration 029 / 083).
//
// Rule: a PI's payout has no due date until its linked CI is fully paid. The
// moment the CI reaches 'paid' (amount_paid >= grand_total), the due date
// becomes the next Tuesday on/after that payment's date — but only if that
// Tuesday is at least 2 days away. If the payment falls the day before
// Tuesday (Monday) or on Tuesday itself, that's too tight a turnaround, so
// it skips ahead to the following week's Tuesday instead. If a payment is
// later deleted and the CI drops back below 'paid', the due date is cleared
// again — it always reflects the CI's *current* paid state, not history.
//
// All date math below works in IST (UTC+5:30) calendar days, using only
// UTC-field Date methods throughout — never local-time methods (getDay(),
// setDate(), a bare toISOString() after local mutation) mixed together.
// That mix is a classic bug: on a server running in a positive-UTC-offset
// timezone (IST included), local midnight of day X is UTC time on day X-1,
// so toISOString() silently returns the wrong calendar day. Confirmed this
// was happening here (every computed date was one day early) and fixed it.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30, India has no DST

// Converts any timestamp/date input into a Date whose UTC fields
// (getUTCFullYear/getUTCMonth/getUTCDate/getUTCDay) represent IST wall-clock
// calendar values — independent of the server process's own local timezone.
function toIstFields(input) {
  return new Date(new Date(input).getTime() + IST_OFFSET_MS);
}

// Formats a Date's UTC fields as YYYY-MM-DD. Only call this on a Date coming
// from toIstFields() (or built with Date.UTC()) — never on a plain local Date.
function ymd(d) {
  const y   = d.getUTCFullYear();
  const m   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns YYYY-MM-DD for the payout due date given a payment date/timestamp:
// the next Tuesday (IST calendar) on/after it, unless that Tuesday is less
// than 2 days away (payment on Monday, or on Tuesday itself) — in which case
// it rolls forward to the Tuesday of the following week instead.
//
//   Mon 5 Jan → Tue 6 Jan is only 1 day away        → too close → Tue 13 Jan
//   Tue 6 Jan → Tue 6 Jan is 0 days away (same day)  → too close → Tue 13 Jan
//   Wed 7 Jan → Tue 13 Jan is 6 days away            → far enough → Tue 13 Jan
function nextTuesday(date) {
  const d = toIstFields(date);
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat, Tuesday=2 (IST day-of-week)
  let diff = (2 - day + 7) % 7; // days until the nearest Tuesday (0-6)
  if (diff < 2) diff += 7;      // too close (same day or next day) — push a week out
  d.setUTCDate(d.getUTCDate() + diff);
  return ymd(d);
}

// Adds `days` to a YYYY-MM-DD string as pure calendar-date arithmetic — the
// string has no time-of-day or timezone to begin with, so this never touches
// local time at all.
function addDays(dateStr, days) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
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
      const dueDate = anchor ? addDays(anchor, i * 7) : null;
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
