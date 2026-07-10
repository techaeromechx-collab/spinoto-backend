'use strict';
// One-off backfill for migration 083 (payout due date now driven by CI
// payment instead of PI-approval-date + cycle-days).
//
// Recomputes payout_due_date (and pi_payment_schedule.due_date for split
// invoices) for every currently-approved purchase invoice, using the same
// syncPayoutDueDate() rule the app now applies live: cleared to NULL if the
// linked CI isn't fully paid yet, or set to the next Tuesday after the CI's
// last payment if it's already fully paid.
//
// Run once, after applying migration 083:
//   node backend/scripts/backfill_payout_due_dates.js
//
// Safe to re-run — syncPayoutDueDate() always recomputes from current state,
// it doesn't accumulate or depend on prior runs.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const { syncPayoutDueDate } = require('../src/utils/payoutSchedule');

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id FROM purchase_invoices WHERE status = 'approved' ORDER BY id`
    );
    console.log(`[backfill] ${rows.length} approved purchase invoice(s) to recompute.`);

    let cleared = 0, scheduled = 0;
    for (const { id } of rows) {
      await syncPayoutDueDate(client, { purchaseInvoiceId: id });
      const { rows: check } = await client.query(
        `SELECT payout_due_date FROM purchase_invoices WHERE id = $1`, [id]
      );
      if (check[0]?.payout_due_date) scheduled++; else cleared++;
    }

    console.log(`[backfill] Done — ${scheduled} PI(s) got a due date (CI already paid), ${cleared} cleared to awaiting-payment.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
