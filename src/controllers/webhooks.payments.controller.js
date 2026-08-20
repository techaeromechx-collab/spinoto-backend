'use strict';

/**
 * Gateway webhooks.
 *
 * ⚠ THIS ENDPOINT IS UNAUTHENTICATED. Anyone on the internet can POST to it.
 *   Its only defence is the signature check, and that check is the difference
 *   between this being a payment notification and being a "mark any invoice
 *   paid" button. Nothing below the verification may run before it.
 *
 * WHY IT IS NOT OPTIONAL
 * ──────────────────────
 * It is tempting to treat the browser callback as the real path and this as a
 * backup. It is the other way round. The callback only fires if the customer's
 * browser is still open and still on our page when the payment completes — and
 * on a phone, mid-UPI-app-switch, on a workshop's patchy connection, it very
 * often is not. Every one of those payments is money taken with no record,
 * unless this endpoint exists.
 *
 * THE RAW BODY
 * ────────────
 * Verification is an HMAC over the exact bytes received. server.js already
 * keeps them on `req.rawBody` (the express.json verify hook, added for the
 * WhatsApp webhook), so no separate express.raw mount is needed — and adding
 * one would have to be ordered before express.json, which is the classic way
 * this integration silently breaks.
 *
 * ALWAYS 200 ON A DUPLICATE
 * ─────────────────────────
 * A non-2xx tells the gateway to retry. Returning an error for an event we have
 * already handled produces an infinite retry loop against our own correct
 * behaviour.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const { getGateway, getPayoutGateway } = require('../services/gateway');
const { scrubRaw } = require('../services/gateway/types');
const { captureVerifiedPayment, markFailed } = require('../services/payments.service');
const { captureAdvance } = require('../services/advances.service');

/** Events we act on. Anything else is stored and ignored, not treated as an error. */
const HANDLED = new Set([
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
  // A UPI QR was paid. THIS is the only notification a QR payment produces that
  // we can act on — see onQrCredited for why payment.captured is not enough.
  'qr_code.credited',
]);

/**
 * Money OUT. Handled by handlePayoutWebhook below, NOT by handleWebhook.
 *
 * ── WHY A SECOND ENDPOINT AND NOT A SECOND CASE IN dispatch() ───────────────
 * The signature. Payouts are a different product with a different webhook
 * secret, so a single handler would have to try one secret and then the other —
 * which turns "the signature did not verify" from a hard refusal into a guess,
 * and doubles the HMAC work on every anonymous request hitting the endpoint.
 *
 * Everything that CAN be shared is: the same controller file, the same
 * payment_webhook_events table, and the same uq_webhook_event (gateway,
 * event_id) index doing the deduplication. The gateway column keeps the two
 * streams apart, so a razorpay event id and a razorpayx event id can never
 * collide with each other.
 *
 * 'payout.reversed' is the one this system has no equivalent of on the way in: a
 * transfer that completed days ago and came back. It DELETES the ledger rows and
 * reopens the purchase invoices — see services/payouts.service.js.
 */
const HANDLED_PAYOUT = new Set([
  'payout.processed',
  'payout.failed',
  'payout.reversed',
  // Accepted by the bank but not yet sent — worth recording so the screen can
  // stop saying "queued" when the provider has moved on.
  'payout.updated',
]);

/**
 * A stable identity for this delivery.
 *
 * The header where the gateway sends one; otherwise a digest of the body. A
 * fallback is required rather than nice-to-have: Razorpay's event id header is
 * not present on every account or event type, and an idempotency key that is
 * sometimes NULL does not deduplicate anything.
 */
function eventIdOf(req, rawBody) {
  const header = req.get('x-razorpay-event-id');
  if (header) return String(header).slice(0, 120);
  return 'sha256:' + crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 60);
}

async function handleWebhook(req, res) {
  const gateway = getGateway();
  const signature = req.get('x-razorpay-signature');

  // Buffer preferred. The fallback re-serialises, which produces different
  // bytes and would fail verification — it exists so a missing rawBody surfaces
  // as a clean 400 rather than a crash.
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(req.rawBody || JSON.stringify(req.body || {}), 'utf8');

  // ── 1. Verify. Nothing before this line touches the database. ─────────────
  if (!gateway.isWebhookConfigured()) {
    // No secret means no way to tell the gateway from anyone else. Refuse, and
    // say so in the log — a silently-accepting webhook is far worse than a
    // loudly broken one.
    console.error('[webhook] rejected: RAZORPAY_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Webhooks are not configured.' });
  }
  if (!gateway.verifyWebhookSignature({ rawBody, signature })) {
    // Never log the body or the signature — an unverified payload is attacker-
    // controlled input and the log is a place it should not be replayed into.
    console.error('[webhook] signature verification FAILED from', req.ip);
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Malformed payload.' });
  }

  const eventType = String(body.event || '').slice(0, 60);
  const eventId = eventIdOf(req, rawBody);
  const entity =
    body?.payload?.payment?.entity ||
    body?.payload?.refund?.entity || {};

  // qr_code.credited carries TWO entities: payload.payment.entity (the money)
  // and payload.qr_code.entity (which QR produced it). Both are needed, because
  // Razorpay's payment entity contains no reference back to the QR — so the
  // payment alone cannot be matched to one of our rows. Extracted alongside
  // `entity` rather than replacing it: the amount, the method and the payment
  // id still come from the payment.
  const qrEntity = body?.payload?.qr_code?.entity || null;

  // ── 2. Claim the event. The unique index is the deduplication. ────────────
  // INSERT … ON CONFLICT DO NOTHING, and rowCount tells us which of two
  // concurrent deliveries won. Doing this with a SELECT-then-INSERT would let
  // both deliveries pass the check and both process the payment.
  const claim = await pool.query(
    `INSERT INTO payment_webhook_events
       (gateway, event_id, event_type, gateway_payment_id, payload, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,'received')
     ON CONFLICT (gateway, event_id) DO NOTHING
     RETURNING id`,
    [gateway.name, eventId, eventType, entity.id || null,
     JSON.stringify(scrubRaw(entity) || {})]
  );

  if (claim.rowCount === 0) {
    // Already seen. 200, because anything else asks the gateway to keep
    // retrying an event we have correctly handled.
    return res.json({ ok: true, duplicate: true });
  }
  const eventRowId = claim.rows[0].id;

  if (!HANDLED.has(eventType)) {
    await pool.query(
      `UPDATE payment_webhook_events SET status='ignored', processed_at=NOW() WHERE id=$1`,
      [eventRowId]);
    return res.json({ ok: true, ignored: eventType });
  }

  // ── 3. Handle. Failures are recorded, never thrown at the gateway. ────────
  try {
    await dispatch(eventType, entity, qrEntity);
    await pool.query(
      `UPDATE payment_webhook_events SET status='processed', processed_at=NOW() WHERE id=$1`,
      [eventRowId]);
    return res.json({ ok: true });
  } catch (err) {
    await pool.query(
      `UPDATE payment_webhook_events
          SET status='failed', error_text=$2, processed_at=NOW() WHERE id=$1`,
      [eventRowId, String(err.message || err).slice(0, 2000)]);
    console.error('[webhook] handler failed for', eventType, eventId, err.message);
    // 200 on purpose. The event is stored and replayable; a 500 buys us the
    // same broken handler running again every few minutes, and Razorpay
    // eventually disables an endpoint that keeps failing — losing the events
    // that would have worked.
    return res.json({ ok: true, deferred: true });
  }
}

async function dispatch(eventType, entity, qrEntity) {
  switch (eventType) {
    case 'payment.captured':  return onPaymentCaptured(entity);
    case 'payment.failed':    return onPaymentFailed(entity);
    case 'refund.processed':  return onRefund(entity, 'processed');
    case 'refund.failed':     return onRefund(entity, 'failed');
    case 'qr_code.credited':  return onQrCredited(entity, qrEntity);
    default: return undefined;
  }
}

/**
 * Finds OUR transaction for a gateway event. An unmatched event is not ours.
 *
 * Three ways in, because there are three kinds of row:
 *   order_id   a checkout payment, matched before the payment id exists
 *   payment_id anything we have already captured once (the retry path)
 *   qr_id      a UPI QR, which has no order at all
 */
async function findTxn({ order_id, id, qr_id } = {}) {
  const r = await pool.query(
    `SELECT * FROM payment_transactions
      WHERE ($1::text IS NOT NULL AND gateway_order_id = $1)
         OR ($2::text IS NOT NULL AND gateway_payment_id = $2)
         OR ($3::text IS NOT NULL AND gateway_qr_id = $3)
      LIMIT 1`,
    [order_id || null, id || null, qr_id || null]);
  return r.rows[0] || null;
}

/**
 * A UPI QR was paid.
 *
 * WHY THIS EVENT AND NOT payment.captured
 * ───────────────────────────────────────
 * Razorpay fires payment.captured for a QR payment too, but that payload has
 * no order_id and no reference to the QR — there is nothing in it that points
 * at one of our rows. Only qr_code.credited carries payload.qr_code.entity,
 * and gateway_qr_id is how we recognise our own transaction.
 *
 * BOTH EVENTS ARRIVE, IN EITHER ORDER, AND BOTH ORDERS ARE SAFE
 * ─────────────────────────────────────────────────────────────
 *   credited first   → captures, and writes gateway_payment_id onto the row.
 *                      The payment.captured that follows now matches by
 *                      payment id and captureVerifiedPayment returns
 *                      duplicate:true without touching the ledger.
 *   captured first   → findTxn cannot match it, so it is logged and dropped
 *                      (see onPaymentCaptured). The credited event that
 *                      follows does the real work.
 *
 * Either way exactly one ledger row is written, and the partial unique index on
 * customer_invoice_payments.payment_transaction_id is what guarantees that
 * rather than this reasoning being correct.
 */
async function onQrCredited(payment, qr) {
  const qrId = qr?.id || null;
  if (!qrId) {
    console.warn('[webhook] qr_code.credited arrived with no qr_code entity — ignoring');
    return;
  }

  const txn = await findTxn({ qr_id: qrId, id: payment?.id });
  if (!txn) {
    console.warn('[webhook] qr_code.credited for an unknown QR', qrId);
    return;
  }

  const gateway = getGateway();
  const normalised = gateway.normalisePayment ? gateway.normalisePayment(payment || {}) : null;

  // A QR raised against an ESTIMATE is an advance — same reasoning as
  // onPaymentCaptured. The instrument does not change what the money is.
  if (txn.entity_type === 'estimate') {
    await captureAdvance({
      txnId: txn.id,
      gatewayPaymentId: payment?.id || null,
      gatewayPayment: normalised,
      via: 'webhook:qr',
    });
    return;
  }

  // The same capture function the checkout callback and payment.captured use.
  // One capture path — so a QR payment produces the same ledger row, the same
  // invoice status, the same hub payout date and the same appointment
  // transition as any other payment. Nothing about money is special-cased for
  // having arrived by QR.
  await captureVerifiedPayment({
    txnId: txn.id,
    gatewayPaymentId: payment?.id || null,
    gatewayPayment: normalised,
    via: 'webhook:qr',
  });
}

async function onPaymentCaptured(entity) {
  const txn = await findTxn(entity);
  if (!txn) {
    // Not an error. Two ordinary causes: the test webhook URL pointing at a
    // production server, and a QR payment whose qr_code.credited has not
    // arrived yet — that payload carries nothing that identifies our row, so
    // there is nothing to match on. Worth seeing in the log, not worth failing
    // over; the event row keeps the evidence and credited does the work.
    console.warn('[webhook] payment.captured for an unknown order', entity.order_id || entity.id);
    return;
  }

  const gateway = getGateway();
  const normalised = gateway.normalisePayment ? gateway.normalisePayment(entity) : null;

  // An ADVANCE captures differently, because there is no invoice yet.
  //
  // captureVerifiedPayment writes a ledger row bound to an invoice and then
  // recalculates that invoice. An estimate-scoped transaction has none — the
  // whole point is that the money arrived first. So it takes the advance path,
  // which writes an unallocated ledger row and draws a receipt number instead.
  //
  // Routed on entity_type rather than on a missing invoice id: "this is an
  // advance" is a fact about the transaction, not something to infer from an
  // absence.
  if (txn.entity_type === 'estimate') {
    await captureAdvance({
      txnId: txn.id,
      gatewayPaymentId: entity.id,
      gatewayPayment: normalised,
      via: 'webhook',
    });
    return;
  }

  // The same function the browser callback uses. One capture path, so the
  // ledger row, the invoice status, the payout date and the appointment
  // transition cannot differ depending on which message arrived first.
  await captureVerifiedPayment({
    txnId: txn.id,
    gatewayPaymentId: entity.id,
    gatewayPayment: normalised,
    via: 'webhook',
  });
}

async function onPaymentFailed(entity) {
  const txn = await findTxn(entity);
  if (!txn) return;
  await markFailed({
    txnId: txn.id,
    code: entity.error_code || 'FAILED',
    description: entity.error_description || 'Reported failed by the gateway',
    raw: entity,
  });
}

/**
 * A refund result.
 *
 * This is where a refund becomes real. Requesting one moves nothing; the money
 * arrives back over the following days and THIS is the confirmation. Only on
 * 'processed' does the invoice balance come down — see
 * services/refunds.service.js.
 */
async function onRefund(entity, outcome) {
  const { applyRefundOutcome } = require('../services/refunds.service');
  await applyRefundOutcome({
    gatewayRefundId: entity.id,
    gatewayPaymentId: entity.payment_id,
    amount: entity.amount != null ? Number(entity.amount) / 100 : null,
    outcome,
    raw: entity,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Money out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payout webhooks.
 *
 * ⚠ ALSO UNAUTHENTICATED, and the stakes here are the opposite way round from
 *   the collections endpoint. There, a forged event marks an invoice paid that
 *   was not. Here, a forged payout.processed marks a HUB paid that was not —
 *   closing out a real debt and removing the invoice from the payouts screen, so
 *   nobody ever pays it. A forged payout.reversed does the mirror image: it
 *   deletes ledger rows for money that genuinely left.
 *
 *   Both are silent. Neither has a customer to complain. The signature check is
 *   the only thing standing in front of them.
 *
 * The structure below is deliberately the same shape as handleWebhook — verify,
 * claim, dispatch, always 200 — rather than a cleverer version. Two webhook
 * handlers that look different are two handlers to reason about separately, and
 * the differences that matter (which secret, which HANDLED set, which service)
 * are then hard to see among the ones that do not.
 */
async function handlePayoutWebhook(req, res) {
  const gateway = getPayoutGateway();
  const signature = req.get('x-razorpay-signature');

  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(req.rawBody || JSON.stringify(req.body || {}), 'utf8');

  if (!gateway.isWebhookConfigured()) {
    console.error('[webhook:payout] rejected: RAZORPAYX_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Payout webhooks are not configured.' });
  }
  if (!gateway.verifyWebhookSignature({ rawBody, signature })) {
    console.error('[webhook:payout] signature verification FAILED from', req.ip);
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Malformed payload.' });
  }

  const eventType = String(body.event || '').slice(0, 60);
  const eventId = eventIdOf(req, rawBody);
  const entity = body?.payload?.payout?.entity || {};

  // The same table and the same unique index as the collections stream. The
  // `gateway` column is what keeps them from colliding — hence gateway.name and
  // not a hard-coded string.
  const claim = await pool.query(
    `INSERT INTO payment_webhook_events
       (gateway, event_id, event_type, gateway_payment_id, payload, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,'received')
     ON CONFLICT (gateway, event_id) DO NOTHING
     RETURNING id`,
    [gateway.name, eventId, eventType, entity.id || null,
     JSON.stringify(scrubRaw(entity) || {})]
  );

  if (claim.rowCount === 0) return res.json({ ok: true, duplicate: true });
  const eventRowId = claim.rows[0].id;

  if (!HANDLED_PAYOUT.has(eventType)) {
    await pool.query(
      `UPDATE payment_webhook_events SET status='ignored', processed_at=NOW() WHERE id=$1`,
      [eventRowId]);
    return res.json({ ok: true, ignored: eventType });
  }

  try {
    await onPayoutEvent(entity);
    await pool.query(
      `UPDATE payment_webhook_events SET status='processed', processed_at=NOW() WHERE id=$1`,
      [eventRowId]);
    return res.json({ ok: true });
  } catch (err) {
    await pool.query(
      `UPDATE payment_webhook_events
          SET status='failed', error_text=$2, processed_at=NOW() WHERE id=$1`,
      [eventRowId, String(err.message || err).slice(0, 2000)]);
    console.error('[webhook:payout] handler failed for', eventType, eventId, err.message);
    // 200, same reasoning as the collections handler: the event is stored and
    // replayable, and a provider that keeps getting 500s eventually disables the
    // endpoint — losing the events that would have worked.
    return res.json({ ok: true, deferred: true });
  }
}

/**
 * One handler for all four events, because the payload is the same entity and
 * the provider's own `status` field is more trustworthy than the event name.
 *
 * A payout.updated that carries status 'processed' IS a processed payout — and
 * routing on the event name instead would leave it queued for ever waiting for a
 * payout.processed that already effectively arrived.
 */
async function onPayoutEvent(entity) {
  const { applyPayoutOutcome } = require('../services/payouts.service');
  const gateway = getPayoutGateway();
  const n = gateway.normalisePayout(entity || {});

  await applyPayoutOutcome({
    gatewayPayoutId: n.gateway_payout_id,
    // reference_id is our payout_ref, echoed back. The fallback that lets an
    // event be matched when the provider id was never stored — a request that
    // timed out after the provider accepted it.
    payoutRef: entity?.reference_id || null,
    status: n.status,
    utr: n.utr,
    failureReason: n.failure_reason,
    raw: n.raw,
  });
}

module.exports = { handleWebhook, handlePayoutWebhook, eventIdOf, HANDLED, HANDLED_PAYOUT };
