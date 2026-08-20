'use strict';

/**
 * Advance payments — money received before the invoice exists.
 *
 * THE SHAPE OF THE FEATURE
 * ────────────────────────
 * A customer drops a vehicle, the workshop quotes ₹5,000, and the customer
 * pays ₹2,000 there and then. The job runs for three days. Only afterwards is
 * an invoice raised — and by then the ₹2,000 has to already be recorded, and
 * has to land on that invoice by itself.
 *
 *     Estimate ₹5,000  →  Advance ₹2,000  →  Invoice ₹5,000  →  Balance ₹3,000
 *
 * WHY THE ESTIMATE, AND NOT THE APPOINTMENT
 * ─────────────────────────────────────────
 * Two reasons, and both are load-bearing.
 *
 *   1. The amount. An advance is a slice of a known GST-inclusive total. Take
 *      it against a bare appointment and there is no total, so there is no way
 *      to say how much tax is inside it — which a taxable receipt must state.
 *
 *   2. The destination. Migration 075 enforces ONE customer invoice per
 *      estimate. So an advance taken against an estimate has exactly one
 *      possible invoice, for ever. That is what makes automatic application
 *      correct rather than a guess, and it is why this service never has to
 *      ask "which invoice did they mean?".
 *
 * GST IS INSIDE THE AMOUNT, NEVER ADDED TO IT
 * ───────────────────────────────────────────
 * ₹2,000 means the customer pays ₹2,000. The tax within it is the same
 * proportion as in the estimate it came from:
 *
 *     gst_amount = advance × (estimate.total_gst / estimate.grand_total)
 *
 * Snapshotted at capture and never recomputed. An estimate can be edited after
 * the money is taken, and a receipt already in a customer's hands must not
 * change its own tax.
 *
 * WHAT THIS SERVICE DOES NOT DO
 * ─────────────────────────────
 * It never writes to customer_invoices, and it never computes a balance. Money
 * reaching an invoice happens in exactly one place — recalcInvoiceState — and
 * this service reaches it the same way every other payment does: by writing a
 * payment_allocations row and calling that function.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const { getGateway } = require('./gateway');
const { recalcInvoiceState, readInvoiceBalance } = require('./invoiceBalance.service');
const { generatePublicToken, ensureCustomerIdentity } = require('../utils/publicToken');

/** 4xx that the controllers' handle() turns into a clean response. */
function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/** Our own reference, matching the payments module's existing shape. */
function newAdvanceRef() {
  return `AD${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const MANUAL_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'];

/**
 * What is LEFT of a payment: the amount, less what has been applied to
 * invoices, less what has been given back.
 *
 * ── THE REFUND TERM IS NOT OPTIONAL ─────────────────────────────────────────
 * It was missing, and the effect was quiet. A ₹1,180 advance with ₹1,000 on an
 * invoice and the remaining ₹180 refunded still read as ₹180 of credit — money
 * the customer had already been given back, offered for spending a second time.
 * The customer page showed it, and applying it failed with a confusing error at
 * the last step rather than never offering it.
 *
 * PENDING refunds count too, for the same reason the refund ceiling counts
 * them: money already promised to the customer is not money that can also pay
 * an invoice, and a gateway refund is pending for days.
 *
 * One fragment, interpolated everywhere the question is asked, because four
 * copies of this arithmetic is four chances for one of them to forget the
 * refunds again. `p` is the customer_invoice_payments alias in every caller.
 */
const REMAINING_SQL = `
  p.amount
    - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                 WHERE a.ledger_payment_id = p.id), 0)
    - COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                 WHERE rf.ledger_payment_id = p.id
                   AND rf.status IN ('pending', 'processed')), 0)`;

/**
 * Is what is left of this payment a DEPOSIT HELD AGAINST A JOB?
 *
 * ── The bug this exists to close ────────────────────────────────────────────
 *
 * "Unused credit" was one number: everything unapplied, for that mobile,
 * whatever it was taken for. A ₹9,000 deposit on the Fortuner counted the same
 * as ₹500 of change left over from an overpayment — so the Apply-credit button
 * would spend the Fortuner deposit on an unrelated Innova invoice, and nobody
 * would find out until the Fortuner was invoiced and the money was gone.
 *
 * The customer paid that ₹9,000 for a reason. The reason is on the row —
 * estimate_id — and it was simply never read.
 *
 * ── Why "has no invoice yet" and not just "is an advance" ───────────────────
 *
 * Once the estimate has been invoiced the deposit has done its job:
 * autoApplyForInvoice has consumed what the invoice needed, and anything still
 * unapplied is genuinely spare money with no claim on it. Holding THAT back
 * would trap it. So the test is not "was this an advance" but "is the job it
 * was taken for still waiting to be billed".
 *
 * Cancelled invoices do not count as billed, or cancelling an invoice would
 * quietly release a deposit the customer still expects to be honoured.
 *
 * ── Held is not frozen ──────────────────────────────────────────────────────
 *
 * This flag keeps money out of the AUTOMATIC paths — the oldest-first plan and
 * applyCustomerCredit. It does not stop anybody allocating it deliberately.
 * That matters because an estimate has no cancelled state (migration 062's
 * CHECK has no such value), so a job that is quietly abandoned would otherwise
 * hold its deposit hostage forever with no way out but a refund.
 *
 * `p` is the customer_invoice_payments alias, same as REMAINING_SQL.
 */
const HELD_SQL = `(
  p.payment_type = 'advance'
  AND p.estimate_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM customer_invoices ci
     WHERE ci.estimate_id = p.estimate_id
       AND ci.status <> 'cancelled'
  )
)`;

/**
 * What an invoice still owes, as a SQL expression.
 *
 * Deliberately the same arithmetic as readInvoiceBalance in
 * invoiceBalance.service.js — allocations rather than payments, minus PROCESSED
 * refunds only. If these two ever disagree the planner will offer to pay an
 * amount the allocator then refuses, and the error will arrive at the last
 * possible moment with nothing on screen explaining it.
 *
 * `ci` is the customer_invoices alias.
 */
const INVOICE_DUE_SQL = `(
  ci.grand_total
    - COALESCE((SELECT SUM(l.amount) FROM invoice_payment_lines l
                 WHERE l.customer_invoice_id = ci.id), 0)
    + COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                 WHERE rf.customer_invoice_id = ci.id
                   AND rf.status = 'processed'), 0)
)`;

/**
 * The tolerance, in rupees, below which a balance is nothing.
 *
 * Not a taste. recalcInvoiceState flips an invoice to 'paid' at
 * `amount_paid >= grand_total - 0.011`, so anything looser here leaves invoices
 * the planner thinks are settled sitting at 'partially_paid', and anything
 * tighter has the planner chasing four-tenths of a paisa across a customer's
 * whole history. One constant, shared, so the two can never drift.
 */
const PAISE = 0.011;

/** Money, rounded the way money is. */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;


// ─────────────────────────────────────────────────────────────────────────────
// Financial year
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The Indian financial year for a date: April to March, '2026-27'.
 *
 * Computed in IST, not UTC. A payment taken at 11pm on 31 March in Ahmedabad
 * is 5:30pm UTC the same day — but one taken at 6am on 1 April is 00:30 UTC on
 * 1 April, and a naive UTC read of a payment at 2am IST on 1 April would place
 * it in the previous year. That is a receipt numbered into a series that has
 * already been filed.
 */
function financialYear(when = new Date()) {
  const ist = new Date(new Date(when).getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;          // 1-12
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voucher numbering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issues the next receipt number for an advance.
 *
 * MUST be called inside the transaction that captures the money, and only when
 * the money is confirmed. Two rules follow from that and neither is optional:
 *
 *   • On capture, never on creation. A customer who opens a payment link and
 *     walks away must not consume a number, because a gap in a tax series is
 *     something a person has to account for later.
 *
 *   • Under a row lock. Two customers paying in the same second must not be
 *     handed the same number. The FOR UPDATE serialises them; the unique index
 *     on voucher_no is what actually guarantees it, because that does not rely
 *     on this function being written correctly.
 *
 * @param {object} client  in-transaction pg client, NOT the pool
 * @param {number|null} hubId  null for the company-wide series
 * @returns {Promise<{voucher_no, voucher_fy, voucher_seq}>}
 */
async function issueVoucherNumber(
  client,
  { hubId = null, when = new Date(), prefix = 'ADV', docKind = 'receipt' } = {}
) {
  const fy = financialYear(when);

  // Create the series row if this is the first document of its kind this year.
  // ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT: two first-of-the-
  // year payments arriving together would both find nothing and both insert.
  await client.query(
    `INSERT INTO advance_voucher_sequences (hub_id, fy, doc_kind) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [hubId, fy, docKind]
  );

  // The lock. Everything after this line is serialised per series.
  //
  // FOR UPDATE is REDUNDANT here, and kept deliberately. The INSERT above
  // already takes a row lock on the conflicting row, so a second caller blocks
  // there before ever reaching this SELECT — measured, not assumed: with the
  // FOR UPDATE removed, two concurrent callers still receive consecutive
  // numbers. Which means no test can catch its removal, and this comment is the
  // only thing standing between it and someone deleting it as dead weight.
  //
  // It stays because the safety must not depend on a detail of the statement
  // above it. Change that INSERT to a SELECT-then-INSERT and the lock is the
  // only thing left holding the series together.
  //
  // doc_kind is part of the key (migration 139): receipts and refunds count
  // separately, or issuing a refund would make the receipt series skip a
  // number — and a gap in a tax series is something a person has to explain.
  const cur = await client.query(
    `SELECT id, next_seq FROM advance_voucher_sequences
      WHERE fy = $1 AND hub_id IS NOT DISTINCT FROM $2 AND doc_kind = $3
      FOR UPDATE`,
    [fy, hubId, docKind]
  );
  if (!cur.rows[0]) {
    // Only reachable if the INSERT above was rolled back by a concurrent
    // failure. Louder than a silent NULL voucher number, which would produce
    // an unnumbered tax receipt.
    throw fail(500, 'Could not allocate an advance receipt number. Please try again.');
  }

  const seq = cur.rows[0].next_seq;
  await client.query(
    `UPDATE advance_voucher_sequences SET next_seq = next_seq + 1, updated_at = NOW() WHERE id = $1`,
    [cur.rows[0].id]
  );

  return {
    voucher_no: `${prefix}-${fy}-${String(seq).padStart(6, '0')}`,
    voucher_fy: fy,
    voucher_seq: seq,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the estimate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The estimate an advance is being taken against, plus how much is left to
 * take and what proportion of it is tax.
 *
 * `already` counts CAPTURED advances only. A payment link somebody generated
 * and never sent is not money, and letting it reserve part of the total would
 * mean an advance the customer is standing there ready to pay being refused.
 */
async function readEstimateForAdvance(db, estimateId) {
  const r = await db.query(
    `SELECT e.id, e.status, e.hub_id, e.appointment_id, e.public_token,
            e.grand_total, e.total_gst,
            COALESCE(e.customer_name, a.customer_name)   AS customer_name,
            COALESCE(e.mobile,        a.mobile)          AS mobile,
            COALESCE(e.vehicle_number, a.vehicle_number) AS vehicle_number,
            (SELECT id FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_id,
            (SELECT COALESCE(SUM(p.amount), 0)
               FROM customer_invoice_payments p
              WHERE p.estimate_id = e.id
                AND p.payment_type = 'advance') AS already
       FROM estimates e
       LEFT JOIN appointments a ON a.id = e.appointment_id
      WHERE e.id = $1`,
    [estimateId]
  );
  const est = r.rows[0];
  if (!est) throw fail(404, 'Estimate not found');

  const total = Number(est.grand_total);
  const already = Number(est.already);
  return {
    ...est,
    grand_total: total,
    total_gst: Number(est.total_gst),
    already,
    collectable: Number((total - already).toFixed(2)),
    // The share of any amount taken against this estimate that is tax.
    gstFraction: total > 0 ? Number(est.total_gst) / total : 0,
  };
}

/**
 * Validates that an advance of this size can be taken, and works out its tax.
 *
 * The ceiling is the estimate total, not something larger. A workshop taking
 * MORE than the quoted job as an "advance" is not taking an advance; it is
 * taking money it will have to give back, and the refund path is a worse place
 * to discover that than this one.
 */
function resolveAdvance(est, requested) {
  if (!(est.grand_total > 0)) {
    throw fail(409, 'This estimate has no total yet, so there is nothing to take an advance against.');
  }
  if (est.customer_invoice_id) {
    throw fail(409,
      'An invoice has already been raised for this job — record the payment against the invoice instead of taking an advance.',
      { code: 'INVOICE_EXISTS', customer_invoice_id: est.customer_invoice_id });
  }
  if (est.collectable <= 0.01) {
    throw fail(409, `The full amount of ₹${est.grand_total.toFixed(2)} has already been received in advance.`);
  }

  const asked = Number(requested);
  if (!Number.isFinite(asked) || asked <= 0) throw fail(400, 'Enter a valid amount to collect.');
  if (asked > est.collectable + 0.01) {
    throw fail(400,
      `₹${asked.toFixed(2)} is more than the ₹${est.collectable.toFixed(2)} still to be collected on this job.`);
  }

  const amount = Number(asked.toFixed(2));
  return {
    amount,
    // amount is GST-INCLUSIVE. This is the tax already inside it, in the same
    // proportion the estimate carries — not tax added on top.
    gst_amount: Number((amount * est.gstFraction).toFixed(2)),
    gst_rate: est.grand_total > est.total_gst && est.total_gst > 0
      ? Number(((est.total_gst / (est.grand_total - est.total_gst)) * 100).toFixed(2))
      : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating an advance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a CASH (or UPI / card / transfer) advance taken at the counter.
 *
 * The money is already in hand, so the ledger row is written captured and the
 * voucher number is issued immediately — there is no pending state for cash.
 * No allocation is written: there is no invoice to allocate to yet, and that
 * absence is exactly what makes this money show as the customer's credit.
 */

/**
 * Sends the customer their receipt voucher, once the money is real.
 *
 * Its OWN transaction, and every failure swallowed. The advance is already
 * committed by the time this runs — a messaging problem must never be able to
 * unwind money that was taken, and the dispatcher needs a real client for its
 * savepoint.
 *
 * Deduped on the payment id, so a retried webhook does not send a second copy
 * of the same receipt.
 */
async function sendReceiptMessage(ledgerPaymentId) {
  // Which template(s) fire is the 'payment.advance_received' automation rows
  // (Settings → WhatsApp → Automations, migration 151).
  // fireWhatsAppEventDetached owns the connection, transaction and logging,
  // and never throws. Lazy require, as before, to avoid an import cycle.
  const { fireWhatsAppEventDetached } = require('./whatsappAutomations.service');
  await fireWhatsAppEventDetached(pool, {
    event: 'payment.advance_received',
    entityId: ledgerPaymentId,
    dedupeKey: `advance:${ledgerPaymentId}`,
  });
}

async function createManualAdvance({ estimateId, amount, method = 'cash', referenceNo = null, notes = null, userId = null }) {
  if (!MANUAL_METHODS.includes(method)) throw fail(400, 'Unsupported payment method.');

  let out = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE on the estimate: two advances recorded against the same job at
    // the same moment must not both pass the collectable check.
    const lock = await client.query(`SELECT id FROM estimates WHERE id = $1 FOR UPDATE`, [estimateId]);
    if (!lock.rows[0]) throw fail(404, 'Estimate not found');

    const est = await readEstimateForAdvance(client, estimateId);
    const { amount: amt, gst_amount, gst_rate } = resolveAdvance(est, amount);

    const voucher = await issueVoucherNumber(client, { hubId: null });

    const ins = await client.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by,
          source, hub_id, payment_type, estimate_id, appointment_id, mobile, vehicle_number,
          voucher_no, voucher_fy, voucher_seq, public_token, gst_amount, gst_rate)
       VALUES (NULL,$1,$2,$3,NOW(),$4,$5,'manual',$6,'advance',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [amt, method, referenceNo, notes, userId, est.hub_id, est.id, est.appointment_id,
       est.mobile, est.vehicle_number,
       voucher.voucher_no, voucher.voucher_fy, voucher.voucher_seq, generatePublicToken(),
       gst_amount, gst_rate]
    );

    await client.query('COMMIT');
    console.log(`[advance] ${voucher.voucher_no} — ₹${amt} by ${method} against estimate ${est.id}`);
    out = { advance: ins.rows[0], estimate: est };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // AFTER the connection is released, not just after the COMMIT.
  //
  // sendReceiptMessage opens a connection of its own. Sending while still
  // holding this one means every advance occupies two, and ten advisors taking
  // cash at the same moment exhaust a ten-connection pool — the tenth waits for
  // a connection that will not free until the ninth finishes sending a WhatsApp
  // message. The receipt is a consequence of the money being recorded, never a
  // condition of it, so it can wait until the transaction is fully done with.
  await sendReceiptMessage(out.advance.id);
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// Money on the customer, before any job exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The GST rate for money taken with no job attached.
 *
 * An advance against an estimate takes its tax from that estimate — the same
 * proportion as the job it is part of. With no job there is nothing to take a
 * proportion of, and a receipt voucher must still state its tax. So the rate is
 * a company-wide setting, answered once by the company's accountant.
 *
 * NULL means unanswered, and unanswered means REFUSED, not guessed. There is no
 * safe default: a wrong rate ends up on a tax document the customer keeps, and
 * an 18% guess on a business that sells parts at 28% is a compliance defect
 * this function would be manufacturing at the rate of one per payment.
 */
async function accountCreditRate(db) {
  const r = await db.query(
    `SELECT advance_default_gst_rate FROM company_settings WHERE id = 1 LIMIT 1`);
  const rate = r.rows[0]?.advance_default_gst_rate;
  if (rate === null || rate === undefined) {
    throw fail(409,
      'Taking money before a job exists is switched off, because nobody has set the GST rate for it yet. '
      + 'Set it in Settings once your accountant has confirmed which rate applies, or raise an estimate '
      + 'first and take the advance against that.',
      { code: 'ADVANCE_RATE_NOT_SET' });
  }
  return Number(rate);
}

/**
 * The tax inside an amount, at a known rate.
 *
 * INCLUSIVE, exactly as everywhere else in this feature: ₹1,000 means the
 * customer pays ₹1,000, and the tax is the part of it that is tax. Adding the
 * rate on top would charge them ₹1,180 for a figure they were quoted as ₹1,000.
 */
function inclusiveGst(amount, ratePercent) {
  const rate = Number(ratePercent) || 0;
  if (rate <= 0) return 0;
  return Number((Number(amount) * rate / (100 + rate)).toFixed(2));
}

/**
 * Records money taken from a customer with no job attached.
 *
 * ── HOW THIS DIFFERS FROM createManualAdvance ───────────────────────────────
 * That one takes a slice of a known total. This one takes money from a person.
 * Three consequences, and all three are the reason it is a separate function
 * rather than a nullable parameter:
 *
 *   • NO CEILING. There is no job total to stay under, so nothing here can
 *     refuse an amount for being too large. The confirmation step in the UI is
 *     the only guard, and a mistyped figure becomes a refund rather than an
 *     error. Said plainly because it is a real difference in safety.
 *
 *   • NO AUTOMATIC DESTINATION. An estimate has exactly one possible invoice
 *     (migration 075), which is what makes auto-apply correct there. A customer
 *     has any number, so this money waits as credit until somebody applies it.
 *     The invoice screen prompts; it does not decide.
 *
 *   • THE RATE COMES FROM A SETTING, not from the work being paid for.
 *
 * What is the SAME, deliberately: it is an ordinary row in the one payments
 * ledger, with an ordinary receipt voucher on the ordinary series. It is not a
 * second kind of money.
 */
async function createAccountCredit({
  mobile, amount, method = 'cash', referenceNo = null, notes = null,
  vehicleNumber = null, userId = null,
}) {
  if (!MANUAL_METHODS.includes(method)) throw fail(400, 'Unsupported payment method.');

  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) throw fail(400, 'Enter a valid amount to collect.');
  const amt = Number(num.toFixed(2));

  const who = String(mobile || '').trim();
  if (who.length < 6) throw fail(400, 'A mobile number is needed — it is who the money belongs to.');

  // Read the rate BEFORE opening the transaction. It refuses when unset, and
  // there is no reason to hold a connection open to discover that.
  const rate = await accountCreditRate(pool);

  let out = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The customer must exist as an identity, or the money would be attached to
    // a number no screen resolves to a person. Idempotent — a no-op for anyone
    // who has ever been seen before.
    await ensureCustomerIdentity(client, who);

    const voucher = await issueVoucherNumber(client, { hubId: null });

    const ins = await client.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by,
          source, payment_type, estimate_id, mobile, vehicle_number,
          voucher_no, voucher_fy, voucher_seq, public_token, gst_amount, gst_rate)
       VALUES (NULL,$1,$2,$3,NOW(),$4,$5,'manual','advance',NULL,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [amt, method, referenceNo, notes, userId, who, vehicleNumber,
       voucher.voucher_no, voucher.voucher_fy, voucher.voucher_seq, generatePublicToken(),
       inclusiveGst(amt, rate), rate]
    );

    await client.query('COMMIT');
    console.log(`[advance] ${voucher.voucher_no} — ₹${amt} on account for ${who}`);
    out = { advance: ins.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After the release, for the same reason every other capture path does it:
  // the receipt is a consequence of the money being recorded, never a condition
  // of it, and it must not hold the transaction's connection while it sends.
  await sendReceiptMessage(out.advance.id);
  return out;
}

/**
 * Opens a gateway payment link for an advance.
 *
 * Nothing is written to the ledger here. A link is a request, not money — the
 * ledger row and the voucher number are both created by captureAdvance() when
 * the gateway confirms the payment. That ordering is the whole reason an
 * abandoned link cannot leave a hole in the receipt series.
 */
async function createAdvanceLink({ estimateId, amount, userId = null, expiresInDays = null }) {
  const gateway = getGateway();

  // Same refusal as UPI QR, for the same reason: an advance paid online is
  // confirmed by webhook, and without a webhook secret the customer can pay
  // and nothing will ever record it.
  if (!gateway.isWebhookConfigured()) {
    throw fail(503,
      'Online advances cannot be taken until the payment webhook is configured. A customer could pay and the '
      + 'money would never be recorded. Set RAZORPAY_WEBHOOK_SECRET and register the webhook URL.',
      { code: 'WEBHOOK_NOT_CONFIGURED' });
  }

  const est = await readEstimateForAdvance(pool, estimateId);
  const { amount: amt, gst_amount, gst_rate } = resolveAdvance(est, amount);

  const ttlDays = Math.min(Math.max(Number(expiresInDays) || 7, 1), 90);
  const txnRef = newAdvanceRef();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const link = await client.query(
      `INSERT INTO payment_links
         (token, entity_type, entity_id, hub_id, amount, status, expires_at, notes, created_by)
       VALUES ($1,'estimate',$2,$3,$4,'active', NOW() + ($5 || ' days')::interval, $6, $7)
       RETURNING *`,
      [generatePublicToken(), est.id, est.hub_id, amt, String(ttlDays),
       `Advance against estimate ${est.id}`, userId]
    );

    const txn = await client.query(
      `INSERT INTO payment_transactions
         (txn_ref, gateway, mode, entity_type, entity_id, hub_id, mobile,
          amount, currency, status, payment_link_id, created_by)
       VALUES ($1,$2,$3,'estimate',$4,$5,$6,$7,'INR','created',$8,$9)
       RETURNING *`,
      [txnRef, gateway.name, gateway.mode(), est.id, est.hub_id, est.mobile,
       amt, link.rows[0].id, userId]
    );

    await client.query('COMMIT');
    return {
      link: link.rows[0],
      txn: txn.rows[0],
      estimate: est,
      amount: amt,
      gst_amount,
      gst_rate,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Records a VERIFIED advance capture. The only path by which an online advance
 * becomes money.
 *
 * Called from the same places captureVerifiedPayment is — the browser callback
 * and the webhook — and like that function it does not verify anything itself,
 * because its two callers verify different things and pretending otherwise
 * would mean one of them passing a signature it never had.
 *
 * DUPLICATES ARE EXPECTED. Razorpay reports a capture twice by design. The
 * already-captured check plus the partial unique index on gateway_payment_id
 * are what make the second one a no-op — and critically, a second call must
 * not draw a second voucher number, because that would leave a gap where the
 * unused number was.
 */
async function captureAdvance({ txnId, gatewayPaymentId, gatewayPayment = null, via = 'callback' }) {
  let out = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const t = await client.query(
      `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`, [txnId]);
    const txn = t.rows[0];
    if (!txn) throw fail(404, 'Payment record not found');
    if (txn.entity_type !== 'estimate') throw fail(400, 'This transaction is not an advance.');

    if (txn.status === 'captured') {
      await client.query('COMMIT');
      return { captured: true, duplicate: true, txn };
    }

    const est = await readEstimateForAdvance(client, txn.entity_id);
    const amount = gatewayPayment && gatewayPayment.amount > 0
      ? gatewayPayment.amount
      : Number(txn.amount);

    // The gateway's figure is authoritative, so recompute the tax from it
    // rather than from what the link was opened for.
    const gst_amount = Number((amount * est.gstFraction).toFixed(2));
    const gst_rate = est.grand_total > est.total_gst && est.total_gst > 0
      ? Number(((est.total_gst / (est.grand_total - est.total_gst)) * 100).toFixed(2))
      : 0;

    await client.query(
      `UPDATE payment_transactions
          SET status = 'captured',
              gateway_payment_id = COALESCE($2, gateway_payment_id),
              method_detail = COALESCE($3, method_detail),
              amount = $4, error_code = NULL, error_description = NULL, updated_at = NOW()
        WHERE id = $1`,
      [txn.id, gatewayPaymentId || null, gatewayPayment?.method_detail || null, amount]
    );

    // The number is drawn HERE — after the already-captured check, so a repeat
    // delivery cannot consume one.
    const voucher = await issueVoucherNumber(client, { hubId: null });

    const led = await client.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by,
          payment_transaction_id, source, hub_id, payment_type, estimate_id, appointment_id,
          mobile, vehicle_number, voucher_no, voucher_fy, voucher_seq, public_token,
          gst_amount, gst_rate)
       VALUES (NULL,$1,$2,$3,NOW(),$4,$5,$6,'gateway',$7,'advance',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [amount, gatewayPayment?.method_detail === 'upi' ? 'upi' : 'other',
       gatewayPaymentId || txn.txn_ref, `Advance ${voucher.voucher_no}`, txn.created_by,
       txn.id, txn.hub_id, est.id, est.appointment_id, est.mobile, est.vehicle_number,
       voucher.voucher_no, voucher.voucher_fy, voucher.voucher_seq, generatePublicToken(),
       gst_amount, gst_rate]
    );

    if (txn.payment_link_id) {
      await client.query(
        `UPDATE payment_links SET status = 'paid', updated_at = NOW()
          WHERE id = $1 AND status = 'active'`, [txn.payment_link_id]);
    }

    await client.query('COMMIT');
    console.log(`[advance] captured ${voucher.voucher_no} via ${via} — ₹${amount} against estimate ${est.id}`);
    out = { captured: true, duplicate: led.rowCount === 0, advance: led.rows[0], amount, txn };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After the release — see createManualAdvance for why — and only for a
  // capture that actually wrote a row. A webhook delivered twice arrives here
  // with no row: the money was already recorded and the customer already has
  // the receipt.
  if (out.advance) await sendReceiptMessage(out.advance.id);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying an advance to an invoice
// ─────────────────────────────────────────────────────────────────────────────

/** What is left of a payment after everything already applied from it. */
async function unallocatedOf(db, ledgerPaymentId) {
  const r = await db.query(
    `SELECT ${REMAINING_SQL} AS remaining,
            p.amount, p.payment_type, p.mobile, p.voucher_no
       FROM customer_invoice_payments p
      WHERE p.id = $1`,
    [ledgerPaymentId]
  );
  if (!r.rows[0]) throw fail(404, 'Payment not found');
  return { ...r.rows[0], remaining: Number(r.rows[0].remaining) };
}

/**
 * Applies part or all of a received payment to an invoice.
 *
 * Two ceilings, and both matter for different reasons:
 *
 *   • never more than the payment has left — otherwise one ₹2,000 advance
 *     could settle ₹4,000 of invoices, money the workshop never received;
 *   • never more than the invoice still owes — otherwise the invoice reads
 *     overpaid and the surplus is invisible instead of remaining as credit.
 *
 * Call inside a transaction where one is already open (auto-apply does); it
 * opens its own otherwise.
 */
async function allocate(client, { ledgerPaymentId, customerInvoiceId, amount, userId = null }) {
  // ── LOCK THE LEDGER ROW FIRST ────────────────────────────────────────────
  //
  // This was a read-then-write with no lock at all, and payment_allocations has
  // no unique constraint and no CHECK against its parent — migration 133 says so
  // outright ("the service enforces the ceiling, because a CHECK cannot see
  // another table"). So the ceiling below was the only guard, and under READ
  // COMMITTED two concurrent callers both read remaining = ₹2,000 and both
  // passed it: one ₹2,000 advance settling ₹4,000 across two invoices, two hub
  // payouts scheduled against money never received, and creditFor going
  // negative afterwards.
  //
  // applyCustomerCredit already locked this row; the other two entry points —
  // POST /payments/:ref/allocate and autoApplyForInvoice — did not. Moving the
  // lock INTO allocate covers all three, including any added later, which is the
  // point: a guard that has to be remembered at each call site is one that will
  // eventually be forgotten at one of them.
  //
  // Ordered payment-then-invoice, matching applyCustomerCredit's invoice lock
  // being taken before it calls in here... which is the reverse. That is
  // deliberate and safe: applyCustomerCredit holds the invoice lock for the
  // whole loop, so it can never be the second acquirer of a payment lock it
  // does not already hold, and no other path locks an invoice before a payment.
  const locked = await client.query(
    `SELECT id FROM customer_invoice_payments WHERE id = $1 FOR UPDATE`, [ledgerPaymentId]);
  if (!locked.rows[0]) throw fail(404, 'Payment not found');

  const p = await unallocatedOf(client, ledgerPaymentId);
  if (p.remaining <= 0.001) {
    throw fail(409, 'This payment has already been fully applied.');
  }

  const invRow = await client.query(
    `SELECT ci.grand_total,
            (SELECT COALESCE(SUM(l.amount), 0) FROM invoice_payment_lines l
              WHERE l.customer_invoice_id = ci.id) AS applied,
            (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
              WHERE rf.customer_invoice_id = ci.id AND rf.status = 'processed') AS refunded
       FROM customer_invoices ci WHERE ci.id = $1`,
    [customerInvoiceId]
  );
  if (!invRow.rows[0]) throw fail(404, 'Customer invoice not found');
  const owed = Number(invRow.rows[0].grand_total)
             - (Number(invRow.rows[0].applied) - Number(invRow.rows[0].refunded));

  const asked = amount == null ? Math.min(p.remaining, owed) : Number(amount);
  if (!Number.isFinite(asked) || asked <= 0) throw fail(400, 'Enter a valid amount to apply.');
  if (asked > p.remaining + 0.01) {
    throw fail(400, `Only ₹${p.remaining.toFixed(2)} of this payment is still unapplied.`);
  }
  if (asked > owed + 0.01) {
    throw fail(400, `This invoice only has ₹${owed.toFixed(2)} outstanding.`);
  }

  const applied = Number(asked.toFixed(2));
  await client.query(
    `INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount, created_by)
     VALUES ($1,$2,$3,$4)`,
    [ledgerPaymentId, customerInvoiceId, applied, userId]
  );

  const state = await recalcInvoiceState(client, customerInvoiceId);
  return { applied, remaining: Number((p.remaining - applied).toFixed(2)), state };
}

/**
 * Puts any advance held against an estimate onto the invoice just generated
 * from it.
 *
 * WHY THIS IS SAFE TO DO WITHOUT ASKING
 * ────────────────────────────────────
 * Migration 075 enforces one customer invoice per estimate. So when an invoice
 * is generated from estimate X, every advance recorded against estimate X has
 * exactly one possible destination — this invoice. There is no other candidate
 * for it to be wrong about.
 *
 * MUST be called inside the transaction that creates the invoice. Outside it,
 * a failure between the two leaves an invoice showing the full amount due while
 * the customer's money sits as credit — and the customer is standing there
 * having already paid.
 *
 * Ordered oldest first so a part-applied advance is the newest one, which is
 * what a person reading the list expects.
 */
async function autoApplyForInvoice(client, { estimateId, customerInvoiceId, userId = null }) {
  const advances = await client.query(
    `SELECT p.id, ${REMAINING_SQL} AS remaining
       FROM customer_invoice_payments p
      WHERE p.estimate_id = $1
        AND p.payment_type = 'advance'
      ORDER BY p.paid_at ASC, p.id ASC`,
    [estimateId]
  );

  const applied = [];
  for (const adv of advances.rows) {
    if (Number(adv.remaining) <= 0.001) continue;
    try {
      const r = await allocate(client, {
        ledgerPaymentId: adv.id, customerInvoiceId, amount: null, userId,
      });
      applied.push({ payment_id: adv.id, amount: r.applied });
    } catch (err) {
      // The invoice being smaller than the advance is not an error — the
      // surplus stays as the customer's credit, which is what they asked for.
      // Anything else is worth seeing, but never worth failing the invoice
      // generation over: the invoice is correct, the money is safe, and the
      // advance can be applied by hand.
      if (err.status !== 400 && err.status !== 409) throw err;
      console.warn(`[advance] could not auto-apply payment ${adv.id} to invoice ${customerInvoiceId}: ${err.message}`);
    }
  }
  return applied;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a customer has paid that is not yet against any invoice — their credit.
 *
 * A customer is a mobile number in this system, so that is the key. Computed
 * rather than stored: credit is payments minus allocations, and a stored copy
 * is one more thing that can disagree with the ledger.
 */

/**
 * Applies a customer's unused credit to one invoice, oldest money first.
 *
 * ── WHY THIS IS ONE SERVER-SIDE CALL ────────────────────────────────────────
 * The screen used to do this itself: read the credit rows, sort them, and fire
 * one allocate request per row. That is N round-trips with no transaction
 * around them — a browser closed halfway through leaves the invoice part-paid
 * from three payments and untouched by a fourth, and nothing says so.
 *
 * Here it is one transaction. Either the whole application lands or none of it
 * does, and the invoice is recalculated once at the end instead of N times.
 *
 * ── OLDEST FIRST, AND WHY IT MATTERS ────────────────────────────────────────
 * Credit is consumed in the order it was received, so the part-used payment is
 * always the newest one. Any other order leaves a trail of half-spent receipts
 * that nobody can reconcile against the dates they were issued.
 *
 * ── THE CEILING ─────────────────────────────────────────────────────────────
 * What the invoice still OWES, never more. Applying beyond that would overpay
 * it and bury the surplus inside amount_paid, where it stops being visible as
 * the customer's credit — which is the one thing this whole feature exists to
 * keep visible.
 */
async function applyCustomerCredit({ mobile, customerInvoiceId, userId = null, limit = null }) {
  const who = String(mobile || '').trim();
  if (!who) throw fail(400, 'A customer is needed.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the invoice first, then read what it owes. Two advisors applying
    // credit to the same invoice at the same moment must not both see the full
    // balance and both fill it.
    const inv = await client.query(
      `SELECT id, grand_total, amount_paid, status
         FROM customer_invoices WHERE id = $1 FOR UPDATE`,
      [customerInvoiceId]
    );
    if (!inv.rows[0]) throw fail(404, 'Invoice not found');
    if (inv.rows[0].status === 'cancelled') {
      throw fail(409, 'This invoice has been cancelled, so money cannot be applied to it.');
    }

    // From the ledger, not the cached amount_paid — the cache is a summary and
    // this is the moment it matters that they agree.
    //
    // `.balance`, not `.paid`: readInvoiceBalance returns amount_paid and
    // balance, and there is no `paid` key on it. Reading one gives undefined,
    // the subtraction gives NaN, and NaN silently propagates into the amount
    // handed to allocate — which then refuses with a message about an invalid
    // amount that says nothing about where it came from.
    const bal = await readInvoiceBalance(client, customerInvoiceId);
    if (!bal) throw fail(404, 'Invoice not found');
    const owed = Number(bal.balance);
    if (!Number.isFinite(owed)) {
      throw fail(500, 'Could not work out what this invoice still owes.');
    }
    if (owed <= 0.01) {
      throw fail(409, 'This invoice is already settled, so there is nothing to apply credit to.');
    }

    // NOT every unapplied payment — every FREE one.
    //
    // This clause is the behaviour change. Until now a deposit taken against an
    // un-invoiced job was indistinguishable from spare change here, so pressing
    // "apply credit" on any invoice could spend it. The customer paid it for a
    // named job; it is not this invoice's money to take.
    //
    // The effect somebody will notice: the credit figure on a customer holding
    // a deposit drops, and applying credit may now find less than it used to.
    // That is the fix, not a regression. The deposit is still theirs, still
    // visible, and still allocatable by hand from the payment itself.
    const rows = await client.query(
      `SELECT p.id, p.paid_at, p.voucher_no, ${REMAINING_SQL} AS remaining
         FROM customer_invoice_payments p
        WHERE p.mobile = $1
          AND NOT ${HELD_SQL}
        ORDER BY p.paid_at ASC, p.id ASC
          FOR UPDATE`,
      [who]
    );

    let left = Math.min(owed, limit === null ? owed : Number(limit));
    const applied = [];
    for (const row of rows.rows) {
      if (left <= 0.001) break;
      const avail = Number(row.remaining);
      if (avail <= 0.001) continue;
      const take = Number(Math.min(avail, left).toFixed(2));
      const r = await allocate(client, {
        ledgerPaymentId: row.id, customerInvoiceId, amount: take, userId,
      });
      applied.push({ payment_id: row.id, voucher_no: row.voucher_no, amount: r.applied });
      left = Number((left - r.applied).toFixed(2));
    }

    if (!applied.length) {
      // Say WHICH kind of nothing. "No unused credit" in front of a customer
      // page showing ₹9,000 reads as a broken screen; naming the deposit turns
      // it into a fact the advisor can act on.
      const brk = await creditBreakdown(client, who);
      if (brk.held > PAISE) {
        throw fail(409,
          `This customer's ₹${brk.held} is a deposit held against a job that has not been invoiced yet, `
          + `so it is not free credit. Apply it from the payment itself if it really belongs here.`);
      }
      throw fail(409, 'This customer has no unused credit to apply.');
    }

    await client.query('COMMIT');
    const total = Number(applied.reduce((s, a) => s + a.amount, 0).toFixed(2));
    console.log(`[advance] applied ₹${total} of ${who}'s credit to invoice ${customerInvoiceId}`);
    return { applied, total };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function creditFor(db, mobile) {
  const r = await db.query(
    `SELECT COALESCE(SUM(${REMAINING_SQL}), 0) AS credit
       FROM customer_invoice_payments p
      WHERE p.mobile = $1`,
    [mobile]
  );
  return Number(r.rows[0].credit);
}

/**
 * The same money as creditFor, told apart.
 *
 * `free` is spendable on anything. `held` is deposits sitting against jobs that
 * have not been billed yet — real money, the customer's, but already spoken
 * for. The two used to be added together and called "unused credit", which is
 * how a Fortuner deposit came to be spendable on an Innova invoice.
 *
 * `total` is kept and is exactly what creditFor returns, so a caller that only
 * wants the old number still gets it and cannot be broken by this.
 *
 * `held_items` carries the jobs, because "₹9,000 held" with no answer to
 * "held for what?" is a number nobody can act on.
 */
async function creditBreakdown(db, mobile) {
  const r = await db.query(
    `SELECT p.id, p.voucher_no, p.estimate_id, p.paid_at,
            ${REMAINING_SQL} AS remaining,
            ${HELD_SQL}      AS held,
            e.vehicle_number, e.customer_name, e.grand_total AS estimate_total
       FROM customer_invoice_payments p
       LEFT JOIN estimates e ON e.id = p.estimate_id
      WHERE p.mobile = $1
      ORDER BY p.paid_at ASC, p.id ASC`,
    [mobile]
  );

  let free = 0, held = 0;
  const held_items = [];
  for (const row of r.rows) {
    const rem = Number(row.remaining);
    if (rem <= PAISE) continue;
    if (row.held) {
      held = r2(held + rem);
      held_items.push({
        payment_id:  row.id,
        voucher_no:  row.voucher_no,
        estimate_id: row.estimate_id,
        amount:      r2(rem),
        // Enough to name the job on screen without a second round trip.
        label: [row.vehicle_number, row.customer_name].filter(Boolean).join(' · ') || null,
      });
    } else {
      free = r2(free + rem);
    }
  }
  return { total: r2(free + held), free, held, held_items };
}

// ─────────────────────────────────────────────────────────────────────────────
// The allocation planner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where would this much money go?
 *
 * Reads only. Produces the plan that POST /api/payments/receive then executes,
 * and the same plan GET /api/payments/plan shows in the dialog before anybody
 * commits to it — one function, so the preview cannot promise something the
 * save then does differently.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Oldest invoice first, each filled completely before the next is touched.
 * Whatever is left over becomes credit.
 *
 * Oldest by invoice_date, not created_at: the business date is what "oldest"
 * means to anyone reading an ageing report, and backdating (migration 100)
 * makes the two disagree on purpose.
 *
 * Deliberately NOT "find the invoice whose balance matches the amount". It
 * looks clever on the easy case and has no answer at all when two invoices are
 * both ₹5,000, and it silently steps over older debt because a newer invoice
 * happened to match — which is exactly the thing an ageing report exists to
 * prevent.
 *
 * ── Why the hub matters ─────────────────────────────────────────────────────
 *
 * allocate() has never cared which hub an invoice belongs to, and on its own
 * that is fine — a human choosing an invoice knows what they are choosing. An
 * AUTOMATIC split is different: migration 083 starts a hub's payout clock from
 * the moment its invoice is paid, so cash taken at Bopal landing on Satellite's
 * older invoice would quietly start Satellite's payout with Bopal's money.
 *
 * So the automatic plan stays inside the hub the money was taken at. Invoices
 * elsewhere are not hidden — they come back under `skipped_other_hub` so the
 * dialog can offer them — they are simply never chosen for you.
 *
 * A null hubId means the payment is not attached to a hub at all, and there is
 * nothing to scope by; every invoice is in scope.
 *
 * @param {object}   db
 * @param {string}   mobile
 * @param {number}   amount        new money being received
 * @param {number?}  hubId         the hub receiving it; null = no scoping
 * @param {boolean}  useCredit     add the customer's FREE credit to the pot
 * ── UNTICKING AN INVOICE MUST NOT MOVE MONEY TO ANOTHER ONE ────────────────
 *
 * excludeInvoiceIds are the invoices somebody unticked in the dialog. They get
 * nothing — and, crucially, the money they WOULD have taken does not pass down
 * the list to the next invoice. It becomes credit.
 *
 * That distinction is the whole reason this parameter exists rather than the
 * caller simply filtering the list before calling. Filtering re-runs the split
 * over what is left, so unticking the invoice that was getting ₹6 handed the ₹6
 * to the next one, and unticking that handed it to the one after. Four invoices
 * meant four clicks and the crumb was still on screen.
 *
 * Here the split runs over EVERY invoice exactly as it would have, so no row's
 * figure shifts because of a row above it. An excluded invoice then simply
 * keeps nothing. Untick one thing, one thing changes.
 *
 * @param {object?}  overrides     { [customer_invoice_id]: amount } fixed by hand
 * @param {number[]?} onlyInvoiceIds  restrict the plan to these invoices
 * @param {number[]?} excludeInvoiceIds  unticked — take nothing, pass nothing on
 */
async function planAllocation(db, {
  mobile,
  amount = 0,
  hubId = null,
  useCredit = false,
  overrides = null,
  onlyInvoiceIds = null,
  excludeInvoiceIds = null,
} = {}) {
  const who = String(mobile || '').trim();
  if (!who) throw fail(400, 'A customer is needed.');

  const credit = await creditBreakdown(db, who);

  // Every open invoice for this customer, oldest business date first. The hub
  // split happens in JS rather than in the WHERE clause so the ones we passed
  // over can be reported instead of vanishing.
  const inv = await db.query(
    `SELECT ci.id, ci.hub_id, ci.invoice_date, ci.status, ci.grand_total,
            ci.vehicle_number,
            ${INVOICE_DUE_SQL} AS due,
            -- hub_name, not name. The hubs table has no plain "name" column
            -- (migration 016) and never has; h.name here produced a 500 on
            -- every call to this planner. The test schema hid it by inventing
            -- a hubs table with the column this query happened to want.
            h.hub_name AS hub_name
       FROM customer_invoices ci
       LEFT JOIN hubs h ON h.id = ci.hub_id
      WHERE ci.mobile = $1
        AND ci.status <> 'cancelled'
      ORDER BY ci.invoice_date ASC, ci.id ASC`,
    [who]
  );

  const open = inv.rows
    .map(r => ({ ...r, due: r2(r.due) }))
    .filter(r => r.due > PAISE);

  const wanted = onlyInvoiceIds ? new Set(onlyInvoiceIds.map(Number)) : null;

  const inScope = [], otherHub = [];
  for (const r of open) {
    if (wanted && !wanted.has(r.id)) continue;
    // IS NOT DISTINCT FROM, in JS: two nulls are the same hub.
    const sameHub = hubId === null || (r.hub_id ?? null) === (hubId ?? null);
    // An explicit list is a human's choice and outranks the hub rule.
    if (sameHub || wanted) inScope.push(r);
    else otherHub.push(r);
  }

  const creditUsable = useCredit ? credit.free : 0;
  const pot = r2(r2(amount) + creditUsable);
  const excluded = new Set((excludeInvoiceIds || []).map(Number));

  let left = pot;
  const lines = [];
  for (const r of inScope) {
    const pinned = overrides && overrides[r.id] !== undefined;
    // A hand-set figure is still bounded by what the invoice owes and by what
    // is actually in hand — an override is a preference, not a licence to
    // invent money or overpay an invoice.
    const want = pinned ? r2(overrides[r.id]) : r.due;
    const natural = r2(Math.max(0, Math.min(want, r.due, left)));

    // `left` drops by what this invoice WOULD have taken, excluded or not.
    // That one line is what stops an unticked invoice handing its share to the
    // invoice below it: every row downstream sees exactly the money it would
    // have seen anyway, so nothing shifts.
    left = r2(left - natural);

    const off  = excluded.has(r.id);
    const take = off ? 0 : natural;
    lines.push({
      customer_invoice_id: r.id,
      hub_id:       r.hub_id,
      hub_name:     r.hub_name,
      invoice_date: r.invoice_date,
      vehicle_number: r.vehicle_number,
      due:          r.due,
      take,
      after:        r2(r.due - take),
      settles:      r2(r.due - take) <= PAISE && take > 0,
      pinned:       !!pinned,
      excluded:     off,
    });
  }

  const allocated = r2(lines.reduce((s, l) => s + l.take, 0));

  return {
    mobile: who,
    amount: r2(amount),
    hub_id: hubId,
    credit_available: credit.free,
    credit_held:      credit.held,
    credit_held_items: credit.held_items,
    credit_used: useCredit ? r2(Math.min(creditUsable, allocated)) : 0,
    pot,
    lines,
    allocated,
    // What is not going to any invoice: an overpayment's surplus, plus
    // whatever the unticked invoices gave up. Both become credit on the
    // customer, which is the same thing said two ways.
    leftover: r2(Math.max(0, pot - allocated)),
    excluded: [...excluded],
    skipped_other_hub: otherHub.map(r => ({
      customer_invoice_id: r.id,
      hub_id: r.hub_id,
      hub_name: r.hub_name,
      invoice_date: r.invoice_date,
      due: r.due,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The voucher documents
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything documentAdapter.fromAdvanceReceipt reads, for ONE receipt.
 *
 * Built here rather than in the controller because there are two callers — the
 * staff PDF route and the public link — and they must print the identical
 * document. A customer comparing their copy against the one an advisor is
 * holding is the entire point of a numbered voucher.
 *
 * Exactly one of the three selectors is used. `publicToken` is the untrusted
 * one; it is matched against the payment's own token and nothing else, so no
 * token can be made to select a different customer's receipt.
 */
/**
 * Take money and put it where it belongs, in one transaction.
 *
 * ── One ledger row, N allocations ───────────────────────────────────────────
 *
 * The payment is recorded once, with its own receipt number, exactly as
 * createAccountCredit records one. What is new is that it may then be spread
 * over several invoices through allocate() — the same allocate() every other
 * path uses, so recalcInvoiceState, the hub payout date, the appointment
 * closing and the invoice.paid message all follow without being re-implemented.
 *
 * ── The plan is made HERE, not accepted from outside ────────────────────────
 *
 * With `allocations` null the planner runs inside this transaction, after the
 * invoices are locked. Whatever the browser was showing is irrelevant by then.
 * That is the whole defence against a preview going stale: there is no window
 * between deciding and doing, because they are the same moment.
 *
 * With `allocations` given, a human overrode the split and it is honoured — but
 * every line is checked against what that invoice owes right now, and a line
 * that no longer fits fails the request by name. Silently shrinking somebody's
 * deliberate ₹4,000 to ₹1,200 because another advisor got there first is the
 * one outcome worse than an error.
 *
 * ── Credit first, then the new money ────────────────────────────────────────
 *
 * When useCredit is on, the customer's FREE credit (never a held deposit) is
 * consumed before this payment is touched, oldest receipt first. That ordering
 * is not cosmetic: it drains old part-used receipts instead of leaving a trail
 * of them, which is the same rule applyCustomerCredit already follows.
 *
 * @returns {Promise<{payment: object, allocations: Array, leftover: number,
 *                    credit_used: number, settled: number[]}>}
 */
async function receivePayment({
  mobile,
  amount,
  method = 'cash',
  referenceNo = null,
  vehicleNumber = null,
  notes = null,
  hubId = null,
  useCredit = false,
  allocations = null,
  excludeInvoiceIds = null,
  userId = null,
}) {
  const who = String(mobile || '').trim();
  if (!who) throw fail(400, 'A customer is needed.');
  const amt = r2(amount);
  if (!(amt > 0)) throw fail(400, 'The amount must be more than zero.');
  if (!MANUAL_METHODS.includes(method)) throw fail(400, `Unknown payment method "${method}".`);

  let out = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The customer must exist as an identity, or the money is attached to a
    // number no screen resolves to a person. Idempotent, and the same call
    // createAccountCredit makes for the same reason.
    await ensureCustomerIdentity(client, who);

    // Lock every invoice this could touch BEFORE planning, and in id order.
    // Two advisors receiving money for the same customer at the same moment
    // take these locks in the same sequence, so they queue instead of
    // deadlocking — and the second one plans against what the first left.
    await client.query(
      `SELECT ci.id FROM customer_invoices ci
        WHERE ci.mobile = $1 AND ci.status <> 'cancelled'
        ORDER BY ci.id
          FOR UPDATE`,
      [who]
    );

    // ── Spend existing free credit first ────────────────────────────────────
    //
    // Done before the new payment exists, so this money cannot draw on itself.
    let creditUsed = 0;
    const creditApplied = [];
    if (useCredit) {
      const plan0 = await planAllocation(client, {
        mobile: who, amount: 0, hubId, useCredit: true, excludeInvoiceIds,
        overrides: allocations
          ? Object.fromEntries(allocations.map(a => [a.customer_invoice_id, a.amount]))
          : null,
        onlyInvoiceIds: allocations ? allocations.map(a => a.customer_invoice_id) : null,
      });

      for (const line of plan0.lines) {
        if (line.take <= PAISE) continue;
        const got = await applyFreeCreditTo(client, {
          mobile: who, customerInvoiceId: line.customer_invoice_id,
          limit: line.take, userId,
        });
        if (got > 0) {
          creditUsed = r2(creditUsed + got);
          creditApplied.push({ customer_invoice_id: line.customer_invoice_id, amount: got });
        }
      }
    }

    // ── Decide where it goes, now, under the locks ──────────────────────────
    //
    // BEFORE the payment row is written, not after, and that ordering is not
    // cosmetic — see the GST note below.
    const plan = await planAllocation(client, {
      mobile: who,
      amount: amt,
      hubId,
      excludeInvoiceIds,
      useCredit: false,                  // credit is already spent, above
      overrides: allocations
        ? Object.fromEntries(allocations.map(a => [a.customer_invoice_id, a.amount]))
        : null,
      onlyInvoiceIds: allocations ? allocations.map(a => a.customer_invoice_id) : null,
    });

    // An explicit override that no longer fits is an error, not a silent trim.
    if (allocations) {
      for (const want of allocations) {
        const line = plan.lines.find(l => l.customer_invoice_id === Number(want.customer_invoice_id));
        if (!line) {
          throw fail(409,
            `Invoice #${want.customer_invoice_id} is no longer open, so the ₹${r2(want.amount)} `
            + `you set against it cannot be applied. Check the amounts and try again.`);
        }
        if (r2(want.amount) - line.take > PAISE) {
          throw fail(409,
            `Invoice #${want.customer_invoice_id} only has ₹${line.due} outstanding now — somebody `
            + `else may have just paid it — so the ₹${r2(want.amount)} you set against it does not `
            + `fit. Nothing has been saved. Check the amounts and try again.`);
        }
      }
    }

    // ── Record the money ────────────────────────────────────────────────────
    //
    // payment_type 'advance' with no invoice on the row, exactly as
    // createAccountCredit writes it: at this instant the money has arrived and
    // has not been applied to anything. The allocations below are what tie it
    // to invoices, and a payment that ties to none of them is credit — which is
    // the same row shape, not a special case.
    //
    // ── THE GST RATE IS ASKED FOR ONLY IF SOME OF THIS BECOMES CREDIT ───────
    //
    // accountCreditRate THROWS when nobody has set the rate — deliberately, so
    // money cannot be taken before a job exists without the tax question having
    // been answered. Calling it unconditionally here made that refusal apply to
    // every payment through this endpoint, including a plain settlement of an
    // invoice that already carries its own GST. On any installation where the
    // rate is unset — which is most of them, since there is still no Settings
    // screen for it — the whole dialog would have failed with a message about
    // a feature the user was not using.
    //
    // So the question is asked only about the part that actually needs it: what
    // is left over after the invoices have taken theirs. For the allocated
    // part the tax document is the invoice, and there is nothing to work out.
    const plannedAllocation = r2(plan.lines.reduce((s, l) => s + Math.min(l.take, amt), 0));
    const plannedLeftover   = r2(Math.max(0, amt - plannedAllocation));

    let rate = null, gst = null, voucher = { voucher_no: null, voucher_fy: null, voucher_seq: null };
    if (plannedLeftover > PAISE) {
      rate = await accountCreditRate(client);
      gst  = inclusiveGst(plannedLeftover, rate);
      // The ADV- series means "money received before a tax invoice covers it".
      // A payment that lands entirely on invoices is not that, and numbering it
      // into the series would change what the series means to an accountant —
      // so a fully-allocated payment gets no receipt number, exactly as one
      // recorded through the invoice screen does not.
      voucher = await issueVoucherNumber(client, { hubId: null });
    }

    const ins = await client.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes, created_by,
          source, payment_type, estimate_id, mobile, vehicle_number,
          voucher_no, voucher_fy, voucher_seq, public_token, gst_amount, gst_rate, hub_id)
       VALUES (NULL,$1,$2,$3,NOW(),$4,$5,'manual','advance',NULL,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [amt, method, referenceNo, notes, userId, who, vehicleNumber,
       voucher.voucher_no, voucher.voucher_fy, voucher.voucher_seq, generatePublicToken(),
       gst, rate, hubId]
    );
    const payment = ins.rows[0];

    const applied = [];
    for (const line of plan.lines) {
      if (line.take <= PAISE) continue;
      const r = await allocate(client, {
        ledgerPaymentId: payment.id,
        customerInvoiceId: line.customer_invoice_id,
        amount: line.take,
        userId,
      });
      applied.push({ customer_invoice_id: line.customer_invoice_id, amount: r.applied });
    }

    await client.query('COMMIT');

    const allocatedNew = r2(applied.reduce((s, a) => s + a.amount, 0));
    const leftover = r2(amt - allocatedNew);
    console.log(
      `[receive] ${voucher.voucher_no || '(no receipt — fully allocated)'} — ₹${amt} from ${who}: `
      + `₹${allocatedNew} to ${applied.length} invoice(s)`
      + (creditUsed ? `, ₹${creditUsed} of credit used` : '')
      + (leftover > PAISE ? `, ₹${leftover} kept as credit` : ''));

    out = {
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        method: payment.method,
        voucher_no: payment.voucher_no,
        // null, not 0. Number(null) is 0, and a receipt reading "includes
        // ₹0.00 GST" is a claim about tax; "no GST figure" is the truth for a
        // payment whose tax lives on the invoice it settled.
        gst_amount: payment.gst_amount === null ? null : Number(payment.gst_amount),
        gst_rate:   payment.gst_rate   === null ? null : Number(payment.gst_rate),
        public_token: payment.public_token,
      },
      allocations: applied,
      credit_used: creditUsed,
      credit_applied: creditApplied,
      leftover,
      settled: plan.lines.filter(l => l.settles).map(l => l.customer_invoice_id),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After the release, for the reason every other capture path does it: the
  // receipt is a consequence of the money being recorded, never a condition of
  // it, and it must not hold a pooled connection while it talks to a provider.
  //
  // Only when a receipt actually exists. A payment that went entirely onto
  // invoices has no ADV- number, and messaging a customer a receipt with a
  // blank document number is worse than not messaging them at all.
  if (out.payment.voucher_no) await sendReceiptMessage(out.payment.id);
  return out;
}

/**
 * Put up to `limit` of a customer's FREE credit on one invoice, on a
 * transaction somebody else owns.
 *
 * applyCustomerCredit does the same thing but opens and commits its own
 * transaction, which is exactly what receivePayment cannot have: credit moving
 * and the new payment landing must be one atomic act, or a crash between them
 * leaves the customer's credit spent against an invoice and no record of the
 * cash that was handed over at the same moment.
 *
 * Returns what it actually managed to apply, which may be zero.
 */
async function applyFreeCreditTo(client, { mobile, customerInvoiceId, limit, userId = null }) {
  const rows = await client.query(
    `SELECT p.id, ${REMAINING_SQL} AS remaining
       FROM customer_invoice_payments p
      WHERE p.mobile = $1
        AND NOT ${HELD_SQL}
      ORDER BY p.paid_at ASC, p.id ASC
        FOR UPDATE`,
    [mobile]
  );

  let left = r2(limit);
  let used = 0;
  for (const row of rows.rows) {
    if (left <= PAISE) break;
    const avail = r2(row.remaining);
    if (avail <= PAISE) continue;
    const take = r2(Math.min(avail, left));
    const r = await allocate(client, {
      ledgerPaymentId: row.id, customerInvoiceId, amount: take, userId,
    });
    used = r2(used + r.applied);
    left = r2(left - r.applied);
  }
  return used;
}

async function readReceiptVoucher(db, { ledgerPaymentId = null, voucherNo = null, publicToken = null } = {}) {
  const r = await db.query(
    `SELECT p.id, p.amount, p.method, p.reference_no, p.notes,
            p.paid_at, p.created_at, p.voucher_no, p.public_token,
            p.gst_amount, p.gst_rate, p.estimate_id, p.payment_type,
            p.mobile, p.vehicle_number, p.hub_id,
            t.txn_ref,

            -- The job. job_total drives the "still to pay" line; job_advanced
            -- counts every advance on the job UP TO AND INCLUDING this one, so
            -- a reprint of the first receipt still shows what was true when it
            -- was issued rather than silently absorbing a later payment.
            e.grand_total AS job_total,
            (SELECT COALESCE(SUM(p2.amount), 0)
               FROM customer_invoice_payments p2
              WHERE p2.estimate_id = p.estimate_id
                AND p2.payment_type = 'advance'
                AND p2.id <= p.id) AS job_advanced,

            -- The name, and where it comes from when there is no job.
            --
            -- An advance against an estimate takes the name off that estimate.
            -- Money on account has neither an estimate nor an appointment, so
            -- the name is resolved from the customer themselves — the same
            -- precedence the customer list uses, so the receipt and the screen
            -- that opened it never disagree about who this is.
            --
            -- Without this the buyer block on an on-account voucher would be
            -- blank: a numbered tax document naming nobody.
            COALESCE(
              e.customer_name,
              a.customer_name,
              (SELECT NULLIF(TRIM(cp.display_name), '') FROM customer_profiles cp
                WHERE cp.mobile = p.mobile AND NOT COALESCE(cp.is_deleted, FALSE)),
              -- Every column is table-qualified, deliberately. An unqualified
              -- name that the inner table happens not to have does not error —
              -- PostgreSQL looks OUTWARD and binds it to the enclosing query,
              -- so the row picked would silently become "the one whose date
              -- matches this payment's" rather than the earliest. Aliasing each
              -- source makes that impossible rather than unlikely.
              (SELECT n.customer_name FROM (
                 SELECT ap.customer_name, ap.created_at FROM appointments ap
                  WHERE ap.mobile = p.mobile AND ap.customer_name IS NOT NULL
                 UNION ALL
                 SELECT es.customer_name, es.created_at FROM estimates es
                  WHERE es.mobile = p.mobile AND es.customer_name IS NOT NULL
                 UNION ALL
                 SELECT ci.customer_name, ci.created_at FROM customer_invoices ci
                  WHERE ci.mobile = p.mobile AND ci.customer_name IS NOT NULL
               ) n ORDER BY n.created_at ASC LIMIT 1)
            ) AS customer_name,
            e.is_b2b, e.b2b_company_name, e.b2b_gst_number, e.b2b_address,
            e.place_of_supply_code,

            vm.name   AS make_name,
            vmod.name AS model_name,
            bt.name   AS body_type_name,
            cc.name   AS cc_category_name,

            ('Spinoto ' || ar.name) AS hub_name,
            h.hub_name              AS hub_full_name,
            h.gst_number            AS hub_gst
       FROM customer_invoice_payments p
       LEFT JOIN payment_transactions t ON t.id = p.payment_transaction_id
       LEFT JOIN estimates      e    ON e.id    = p.estimate_id
       LEFT JOIN appointments   a    ON a.id    = COALESCE(p.appointment_id, e.appointment_id)
       LEFT JOIN hubs           h    ON h.id    = COALESCE(p.hub_id, e.hub_id)
       LEFT JOIN areas          ar   ON ar.id   = h.area_id
       LEFT JOIN vehicle_makes  vm   ON vm.id   = COALESCE(a.make_id, e.make_id)
       LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, e.model_id)
       LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, e.body_type_id)
       LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, e.cc_category_id)
      WHERE p.payment_type = 'advance'
        AND ($1::int IS NULL     OR p.id = $1)
        AND ($2::varchar IS NULL OR p.voucher_no = $2)
        AND ($3::varchar IS NULL OR p.public_token = $3)
      LIMIT 1`,
    [ledgerPaymentId, voucherNo, publicToken]
  );
  const row = r.rows[0];
  if (!row) return null;

  // No number means the money was never captured — a payment link somebody
  // generated and nobody paid. There is no document to print, and printing one
  // would state that money was received.
  if (!row.voucher_no) return null;

  return { ...row, kind: 'receipt' };
}

/**
 * The same, for a refund voucher.
 *
 * Reads through to the advance it reverses, because a refund voucher names the
 * same customer, the same vehicle and the same job as the receipt it answers —
 * and all of that lives on the payment, not on the refund row.
 */
async function readRefundVoucher(db, { refundId = null, publicToken = null } = {}) {
  const r = await db.query(
    `SELECT rf.id, rf.amount, rf.reason AS notes, rf.created_at,
            rf.processed_at, rf.voucher_no, rf.public_token,
            rf.gst_amount, rf.gst_rate, rf.status,

            p.id AS ledger_payment_id, p.method, p.estimate_id,
            p.mobile, p.vehicle_number, p.voucher_no AS against_voucher_no,

            e.grand_total AS job_total,
            COALESCE(e.customer_name, a.customer_name) AS customer_name,
            e.is_b2b, e.b2b_company_name, e.b2b_gst_number, e.b2b_address,
            e.place_of_supply_code,

            vm.name   AS make_name,
            vmod.name AS model_name,
            bt.name   AS body_type_name,
            cc.name   AS cc_category_name,

            ('Spinoto ' || ar.name) AS hub_name,
            h.hub_name              AS hub_full_name,
            h.gst_number            AS hub_gst
       FROM payment_refunds rf
       LEFT JOIN customer_invoice_payments p ON p.id = rf.ledger_payment_id
       LEFT JOIN estimates      e    ON e.id    = p.estimate_id
       LEFT JOIN appointments   a    ON a.id    = COALESCE(p.appointment_id, e.appointment_id)
       LEFT JOIN hubs           h    ON h.id    = COALESCE(rf.hub_id, p.hub_id)
       LEFT JOIN areas          ar   ON ar.id   = h.area_id
       LEFT JOIN vehicle_makes  vm   ON vm.id   = COALESCE(a.make_id, e.make_id)
       LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, e.model_id)
       LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, e.body_type_id)
       LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, e.cc_category_id)
      WHERE ($1::int IS NULL     OR rf.id = $1)
        AND ($2::varchar IS NULL OR rf.public_token = $2)
      LIMIT 1`,
    [refundId, publicToken]
  );
  const row = r.rows[0];
  if (!row) return null;

  // A refund with no number has not been processed. The money has not reached
  // the customer, so there is nothing to hand them a tax document for.
  if (!row.voucher_no) return null;

  return {
    ...row,
    kind: 'refund',
    // Dated when the money went back, not when it was asked for. On a cash
    // refund those are the same instant; on a gateway one they are days apart,
    // and the tax date is the later of the two.
    paid_at: row.processed_at || row.created_at,
    job_advanced: null,
  };
}

/**
 * Stamps a processed refund with its voucher number and public token.
 *
 * IDEMPOTENT, and that is not a nicety: refund.processed can be delivered more
 * than once by the gateway, and a second delivery must not burn a second
 * number. The WHERE clause enforces it — an already-numbered row matches
 * nothing, so the sequence is never touched.
 *
 * Must run inside the transaction that marks the refund processed. Numbering a
 * refund whose transaction then rolls back would leave a hole in a tax series.
 */
async function issueRefundVoucher(client, refundId) {
  const cur = await client.query(
    `SELECT id, voucher_no, processed_at FROM payment_refunds WHERE id = $1 FOR UPDATE`,
    [refundId]
  );
  const rf = cur.rows[0];
  if (!rf) return null;
  if (rf.voucher_no) return rf.voucher_no;   // already numbered — do nothing

  // Company-wide, matching the receipt series (see createManualAdvance and
  // captureAdvance, both of which pass hubId: null). One decision, taken once:
  // a per-hub refund series alongside a company-wide receipt series would be
  // two answers to the same question.
  const voucher = await issueVoucherNumber(client, {
    hubId: null,
    when: rf.processed_at || new Date(),
    prefix: 'ADVR',
    docKind: 'refund',
  });

  const w = await client.query(
    `UPDATE payment_refunds
        SET voucher_no = $2, voucher_fy = $3, voucher_seq = $4,
            public_token = COALESCE(public_token, $5)
      WHERE id = $1 AND voucher_no IS NULL
      RETURNING voucher_no`,
    [refundId, voucher.voucher_no, voucher.voucher_fy, voucher.voucher_seq, generatePublicToken()]
  );
  return w.rows[0]?.voucher_no || null;
}

/**
 * Returns part or all of an advance to the customer.
 *
 * WHAT CAN BE REFUNDED
 * ────────────────────
 * Only the UNALLOCATED part. Money already applied to an invoice is not credit
 * any more — it has paid for something. Refunding it here would leave that
 * invoice reading as paid with money that has gone back; the correct action
 * there is to refund the invoice payment.
 *
 * CASH VERSUS GATEWAY
 * ───────────────────
 * A cash advance is handed back across the counter, so the refund is processed
 * the moment it is recorded and the voucher is numbered immediately.
 *
 * A gateway advance is not ours to reverse directly — the money returns along
 * the rails it arrived on, over several days, and it can still fail. That path
 * writes a PENDING refund with no voucher number; the number is issued by the
 * refund.processed webhook. Handing a customer a numbered tax document for
 * money that never left would be worse than making them wait for it.
 */
async function refundAdvance({ ledgerPaymentId, amount, reason, userId = null }) {
  const asked = Number(amount);
  if (!Number.isFinite(asked) || asked <= 0) throw fail(400, 'Enter a valid amount to refund.');
  if (!reason || String(reason).trim().length < 3) {
    throw fail(400, 'Give a reason for the refund — it is the first thing an audit asks for.');
  }

  let released = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE, so two advisors returning the same credit in the same moment
    // cannot both read it as available.
    const pr = await client.query(
      `SELECT id, amount, payment_type, source, mobile, hub_id,
              payment_transaction_id, voucher_no, gst_amount, gst_rate
         FROM customer_invoice_payments WHERE id = $1 FOR UPDATE`,
      [ledgerPaymentId]
    );
    const pay = pr.rows[0];
    if (!pay) throw fail(404, 'Payment not found');
    if (pay.payment_type !== 'advance') {
      throw fail(409,
        'This is a payment against an invoice, not an advance. Refund it from the invoice, so the invoice balance moves with it.');
    }

    // .remaining — unallocatedOf returns the whole row, not a number. Reading
    // it as a number gives NaN, and every comparison against NaN is false, so
    // every ceiling below would silently pass.
    //
    // It is ALREADY net of refunds, pending ones included (see REMAINING_SQL),
    // so this is the refundable figure directly. Subtracting the refunds again
    // here would count them twice and refuse a legitimate second refund of a
    // part-refunded advance.
    const { remaining: refundable } = await unallocatedOf(client, pay.id);

    if (refundable <= 0.01) {
      // Both cases end here, and they are different situations for the person
      // reading the message: one means the money did a job, the other means
      // they already have it back. Worth the extra query to say which.
      const spent = await client.query(
        `SELECT COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                           WHERE a.ledger_payment_id = $1), 0) AS allocated,
                COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                           WHERE rf.ledger_payment_id = $1
                             AND rf.status IN ('pending', 'processed')), 0) AS refunded`,
        [pay.id]
      );
      throw fail(409, Number(spent.rows[0].refunded) > 0.01
        ? 'This advance has already been refunded.'
        : 'This advance has already been applied to an invoice, so there is no credit left to return.');
    }
    if (asked > refundable + 0.01) {
      throw fail(400, `Only ₹${refundable.toFixed(2)} of this advance can still be refunded.`);
    }

    // The tax being reversed, in the SAME proportion the advance was taken at.
    // Read off the payment's own snapshot rather than recomputed from the
    // estimate, which may have been edited since: the receipt the customer
    // holds states one figure, and the refund has to reverse that one.
    const paidAmt = Number(pay.amount);
    const fullGst = Number(pay.gst_amount || 0);
    const rate = Number(pay.gst_rate || 0);
    const gstBack = paidAmt > 0 ? Number((fullGst * (asked / paidAmt)).toFixed(2)) : 0;

    const isCash = pay.source !== 'gateway';

    // ── ONLINE MONEY IS NOT OURS TO SEND BACK BY WRITING A ROW ──────────────
    //
    // A cash refund is complete when it is recorded: the notes are in the
    // customer's hand. Online money has to be asked back along the rails it
    // arrived on, and that ask is an HTTP call to the gateway.
    //
    // This branch used to write a 'pending' row and stop. The record was
    // perfect and the money never moved — the row sat pending for ever, no
    // webhook ever arrived, no voucher was ever issued, and the screen told
    // the customer their refund was on its way. Recording a refund is not
    // making one.
    //
    // requestRefund owns that call, and everything around it that is easy to
    // get wrong: the pending row written BEFORE the gateway call so a timeout
    // cannot lose track of money already leaving, the failure path that marks
    // the row rather than throwing it away, and the instant-settlement case
    // where the gateway reports 'processed' on the spot. Duplicating any of
    // that here would be a second implementation of the hardest part of this
    // module.
    //
    // The transaction is COMMITTED first. A network round-trip must never be
    // made while holding a row lock — the estimate's advances would be frozen
    // for as long as the gateway took to answer.
    if (!isCash) {
      if (!pay.payment_transaction_id) {
        throw fail(409,
          'This advance was taken online but has no gateway transaction on record, so it cannot be '
          + 'refunded automatically. Refund it from the Razorpay dashboard — the webhook will close it out here.');
      }
      // ── RESERVE THE MONEY BEFORE LETTING GO OF THE LOCK ──────────────────
      //
      // The FOR UPDATE above is documented as stopping two advisors returning
      // the same credit at the same moment. It did not, because nothing another
      // transaction could observe was written before the lock was dropped:
      // COMMIT released it, and the pending refund row only appeared several
      // statements later, inside requestRefund. In that gap `remaining` still
      // read as fully available, so the same ₹500 could be refunded twice, or
      // refunded and allocated to an invoice.
      //
      // The row goes in HERE, under the lock. REMAINING_SQL subtracts refunds
      // with status 'pending', so from the moment this commits the credit is
      // unspendable — which is exactly what "this money is on its way back to
      // the customer" should mean.
      //
      // ledger_payment_id and the GST snapshot are written now for the reason
      // requestRefund's own comment gives: an instantly-settled refund runs
      // applyRefundOutcome inside the call below, and that is what decides
      // whether a numbered refund voucher is issued.
      const reserve = await client.query(
        `INSERT INTO payment_refunds
           (payment_transaction_id, ledger_payment_id, customer_invoice_id, hub_id,
            amount, reason, status, requested_by, gst_amount, gst_rate)
         VALUES ($1, $2, NULL, $3, $4, $5, 'pending', $6, $7, $8)
         RETURNING id`,
        [pay.payment_transaction_id, pay.id, pay.hub_id || null,
         Number(asked.toFixed(2)), String(reason).trim(), userId, gstBack, rate]);
      const reservedId = reserve.rows[0].id;

      await client.query('COMMIT');
      client.release();
      released = true;

      const { requestRefund } = require('./refunds.service');
      let refund;
      try {
        refund = await requestRefund({
          txnId: pay.payment_transaction_id,
          amount: Number(asked.toFixed(2)),
          reason: String(reason).trim(),
          userId,
          ledgerPaymentId: pay.id,
          gstAmount: gstBack,
          gstRate: rate,
          // Adopt the row reserved above rather than inserting a second one.
          existingRefundId: reservedId,
        });
      } catch (err) {
        // The reservation must not outlive a refund that never started, or the
        // credit stays frozen for ever with nothing to explain why. Marked
        // rather than deleted: an attempt that failed is worth a row.
        await pool.query(
          `UPDATE payment_refunds
              SET status = 'failed', error_description = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [reservedId, String(err.message || err).slice(0, 2000)]).catch(() => {});
        throw err;
      }

      return {
        ...refund,
        gst_amount: gstBack,
        gst_rate: rate,
        // A gateway that settles instantly comes back already processed and
        // already numbered; anything else is genuinely still in flight.
        pending: refund.status !== 'processed',
        against_voucher_no: pay.voucher_no || null,
      };
    }

    const ins = await client.query(
      `INSERT INTO payment_refunds
         (payment_transaction_id, ledger_payment_id, customer_invoice_id, hub_id,
          amount, reason, status, requested_by, processed_at, gst_amount, gst_rate)
       VALUES ($1, $2, NULL, $3, $4, $5, 'processed', $6, NOW(), $7, $8)
       RETURNING id, amount, status, created_at, processed_at`,
      [
        pay.payment_transaction_id || null, pay.id, pay.hub_id || null,
        Number(asked.toFixed(2)), String(reason).trim(),
        userId, gstBack, rate,
      ]
    );
    const refund = ins.rows[0];

    // Cash is back in the customer's hand, so the voucher is earned now.
    const voucherNo = await issueRefundVoucher(client, refund.id);

    await client.query('COMMIT');
    return {
      ...refund,
      voucher_no: voucherNo,
      gst_amount: gstBack,
      gst_rate: rate,
      pending: false,
      against_voucher_no: pay.voucher_no || null,
    };
  } catch (err) {
    // Only if we still hold the transaction. Past the gateway hand-off there is
    // nothing of ours left to roll back — requestRefund owns its own writes and
    // marks its row 'failed' rather than discarding it, because a gateway call
    // that failed after being accepted must stay visible.
    if (!released) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // The gateway path releases early — it must not hold a connection across a
    // network call — and returns from inside the try. A second release() on the
    // same pg client throws, so the flag is what keeps the two exits apart.
    if (!released) client.release();
  }
}

module.exports = {
  // Exported so payments.controller's Unallocated list uses the SAME
  // arithmetic instead of becoming a fifth copy that forgets the refunds term.
  REMAINING_SQL,
  createManualAdvance,
  createAccountCredit,
  accountCreditRate,
  inclusiveGst,
  createAdvanceLink,
  captureAdvance,
  allocate,
  autoApplyForInvoice,
  applyCustomerCredit,
  unallocatedOf,
  creditFor,
  creditBreakdown,
  planAllocation,
  receivePayment,
  PAISE,
  issueVoucherNumber,
  financialYear,
  readEstimateForAdvance,
  resolveAdvance,
  readReceiptVoucher,
  readRefundVoucher,
  issueRefundVoucher,
  refundAdvance,
};
