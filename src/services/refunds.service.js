'use strict';

/**
 * Refunds.
 *
 * THE RULE: A PAYMENT ROW IS NEVER EDITED
 * ───────────────────────────────────────
 * The obvious implementation of "refund ₹500 of a ₹2000 payment" is to change
 * the payment to ₹1500. Everything here exists to avoid that.
 *
 * The customer paid ₹2000. It happened, their bank statement says so, and the
 * gateway settlement report says so. A ledger that later reads ₹1500 cannot be
 * reconciled against either, and it silently moves revenue between GST periods
 * — the tax invoice was issued for the full amount and a refund is a separate
 * credit event with its own date.
 *
 * So refunds are their own rows, and the invoice's amount_paid is DERIVED:
 *
 *     amount_paid = SUM(payments) − SUM(refunds WHERE status = 'processed')
 *
 * That subtraction lives in services/invoiceBalance.service.js, which every
 * path already calls. Nothing here writes amount_paid itself.
 *
 * THE MONEY MOVES LATER THAN THE REQUEST
 * ──────────────────────────────────────
 * Asking for a refund is not a refund. The gateway accepts the request
 * immediately and the money reaches the customer over the following days, and
 * it can still fail. So:
 *
 *   requestRefund()      → writes a 'pending' row. The invoice does NOT move.
 *   applyRefundOutcome() → called by the refund.processed / refund.failed
 *                          webhook. THIS is where the invoice balance changes.
 *
 * Reducing the balance at request time would show an outstanding amount for
 * money the customer has not received, and leave nothing to correct it with
 * when the refund fails. It is the same rule as the way in: the invoice only
 * changes on what the gateway confirms, never on an intention.
 */

const { pool } = require('../config/db');
const { getGateway } = require('./gateway');
const { scrubRaw } = require('./gateway/types');
const { recalcInvoiceState } = require('./invoiceBalance.service');

function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/**
 * How much of a captured payment is still refundable.
 *
 * Counts pending refunds as well as processed ones. A pending refund is money
 * already promised to the customer — ignoring it lets two requests in quick
 * succession refund the same rupees twice, and the second one only bounces at
 * the gateway if we are lucky.
 */
async function refundableAmount(db, txnId) {
  const r = await db.query(
    `SELECT t.amount, t.status,
            (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
              WHERE rf.payment_transaction_id = t.id
                AND rf.status IN ('pending','processed')) AS committed
       FROM payment_transactions t
      WHERE t.id = $1`,
    [txnId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    captured: Number(row.amount),
    committed: Number(row.committed),
    refundable: Number((Number(row.amount) - Number(row.committed)).toFixed(2)),
  };
}

/**
 * Requests a refund against a captured payment.
 *
 * Authorisation is the caller's job (routes + an explicit hub rejection) — this
 * function assumes the decision has been made and enforces only the money
 * rules, which are the ones a UI cannot be trusted with.
 */
async function requestRefund({
  txnId, amount, reason, userId,
  // ── Set ONLY when the money being reversed is an advance ─────────────────
  // They are written on the INSERT below, before the gateway call, and that
  // ordering is the point. A gateway can settle a small refund instantly and
  // report 'processed' on the spot, which makes applyRefundOutcome run inside
  // this function — and that is what issues the refund voucher. Stamping these
  // afterwards would mean the voucher decision was taken while the row still
  // looked like an ordinary invoice refund, so no voucher would be issued and
  // the customer would get their money with no tax document.
  ledgerPaymentId = null, gstAmount = null, gstRate = null,
  // ── A pending row this function did NOT create ───────────────────────────
  // refundAdvance reserves the money by inserting the pending row itself, INSIDE
  // the lock it holds on the ledger row, and then hands the id here. That is the
  // only way the reservation is visible to a concurrent reader before the lock
  // is released — REMAINING_SQL subtracts refunds with status 'pending', so an
  // existing row is what makes the credit unspendable while it is on its way
  // back to the customer.
  //
  // When set, the ceiling check is skipped: it was already made under the lock,
  // against the advance's UNALLOCATED remainder, which is a tighter and more
  // correct bound than refundableAmount's whole-payment one.
  existingRefundId = null,
}) {
  const t = await pool.query(`SELECT * FROM payment_transactions WHERE id = $1`, [txnId]);
  const txn = t.rows[0];
  if (!txn) throw fail(404, 'Payment not found');

  if (!['captured', 'partially_refunded'].includes(txn.status)) {
    // Refunding something never captured would send money we never received.
    throw fail(409, `Only a captured payment can be refunded. This one is ${txn.status}.`);
  }
  if (!reason || !String(reason).trim()) {
    // NOT NULL in the schema too. A refund with no stated reason is the one an
    // audit asks about, and "the person who did it has left" is not an answer.
    throw fail(400, 'A reason is required for every refund.');
  }

  const asked = Number(amount);
  if (!Number.isFinite(asked) || asked <= 0) {
    throw fail(400, 'Enter a valid refund amount.');
  }
  if (!existingRefundId) {
    const avail = await refundableAmount(pool, txnId);
    if (asked > avail.refundable + 0.001) {
      throw fail(409,
        `Only ₹${avail.refundable.toFixed(2)} of this ₹${avail.captured.toFixed(2)} payment can still be refunded.`);
    }
  }

  const gateway = getGateway();

  // The pending row is written BEFORE the gateway call, not after.
  //
  // If it were written after, a call that times out after the gateway accepted
  // it leaves money on its way to the customer with no record here — and the
  // refund.processed webhook arrives with a gateway_refund_id matching nothing.
  // Written first, the worst case is a pending row for a refund that never
  // started, which is visible and correctable. Losing track of money leaving
  // the account is not.
  let refund;
  if (existingRefundId) {
    // Reserved by the caller under a row lock. Re-read rather than trusted, so
    // this function still works from the row rather than from its arguments.
    const ex = await pool.query(
      `SELECT * FROM payment_refunds WHERE id = $1 AND status = 'pending'`, [existingRefundId]);
    if (!ex.rows[0]) throw fail(409, 'That refund is no longer pending.');
    refund = ex.rows[0];
  } else {
    const ins = await pool.query(
      `INSERT INTO payment_refunds
         (payment_transaction_id, customer_invoice_id, hub_id, amount, reason, status, requested_by,
          ledger_payment_id, gst_amount, gst_rate)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)
       RETURNING *`,
      [txn.id,
       txn.entity_type === 'customer_invoice' ? txn.entity_id : null,
       txn.hub_id, Number(asked.toFixed(2)), String(reason).trim(), userId || null,
       ledgerPaymentId, gstAmount, gstRate]
    );
    refund = ins.rows[0];
  }

  let result;
  try {
    result = await gateway.createRefund({
      paymentId: txn.gateway_payment_id,
      amount: Number(asked.toFixed(2)),
      notes: { refund_id: String(refund.id), txn_ref: txn.txn_ref },
    });
  } catch (err) {
    await pool.query(
      `UPDATE payment_refunds
          SET status='failed', error_description=$2, updated_at=NOW() WHERE id=$1`,
      [refund.id, String(err.message || err).slice(0, 2000)]);
    throw err;
  }

  await pool.query(
    `UPDATE payment_refunds
        SET gateway_refund_id=$2, raw_response=$3::jsonb, updated_at=NOW()
      WHERE id=$1`,
    [refund.id, result.id || null, result.raw ? JSON.stringify(scrubRaw(result.raw)) : null]);

  // Some gateways settle small refunds instantly and report 'processed' on the
  // spot. Honour that rather than waiting for a webhook that already fired.
  if (result.status === 'processed') {
    await applyRefundOutcomeOuter({
      gatewayRefundId: result.id,
      gatewayPaymentId: txn.gateway_payment_id,
      amount: Number(asked.toFixed(2)),
      outcome: 'processed',
      raw: result.raw,
    });
  }

  const fresh = await pool.query(`SELECT * FROM payment_refunds WHERE id = $1`, [refund.id]);
  return fresh.rows[0];
}

/**
 * Applies a refund result. Called by the webhook, and directly when the gateway
 * reports an instant settlement.
 *
 * Idempotent by the same three-deep pattern as a capture: a row lock, an
 * explicit already-final check, and a unique index on gateway_refund_id
 * underneath both. A redelivered refund.processed must not reduce the invoice
 * twice.
 */
async function _applyRefundOutcomeLocked({ gatewayRefundId, gatewayPaymentId, amount, outcome, raw = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Match on the gateway's refund id first. Fall back to the oldest pending
    // refund for that payment: an instant-settlement path can report the
    // outcome before we have stored the id.
    let r = await client.query(
      `SELECT * FROM payment_refunds WHERE gateway_refund_id = $1 FOR UPDATE`, [gatewayRefundId]);
    // ── THE FALLBACK MUST MATCH ON THE AMOUNT, AND TAKE THE NEWEST ──────────
    //
    // This used to take the OLDEST pending refund for the payment and ignore the
    // amount entirely. The window it fires in is created by requestRefund
    // itself: it writes the pending row, calls the gateway, and only stores
    // gateway_refund_id afterwards. So an instantly-settled second refund could
    // arrive while its own id was unstored and get matched to a FIRST refund
    // that was still genuinely in flight.
    //
    // What followed was the bad part. The first refund's row was stamped with
    // the second one's outcome and id; when its own webhook arrived it matched
    // by id, saw a non-pending status, and returned duplicate:true — so
    // recalcInvoiceState never ran and ₹500 left the bank with the invoice still
    // reading PAID. It also left two rows racing for one gateway_refund_id,
    // whose unique index then raised an unhandled 23505 as a 500.
    //
    // Amount-matched and newest-first: the row this outcome can actually belong
    // to is one requested moments ago for this exact figure. A refund whose id
    // we already stored never reaches here at all — the first SELECT found it.
    if (!r.rows[0] && gatewayPaymentId) {
      r = await client.query(
        `SELECT rf.* FROM payment_refunds rf
           JOIN payment_transactions t ON t.id = rf.payment_transaction_id
          WHERE t.gateway_payment_id = $1
            AND rf.status = 'pending'
            AND rf.gateway_refund_id IS NULL
            AND ($2::numeric IS NULL OR ABS(rf.amount - $2::numeric) < 0.011)
          ORDER BY rf.id DESC LIMIT 1
            FOR UPDATE OF rf`,
        [gatewayPaymentId, amount == null ? null : Number(amount)]);
    }
    const refund = r.rows[0];
    if (!refund) {
      // A refund issued from the gateway's own dashboard, with no request from
      // this system. Recorded rather than dropped, so the invoice still comes
      // down and the accounts still reconcile.
      //
      // ── DEFERRED UNTIL THIS CLIENT IS RELEASED ──────────────────────────
      // recordExternalRefund takes a pool client of its own. Calling it here
      // with `return await` kept THIS client checked out until it finished, so
      // every such request held two connections at once. The pool is max 10 with
      // no connectionTimeoutMillis, so ten dashboard-issued refunds arriving
      // together — one accountant's afternoon — each grabbed one client and then
      // waited for an eleventh that could never exist. The pool deadlocked
      // permanently, and because there is no acquire timeout it did so silently:
      // every request in the process hung, with no error and nothing in the log.
      //
      // The flag defers the call to after the `finally` below has released.
      // advances.service.js already documents this exact rule ("AFTER the
      // connection is released, not just after the COMMIT").
      // null is the signal to the outer wrapper. Not a thrown error and not a
      // direct call: both would keep this client checked out.
      await client.query('COMMIT');
      return null;
    }

    if (refund.status !== 'pending') {
      await client.query('COMMIT');
      return { refund, duplicate: true };
    }

    await client.query(
      `UPDATE payment_refunds
          SET status=$2,
              gateway_refund_id = COALESCE(gateway_refund_id, $3),
              raw_response = COALESCE($4::jsonb, raw_response),
              processed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [refund.id, outcome, gatewayRefundId || null, raw ? JSON.stringify(scrubRaw(raw)) : null]);

    let state = null;
    if (outcome === 'processed') {
      // The transaction's own status, so a list can show "refunded" without
      // summing on every row.
      await client.query(
        `UPDATE payment_transactions t
            SET status = CASE
                  WHEN (SELECT COALESCE(SUM(rf.amount),0) FROM payment_refunds rf
                         WHERE rf.payment_transaction_id = t.id AND rf.status='processed')
                       >= t.amount - 0.011 THEN 'refunded'
                  ELSE 'partially_refunded' END,
                updated_at = NOW()
          WHERE t.id = $1`,
        [refund.payment_transaction_id]);

      // And the invoice. This is the only place a refund touches the balance,
      // and it does it by recomputing — never by editing a payment row.
      if (refund.customer_invoice_id) {
        state = await recalcInvoiceState(client, refund.customer_invoice_id);
      }

      // An advance being returned needs its own numbered tax document, and THIS
      // is the moment it earns one: the money has actually gone back.
      //
      // Numbering it at request time would leave a hole in the series every
      // time a refund failed. Required inline so the two services do not have
      // to require each other at load time. issueRefundVoucher is idempotent,
      // so a webhook delivered twice does not burn a second number.
      if (refund.ledger_payment_id) {
        const isAdv = await client.query(
          `SELECT 1 FROM customer_invoice_payments
            WHERE id = $1 AND payment_type = 'advance'`,
          [refund.ledger_payment_id]);
        if (isAdv.rows[0]) {
          const { issueRefundVoucher } = require('./advances.service');
          await issueRefundVoucher(client, refund.id);
        }
      }
    }

    await client.query('COMMIT');
    console.log(`[refunds] ${outcome} refund ${refund.id} of ₹${refund.amount}`
      + (state ? ` — invoice ${refund.customer_invoice_id} is now ${state.status}` : ''));
    return { refund, duplicate: false, invoice_status: state?.status || null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The outer half of applyRefundOutcome.
 *
 * Exists purely so the external-refund path runs with NO pool client held. The
 * inner function returns null and sets its flag; the connection goes back to the
 * pool as its `finally` unwinds; only then does recordExternalRefund ask for one
 * of its own. One connection per request at every moment, which is what makes a
 * burst of these survivable.
 */
async function applyRefundOutcomeOuter(args) {
  const inner = await _applyRefundOutcomeLocked(args);
  if (inner !== null) return inner;
  return await recordExternalRefund(args);
}

/**
 * A refund that happened outside this system — someone used the gateway's own
 * dashboard.
 *
 * Recorded rather than ignored. The money has left the company account either
 * way; an invoice that still says PAID for it is a reconciliation failure that
 * surfaces weeks later, in the accounts, with no explanation attached.
 */
async function recordExternalRefund({ gatewayRefundId, gatewayPaymentId, amount, raw }) {
  if (!gatewayPaymentId || !amount) return { skipped: true };

  const t = await pool.query(
    `SELECT * FROM payment_transactions WHERE gateway_payment_id = $1`, [gatewayPaymentId]);
  const txn = t.rows[0];
  if (!txn) return { skipped: true };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO payment_refunds
         (payment_transaction_id, customer_invoice_id, hub_id, amount, reason, status,
          gateway_refund_id, raw_response, processed_at)
       VALUES ($1,$2,$3,$4,$5,'processed',$6,$7::jsonb,NOW())
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [txn.id,
       txn.entity_type === 'customer_invoice' ? txn.entity_id : null,
       txn.hub_id, amount,
       'Refunded directly in the payment gateway dashboard (not requested from the CRM)',
       gatewayRefundId || null, raw ? JSON.stringify(scrubRaw(raw)) : null]);

    if (ins.rowCount === 0) { await client.query('COMMIT'); return { duplicate: true }; }

    await client.query(
      `UPDATE payment_transactions t
          SET status = CASE
                WHEN (SELECT COALESCE(SUM(rf.amount),0) FROM payment_refunds rf
                       WHERE rf.payment_transaction_id = t.id AND rf.status='processed')
                     >= t.amount - 0.011 THEN 'refunded'
                ELSE 'partially_refunded' END,
              updated_at = NOW()
        WHERE t.id = $1`, [txn.id]);

    let state = null;
    if (txn.entity_type === 'customer_invoice') {
      state = await recalcInvoiceState(client, txn.entity_id);
    }
    await client.query('COMMIT');
    console.warn(`[refunds] recorded an EXTERNAL refund of ₹${amount} on ${gatewayPaymentId}`);
    return { refund: ins.rows[0], external: true, invoice_status: state?.status || null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  requestRefund,
  // The wrapper, not the locked inner function — callers must never reach a
  // version that can hold two pool connections at once.
  applyRefundOutcome: applyRefundOutcomeOuter,
  refundableAmount,
  recordExternalRefund,
};
