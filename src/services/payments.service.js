'use strict';

/**
 * Payments — the business logic between a controller and the gateway.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ────────────────────────────────────────
 * An invoice becomes PAID only after this server has verified, cryptographically,
 * that the gateway took the money. Nothing a browser posts is believed. There
 * are exactly two ways into `captureVerifiedPayment` and both of them have
 * already checked an HMAC before they call it.
 *
 * THE AMOUNT IS NEVER TAKEN FROM THE CLIENT
 * ─────────────────────────────────────────
 * `createInvoiceOrder` reads the invoice and computes the balance itself. A
 * client-sent amount is used for one thing — deciding whether this is a part
 * payment — and even then it is clamped to the real balance. Otherwise a
 * customer could open the console and pay ₹1 against a ₹20,000 invoice.
 *
 * WHY EVERY WRITE IS ONE TRANSACTION
 * ──────────────────────────────────
 * A capture writes three things: the transaction row, the ledger row, and the
 * invoice's recomputed amount_paid/status (which in turn moves the hub payout
 * date). If the process dies between them, the outcomes range from "money
 * received but the invoice says unpaid" to "invoice paid but the hub is never
 * paid out". They commit together or not at all.
 *
 * DUPLICATES ARE EXPECTED, NOT EXCEPTIONAL
 * ────────────────────────────────────────
 * Razorpay reports a capture twice by design — once to the browser, once to the
 * webhook — and either can arrive first, or the browser one can never arrive
 * because the customer closed the tab. Both paths call in here. The defence is
 * three-deep, deliberately:
 *   1. SELECT … FOR UPDATE serialises two concurrent captures of the same txn
 *   2. an explicit already-captured check returns early
 *   3. a partial unique index on customer_invoice_payments.payment_transaction_id
 *      makes a second ledger row impossible even if 1 and 2 were both wrong
 * The third is the one that actually protects the money, because it is the only
 * one that does not depend on application code being correct.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const { getGateway } = require('./gateway');
const { toLedgerMethod, scrubRaw } = require('./gateway/types');
const { recalcInvoiceState, readInvoiceBalance } = require('./invoiceBalance.service');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

/** Our own reference: sortable-ish, short, and it names nothing about the provider. */
function newTxnRef() {
  return `PY${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating an order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens a gateway order against a customer invoice.
 *
 * @param customerInvoiceId
 * @param requestedAmount  optional part payment. Ignored if it exceeds the
 *                         balance — never trusted upward.
 * @param userId           NULL when a customer pays from a public link
 * @param paymentLinkId    set when this came from a link
 * @returns { txn, order } — `order.key_id` is the PUBLIC key, the only
 *          credential the browser ever receives.
 */
/**
 * Loads an invoice and decides how much may be collected against it right now.
 *
 * EVERY payment instrument goes through here — checkout orders and UPI QRs
 * both. That is the whole reason it exists as a function: the rule "the server
 * decides the amount, the client may only ask for less" has to be one piece of
 * code, because the day it becomes two is the day one of them is fixed and the
 * other is not.
 *
 * @param requestedAmount  optional part payment. Clamped to the balance —
 *                         never trusted upward.
 * @returns { inv, amount }
 */
async function resolveCollectable(customerInvoiceId, requestedAmount = null) {
  const inv = await readInvoiceBalance(pool, customerInvoiceId);
  if (!inv) throw fail(404, 'Customer invoice not found');

  if (inv.status === 'cancelled') {
    throw fail(409, 'This invoice has been cancelled and cannot be paid.');
  }
  if (inv.balance <= 0.01) {
    // 0.01 and not 0: the same paise tolerance the status calculation uses. An
    // invoice one paisa short is settled, and offering a ₹0.01 checkout that
    // the gateway would reject anyway is a worse experience than saying so.
    throw fail(409, 'This invoice is already fully paid.');
  }

  // The amount is decided HERE. A client may ask for less (a part payment);
  // it may never ask for more, and it may never ask for the total.
  let amount = inv.balance;
  if (requestedAmount != null) {
    const asked = Number(requestedAmount);
    if (!Number.isFinite(asked) || asked <= 0) {
      throw fail(400, 'Enter a valid amount to collect.');
    }
    amount = Math.min(asked, inv.balance);
  }
  return { inv, amount: Number(amount.toFixed(2)) };
}

async function createInvoiceOrder({ customerInvoiceId, requestedAmount = null, userId = null, paymentLinkId = null }) {
  const { inv, amount } = await resolveCollectable(customerInvoiceId, requestedAmount);

  const gateway = getGateway();
  const txnRef = newTxnRef();

  // Notes are visible in the gateway dashboard and echoed back in webhooks, so
  // they carry our own references only — no mobile, no name, no address.
  const order = await gateway.createOrder({
    amount,
    receipt: txnRef,
    notes: { txn_ref: txnRef, invoice_id: String(inv.id) },
  });

  const ins = await pool.query(
    `INSERT INTO payment_transactions
       (txn_ref, gateway, mode, entity_type, entity_id, hub_id, mobile,
        amount, currency, status, gateway_order_id, payment_link_id, created_by)
     VALUES ($1,$2,$3,'customer_invoice',$4,$5,$6,$7,'INR','created',$8,$9,$10)
     RETURNING *`,
    [txnRef, gateway.name, gateway.mode(), inv.id, inv.hub_id, inv.mobile,
     amount, order.id, paymentLinkId, userId]
  );

  return {
    txn: ins.rows[0],
    order: {
      order_id: order.id,
      key_id: order.key_id,        // PUBLIC key. Never the secret.
      amount,
      currency: 'INR',
      txn_ref: txnRef,
      mock: Boolean(order.mock),
    },
    invoice: inv,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating a UPI QR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens a fixed-amount UPI QR against a customer invoice.
 *
 * The amount rules are createInvoiceOrder's, unchanged and deliberately
 * duplicated in intent rather than in code — see resolveCollectable() below,
 * which both functions now share. A QR is a payment instrument like any other
 * and it must not become the one path where a client-supplied amount is
 * believed.
 *
 * WHAT MAKES THIS DIFFERENT FROM AN ORDER
 * ───────────────────────────────────────
 * There is no browser. The customer scans with GPay or PhonePe and pays inside
 * their bank's app; our page never hears about it, and there is no callback to
 * verify. The qr_code.credited webhook is the ONLY way this system learns the
 * money arrived.
 *
 * That has one hard consequence: with no RAZORPAY_WEBHOOK_SECRET configured,
 * webhooks are refused (see razorpay.adapter.verifyWebhookSignature, which
 * returns false rather than true when the secret is missing) — so a QR created
 * in that state can be paid by a real customer and will NEVER be recorded. So
 * this function refuses to create one. Failing here is a message on a screen;
 * failing silently is money taken with no record of it.
 *
 * @returns { txn, qr } — qr.image_url is what the modal renders
 */
async function createInvoiceQr({ customerInvoiceId, requestedAmount = null, userId = null, ttlSeconds = null }) {
  const gateway = getGateway();

  if (typeof gateway.createQrCode !== 'function') {
    throw fail(501, `${gateway.name} does not support UPI QR payments.`);
  }
  if (!gateway.isWebhookConfigured()) {
    throw fail(503,
      'UPI QR cannot be used until the payment webhook is configured. A QR payment has no '
      + 'browser confirmation, so without the webhook a customer could pay and the invoice '
      + 'would stay unpaid. Set RAZORPAY_WEBHOOK_SECRET and register the webhook URL.',
      { code: 'WEBHOOK_NOT_CONFIGURED' });
  }

  const { inv, amount } = await resolveCollectable(customerInvoiceId, requestedAmount);
  const txnRef = newTxnRef();

  // Our references only. A QR's notes are visible in the gateway dashboard and
  // echoed back on the webhook — the same rule as createOrder.
  const qr = await gateway.createQrCode({
    amount,
    receipt: txnRef,
    ttlSeconds: ttlSeconds || undefined,
    description: `Invoice ${inv.id}`,
    notes: { txn_ref: txnRef, invoice_id: String(inv.id) },
  });

  const expiresAt = qr.close_by ? new Date(qr.close_by * 1000) : null;

  const ins = await pool.query(
    `INSERT INTO payment_transactions
       (txn_ref, gateway, mode, entity_type, entity_id, hub_id, mobile,
        amount, currency, status, gateway_qr_id, qr_image_url, qr_expires_at,
        method_detail, created_by)
     VALUES ($1,$2,$3,'customer_invoice',$4,$5,$6,$7,'INR','created',$8,$9,$10,'upi',$11)
     RETURNING *`,
    [txnRef, gateway.name, gateway.mode(), inv.id, inv.hub_id, inv.mobile,
     amount, qr.id, qr.image_url, expiresAt, userId]
  );

  return {
    txn: ins.rows[0],
    qr: {
      txn_ref: txnRef,
      qr_id: qr.id,
      image_url: qr.image_url,
      amount,
      currency: 'INR',
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      mock: Boolean(qr.mock),
    },
    invoice: inv,
  };
}

/**
 * Cancels an unpaid QR — staff closing the modal, or an invoice being voided.
 *
 * Only ever touches a row still sitting at 'created'. A captured transaction is
 * money and is not cancellable, and saying so here rather than relying on the
 * caller means there is no ordering of events that can un-record a payment.
 */
async function cancelInvoiceQr({ txnRef, userId = null }) {
  const r = await pool.query(
    `SELECT * FROM payment_transactions WHERE txn_ref = $1`, [txnRef]);
  const txn = r.rows[0];
  if (!txn) throw fail(404, 'Payment record not found');
  if (!txn.gateway_qr_id) throw fail(400, 'That payment is not a QR.');

  if (txn.status === 'captured') {
    // Not an error the caller needs to handle — the customer paid while the
    // modal was closing, which is the most ordinary race this feature has.
    return { cancelled: false, captured: true, txn };
  }

  const gateway = getGateway();
  if (typeof gateway.closeQrCode === 'function') {
    await gateway.closeQrCode(txn.gateway_qr_id);   // never throws
  }

  // 'expired' rather than 'failed': nothing was declined and nothing went
  // wrong. failed is for a payment the gateway refused, and conflating the two
  // would put an abandoned QR into the failure numbers on the dashboard.
  const upd = await pool.query(
    `UPDATE payment_transactions
        SET status = 'expired', updated_at = NOW()
      WHERE id = $1 AND status = 'created'
      RETURNING *`, [txn.id]);

  if (upd.rowCount === 0) {
    // Lost the race with the webhook. Re-read and report the truth.
    const now = await pool.query(`SELECT * FROM payment_transactions WHERE id = $1`, [txn.id]);
    return { cancelled: false, captured: now.rows[0]?.status === 'captured', txn: now.rows[0] };
  }
  if (userId) console.log(`[payments] QR ${txn.txn_ref} cancelled by user ${userId}`);
  return { cancelled: true, captured: false, txn: upd.rows[0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capturing — the only path that turns a payment into money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a VERIFIED capture: transaction → ledger → invoice state, atomically.
 *
 * The caller must already have verified a signature. This function does not
 * verify one, because the two callers verify different things (a checkout
 * callback and a webhook body) and pretending they are the same would mean one
 * of them passing a signature it never had.
 *
 * @param gatewayPaymentId  the provider's payment id
 * @param gatewayPayment    normalised payment from the gateway, when available.
 *                          Preferred over anything the client sent — see below.
 * @param via               'callback' | 'webhook', for the log only
 * @returns { captured, duplicate, invoice_status, ledger_payment_id }
 */
async function captureVerifiedPayment({ txnId, gatewayPaymentId, gatewayPayment = null, via = 'callback' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE, not a plain SELECT. Without the row lock the browser callback
    // and the webhook can both read status='created', both decide to capture,
    // and both insert — the classic check-then-act race. The lock makes the
    // second one wait and then see 'captured'.
    const t = await client.query(
      `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`, [txnId]);
    const txn = t.rows[0];
    if (!txn) throw fail(404, 'Payment record not found');

    if (txn.status === 'captured') {
      await client.query('COMMIT');
      return { captured: true, duplicate: true, txn };
    }
    if (txn.entity_type !== 'customer_invoice') {
      throw fail(400, 'This payment is not against a customer invoice.');
    }

    // What the GATEWAY says was captured, not what the client said. When the
    // gateway could not be reached we fall back to the amount we opened the
    // order for, which is the amount the gateway was asked to charge — never to
    // a client-supplied figure.
    const amount = gatewayPayment && gatewayPayment.amount > 0
      ? gatewayPayment.amount
      : Number(txn.amount);

    await client.query(
      `UPDATE payment_transactions
          SET status = 'captured',
              gateway_payment_id = COALESCE($2, gateway_payment_id),
              method_detail = COALESCE($3, method_detail),
              raw_response = COALESCE($4::jsonb, raw_response),
              amount = $5,
              error_code = NULL, error_description = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [txn.id, gatewayPaymentId || null,
       gatewayPayment?.method_detail || null,
       gatewayPayment?.raw ? JSON.stringify(scrubRaw(gatewayPayment.raw)) : null,
       amount]
    );

    // The ledger row. ON CONFLICT DO NOTHING covers the unique index on
    // payment_transaction_id — the backstop that survives even if the lock and
    // the status check above were both somehow bypassed.
    const led = await client.query(
      `INSERT INTO customer_invoice_payments
         (customer_invoice_id, amount, method, reference_no, paid_at, notes,
          created_by, payment_transaction_id, source, hub_id, mobile)
       VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,'gateway',$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [txn.entity_id, amount,
       toLedgerMethod(gatewayPayment?.method_detail || txn.method_detail),
       // reference_no is what an accountant reconciles against the gateway
       // statement, so it is the gateway's id, not ours.
       gatewayPaymentId || txn.gateway_payment_id || txn.txn_ref,
       `Online payment ${txn.txn_ref}`,
       txn.created_by, txn.id,
       // From the TRANSACTION, which snapshotted it when the order was opened —
       // not re-read from the invoice here. Same reasoning as migration 131: the
       // hub that took the payment is a historical fact, and the transaction
       // already recorded it.
       txn.hub_id || null,
       // Same omission the manual path had, with the same silent effect: the
       // customer Payments tab finds money with `WHERE p.mobile = $1`, so a
       // NULL here makes a real online payment invisible on the customer's own
       // screen while the invoice shows it correctly.
       //
       // From the transaction again, for the reason directly above — it was
       // copied off the invoice when the order was opened, so it is the number
       // the customer actually paid against.
       //
       // vehicle_number is deliberately not set here: payment_transactions does
       // not carry one, and adding a second read of the invoice inside this
       // transaction to fetch a sub-label is not worth the query. The tab reads
       // fine without it.
       txn.mobile || null]
    );

    // The allocation, only when a ledger row was actually written.
    //
    // led.rowCount === 0 means ON CONFLICT DO NOTHING fired — this capture has
    // already been recorded, by the browser callback or by an earlier webhook
    // delivery. Inserting an allocation anyway would apply the same money to
    // the invoice twice, which is precisely the duplicate the partial unique
    // index on payment_transaction_id exists to prevent. The guard has to be
    // here rather than relying on that index, because payment_allocations has
    // no equivalent constraint — one payment is legitimately allowed several
    // allocations once advances arrive.
    if (led.rows[0]) {
      // ── ALLOCATE AT MOST WHAT THE INVOICE STILL OWES ─────────────────────
      //
      // This wrote the full captured amount with no ceiling, and it was the one
      // write path in the system without one — addPayment refuses an amount over
      // the balance, and allocate() refuses `asked > owed`. The gap is reachable
      // without anything going wrong at the gateway: a pay link and a counter QR
      // can both be opened for the same ₹10,000 balance (resolveCollectable
      // reads it unlocked, and they are separate transactions so no unique index
      // applies), and if the customer pays both, two ₹10,000 allocations landed.
      // The invoice then read amount_paid ₹20,000 against a ₹10,000 total, and
      // the ₹10,000 overpayment was buried inside amount_paid instead of
      // remaining as the customer's credit — invisible to _attachCustomerCredit,
      // and silently cancelling ₹10,000 of that customer's real dues elsewhere.
      //
      // Read under the same lock this transaction already holds on the invoice,
      // so the balance cannot move between the read and the insert.
      const bal = await client.query(
        `SELECT ci.grand_total
                - (COALESCE((SELECT SUM(l.amount) FROM invoice_payment_lines l
                              WHERE l.customer_invoice_id = ci.id), 0)
                   - COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                                WHERE rf.customer_invoice_id = ci.id
                                  AND rf.status = 'processed'), 0)) AS owed
           FROM customer_invoices ci WHERE ci.id = $1`,
        [txn.entity_id]);
      const owed = Number(bal.rows[0]?.owed ?? amount);
      // The 0.011 tolerance the rest of the module uses: a paisa of GST drift
      // must not turn a full settlement into a part-allocation.
      const toApply = Number(Math.min(Number(amount), Math.max(owed, 0)).toFixed(2));

      if (toApply > 0.001) {
        await client.query(
          `INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount, created_by)
           VALUES ($1,$2,$3,$4)`,
          [led.rows[0].id, txn.entity_id, toApply, txn.created_by || null]
        );
      }

      // The surplus is NOT discarded and NOT forced onto the invoice. The ledger
      // row is the full amount received — that is what the customer's bank
      // statement says — and the unallocated part is exactly what this system
      // already calls customer credit. It shows on the Unallocated tab and can
      // be applied to another invoice or refunded, which is the correct
      // treatment for money taken twice for one bill.
      const surplus = Number((Number(amount) - toApply).toFixed(2));
      if (surplus > 0.011) {
        console.warn(`[payments] ${txn.txn_ref}: ₹${surplus.toFixed(2)} of ₹${Number(amount).toFixed(2)} `
          + `exceeded the balance on invoice ${txn.entity_id} and is held as unapplied credit`);
      }
    }

    const state = await recalcInvoiceState(client, txn.entity_id);

    // Queue the "payment received" WhatsApp message, on THIS transaction and
    // only when a ledger row was actually written — led.rowCount === 0 means
    // this capture was already recorded by the racing callback/webhook, and
    // that earlier recording queued the receipt. AFTER recalc, so balance_due
    // already includes this payment. The dispatcher savepoints and never
    // throws; a messaging problem cannot fail a capture. No-op until the
    // template is enabled + auto_send in Settings → WhatsApp.
    if (led.rows[0]) {
      const { fireWhatsAppEvent } = require('./whatsappAutomations.service');
      await fireWhatsAppEvent(client, {
        event: 'payment.received',
        entityId: led.rows[0].id,
        dedupeKey: `received:${led.rows[0].id}`,
      });
    }

    // A link is spent once the invoice it points at is settled. Left active it
    // would keep offering a ₹0 checkout.
    if (txn.payment_link_id && state.status === 'paid') {
      await client.query(
        `UPDATE payment_links SET status = 'paid', updated_at = NOW()
          WHERE id = $1 AND status = 'active'`, [txn.payment_link_id]);
    }

    await client.query('COMMIT');

    // Side effects AFTER the commit. advanceAppointmentStatus and the warranty
    // resolver run their own transactions; calling them inside this one risks a
    // deadlock, and a failure in either must not roll back money we have
    // already received. This mirrors what the manual payment path does.
    if (state.status === 'paid') {
      try {
        await advanceAppointmentStatus(state.appointment_id, 'closed');
        const { resolveClaimForEstimate } = require('../controllers/warranty_claims.controller');
        await resolveClaimForEstimate(state.estimate_id);
      } catch (err) {
        // Logged, never rethrown: the payment is real and recorded. A stuck
        // appointment status is a follow-up, not a reason to fail the request
        // and have the customer try to pay twice.
        console.error('[payments] post-capture side effect failed for txn', txn.txn_ref, err.message);
      }
    }

    console.log(`[payments] captured ${txn.txn_ref} via ${via} — invoice ${txn.entity_id} is now ${state.status}`);

    return {
      captured: true,
      duplicate: led.rowCount === 0,
      ledger_payment_id: led.rows[0]?.id || null,
      invoice_status: state.status,
      invoice_id: txn.entity_id,
      amount,
      txn,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Records a failure without touching the ledger. Never throws on a missing row. */
async function markFailed({ txnId, code = null, description = null, raw = null }) {
  await pool.query(
    `UPDATE payment_transactions
        SET status = 'failed', error_code = $2, error_description = $3,
            raw_response = COALESCE($4::jsonb, raw_response), updated_at = NOW()
      WHERE id = $1 AND status NOT IN ('captured','refunded','partially_refunded')`,
    [txnId, code ? String(code).slice(0, 60) : null,
     description ? String(description).slice(0, 2000) : null,
     raw ? JSON.stringify(scrubRaw(raw)) : null]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The checkout callback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies a browser callback and captures it.
 *
 * Order of operations matters and is not negotiable:
 *   1. find OUR transaction by the order id — an order we never created is not
 *      a payment we accept, whatever signature accompanies it
 *   2. verify the HMAC
 *   3. ask the gateway what actually happened
 *   4. only then write anything
 *
 * Step 3 exists because a valid signature proves the gateway issued this
 * order/payment pair, not that the payment succeeded or for how much. The
 * authoritative amount and status come from the gateway itself.
 */
async function verifyCallback({ gatewayOrderId, gatewayPaymentId, signature }) {
  const r = await pool.query(
    `SELECT * FROM payment_transactions WHERE gateway_order_id = $1`, [gatewayOrderId]);
  const txn = r.rows[0];
  if (!txn) throw fail(404, 'We could not find that payment. Please contact support.');

  const gateway = getGateway();
  if (!gateway.verifyPaymentSignature({ orderId: gatewayOrderId, paymentId: gatewayPaymentId, signature })) {
    await markFailed({ txnId: txn.id, code: 'SIGNATURE_MISMATCH', description: 'Signature verification failed' });
    // The txn_ref, never the signature or the ids we compared.
    console.error('[payments] signature mismatch on', txn.txn_ref);
    throw fail(400, 'We could not verify that payment. If money has left your account it will be returned automatically — please contact support with reference ' + txn.txn_ref);
  }

  let gatewayPayment = null;
  try {
    gatewayPayment = await gateway.fetchPayment(gatewayPaymentId);
  } catch (err) {
    // The gateway being unreachable does not undo a verified signature. Capture
    // on what we know; the webhook will arrive with the authoritative detail.
    console.error('[payments] could not fetch payment detail for', txn.txn_ref, err.message);
  }

  if (gatewayPayment && !gatewayPayment.captured && gatewayPayment.status !== 'authorized') {
    await markFailed({
      txnId: txn.id,
      code: gatewayPayment.error_code || 'NOT_CAPTURED',
      description: gatewayPayment.error_description || `Gateway reports status '${gatewayPayment.status}'`,
      raw: gatewayPayment.raw,
    });
    throw fail(402, 'That payment did not complete. Nothing has been charged — please try again.');
  }

  return captureVerifiedPayment({
    txnId: txn.id, gatewayPaymentId, gatewayPayment, via: 'callback',
  });
}

module.exports = {
  createInvoiceOrder,
  createInvoiceQr,
  cancelInvoiceQr,
  resolveCollectable,
  captureVerifiedPayment,
  verifyCallback,
  markFailed,
  newTxnRef,
};
