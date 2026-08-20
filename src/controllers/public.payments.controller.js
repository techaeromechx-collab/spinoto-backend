'use strict';

/**
 * PUBLIC pay-by-link API — what the customer's browser talks to.
 *
 * ⚠ EVERY ROUTE HERE IS UNAUTHENTICATED. Anyone with the link, and anyone the
 *   link is forwarded to, can call these. The rules below are the reason it is
 *   safe to expose:
 *
 *   1. The AMOUNT is always recomputed server-side from the invoice. A request
 *      body amount is clamped to the outstanding balance and can only ever
 *      lower it. Nothing here trusts a client figure.
 *   2. The token grants access to ONE invoice's payment, not to the invoice.
 *      The response carries the number, the amount due, the hub and a MASKED
 *      mobile — never line items, cost prices, hub margins, the customer's
 *      address or their full number. A public URL gets forwarded.
 *   3. Links EXPIRE and can be cancelled. An immortal payment URL is a
 *      liability, and cancelling a payment request must not break the QR code
 *      already printed on the paper invoice — which is why this uses its own
 *      token and not customer_invoices.public_token.
 *   4. Rate limiting is applied at the route layer, keyed on IP.
 *   5. Signature verification on the way back is identical to the internal
 *      path: the same service, the same HMAC. A public caller gets no weaker
 *      check.
 *
 * Same shape as the two public surfaces that came before it —
 * public.booking.controller.js and public.documents.controller.js. Read their
 * headers before changing anything here.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { maskMobile } = require('../utils/maskMobile');
const { readInvoiceBalance } = require('../services/invoiceBalance.service');
const { createInvoiceOrder, verifyCallback, markFailed } = require('../services/payments.service');
const { getGateway } = require('../services/gateway');
const { loadCompany } = require('../utils/renderDocument');
const { resolveDocumentConfig } = require('../utils/documentConfig');
const { hubLabel } = require('../templates/documentAdapter');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err?.name === 'ZodError') {
        return res.status(400).json({ error: 'That request was not valid.' });
      }
      if (err?.status) return res.status(err.status).json({ error: err.message });
      // Never leak an internal error to an anonymous caller — it can name
      // tables, columns and ids.
      console.error('[public-pay]', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    });
  };
}

const tokenParam = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

/**
 * Loads a link and the invoice behind it, or throws.
 *
 * Expiry is evaluated on read AND written back, so a link that lapses becomes
 * 'expired' the first time anyone touches it rather than waiting for a sweep
 * that might not run. The check itself never depends on the stored status — a
 * link past its date is refused even if the column still says 'active'.
 */
async function loadLink(token) {
  const r = await pool.query(
    `SELECT * FROM payment_links WHERE token = $1`, [token]);
  const link = r.rows[0];

  // One message for every reason a link does not work.
  //
  // Distinguishing "no such link" from "cancelled" from "expired" tells anyone
  // probing tokens which guesses were real, and tells a customer nothing they
  // can act on — in all three cases the answer is "ask the workshop for a new
  // one".
  const dead = fail(404, 'This payment link is no longer valid. Please ask the workshop for a new one.');
  if (!link) throw dead;

  if (new Date(link.expires_at) < new Date()) {
    if (link.status === 'active') {
      await pool.query(
        `UPDATE payment_links SET status='expired', updated_at=NOW() WHERE id=$1 AND status='active'`,
        [link.id]);
    }
    throw dead;
  }
  if (link.status === 'cancelled' || link.status === 'expired') throw dead;

  // An ADVANCE link points at an estimate, not an invoice.
  //
  // The customer-facing surface is the same either way — a name, a vehicle, an
  // amount and a Pay button — so both are resolved into one shape rather than
  // branching through the three handlers below. What differs is only what the
  // amount MEANS: a balance owed on a finished job, or a part payment on a
  // quoted one.
  if (link.entity_type === 'estimate') {
    const r = await pool.query(
      `SELECT e.id, e.hub_id, e.grand_total, e.total_gst, e.subtotal_ex_gst,
              COALESCE(e.customer_name, a.customer_name)   AS customer_name,
              COALESCE(e.mobile,        a.mobile)          AS mobile,
              COALESCE(e.vehicle_number, a.vehicle_number) AS vehicle_number,
              (SELECT COALESCE(SUM(p.amount), 0) FROM customer_invoice_payments p
                WHERE p.estimate_id = e.id AND p.payment_type = 'advance') AS advanced
         FROM estimates e
         LEFT JOIN appointments a ON a.id = e.appointment_id
        WHERE e.id = $1`,
      [link.entity_id]
    );
    const est = r.rows[0];
    if (!est) throw dead;
    return {
      link,
      kind: 'advance',
      target: {
        id: est.id,
        hub_id: est.hub_id,
        customer_name: est.customer_name,
        mobile: est.mobile,
        vehicle_number: est.vehicle_number,
        grand_total: Number(est.grand_total),
        total_gst: Number(est.total_gst),
        subtotal_ex_gst: Number(est.subtotal_ex_gst),
        amount_paid: Number(est.advanced),
        // What is still to collect on the JOB, not on this link. A second
        // advance taken between the link being sent and opened must reduce
        // what this one can still take.
        balance: Number((Number(est.grand_total) - Number(est.advanced)).toFixed(2)),
      },
    };
  }

  const invoice = await readInvoiceBalance(pool, link.entity_id);
  if (!invoice) throw dead;
  return { link, kind: 'invoice', target: invoice, invoice };
}

/**
 * Everything the pay page shows that isn't the balance: who the workshop is,
 * how the bill breaks down, and who to call.
 *
 * Two things here are deliberate rather than convenient.
 *
 * THE HUB NAME goes through hubLabel() — the same function the invoice PDF
 * uses — so the pay page and the document in the customer's hand always name
 * the same business. Reading hubs.hub_name directly would show the partner
 * workshop's own trading name while the invoice says "Spinoto Gota", and would
 * name the hub even when hub_name_mode is set to 'hidden'.
 *
 * THE SUPPORT NUMBER is the company's, never the hub's. Spinoto is the merchant
 * of record: the money lands in Spinoto's gateway account, only Spinoto can
 * refund it, and the hub cannot see the transaction in any system. Publishing
 * the hub's number would also put a personal mobile (hubs.contact_number sits
 * under person_name) on a URL designed to be forwarded.
 */
async function payPageContext({ invoiceId = null, hubId = null }) {
  const company = await loadCompany();
  // viewerRole 'admin': this resolves the GLOBAL naming rule, not a hub-scoped
  // view. The customer is neither.
  const cfg = resolveDocumentConfig(company.document_config, 'customer_invoice', 'admin');

  // Keyed on the HUB, with the invoice as an optional extra.
  //
  // An advance has no invoice to read the workshop's name from — but it does
  // have a hub, and the name a customer sees must be the same one on the
  // document they eventually receive. Two queries would be two chances for
  // those to diverge.
  const r = invoiceId
    ? await pool.query(
        `SELECT ci.subtotal_ex_gst, ci.total_gst, ci.grand_total, ci.public_token,
                ('Spinoto ' || ar.name) AS branch_name,
                h.hub_name              AS legal_name,
                c.name                  AS city_name,
                s.name                  AS state_name
           FROM customer_invoices ci
           LEFT JOIN hubs   h  ON h.id  = ci.hub_id
           LEFT JOIN areas  ar ON ar.id = h.area_id
           LEFT JOIN cities c  ON c.id  = h.city_id
           LEFT JOIN states s  ON s.id  = h.state_id
          WHERE ci.id = $1`, [invoiceId])
    : await pool.query(
        `SELECT NULL::numeric AS subtotal_ex_gst, NULL::numeric AS total_gst,
                NULL::numeric AS grand_total, NULL::varchar AS public_token,
                ('Spinoto ' || ar.name) AS branch_name,
                h.hub_name              AS legal_name,
                c.name                  AS city_name,
                s.name                  AS state_name
           FROM hubs h
           LEFT JOIN areas  ar ON ar.id = h.area_id
           LEFT JOIN cities c  ON c.id  = h.city_id
           LEFT JOIN states s  ON s.id  = h.state_id
          WHERE h.id = $1`, [hubId]);
  const row = r.rows[0] || {};

  return {
    hub_label: hubLabel(cfg, { legalName: row.legal_name, branchName: row.branch_name }),
    hub_location: [row.city_name, row.state_name].filter(Boolean).join(', ') || null,
    subtotal_ex_gst: row.subtotal_ex_gst != null ? Number(row.subtotal_ex_gst) : null,
    total_gst:       row.total_gst != null ? Number(row.total_gst) : null,
    // The TOKEN, not a URL.
    //
    // The obvious thing is to return `${base}/customer-invoices/<token>` — the
    // same address WhatsApp sends. That link is wrong here, and it fails in a
    // way that is easy to miss: App.jsx only mounts the public invoice route
    // when NOBODY is signed in (`{!loading && !user && …}`), because it shares
    // its path with a staff deep link. Open it while signed in and it falls
    // through to the authenticated tree — where a hub session is redirected
    // straight to /hub and sees a dashboard instead of their invoice.
    //
    // That frontend page is only a courtesy shell anyway: all it does is
    // redirect to the backend's public PDF endpoint. So the pay page skips the
    // hop and links to the PDF directly, which is unauthenticated and behaves
    // identically whether or not a session exists.
    //
    // The URL is assembled on the frontend, from the API base it already has in
    // VITE_API_URL. Building it here would need PUBLIC_API_BASE_URL, which is
    // only required for the webhook today — and a link that silently vanishes
    // because a variable used elsewhere is unset is exactly the kind of failure
    // nobody notices until a customer asks what they are paying for.
    invoice_token: row.public_token || null,
    // company_name is deliberately NOT returned. It holds the legal entity
    // ("… Automotive Pvt. Ltd.") — right on a tax invoice, wrong at the top of a
    // payment page, where a name the customer has never heard of reads as a
    // scam. The page shows the Spinoto mark instead.
    support_phone: company.phone || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/pay/:token — what the pay page renders
// ─────────────────────────────────────────────────────────────────────────────
const getPayPage = handler(async (req, res) => {
  const token = tokenParam.parse(req.params.token);
  const { link, kind, target } = await loadLink(token);

  // Counted, not logged in detail. "I never got the link" is answerable when
  // this is 0; "I think I paid twice" is explained when it is 9.
  await pool.query(
    `UPDATE payment_links SET opened_count = opened_count + 1, last_opened_at = NOW() WHERE id = $1`,
    [link.id]);

  const invoice = target;
  const ctx = await payPageContext(
    kind === 'advance' ? { hubId: target.hub_id } : { invoiceId: target.id });

  // A deliberately narrow projection. Everything a customer needs to recognise
  // their own bill and see what it is for — and nothing that would matter on
  // its own if this URL were forwarded to a stranger or posted in a group chat.
  //
  // The GST figure is the invoice's TOTAL tax, with no percentage attached.
  // gst_percent is stored per line item and a real job mixes rates — labour at
  // 18%, some parts at 28%. A single "GST (18%)" label would be an incorrect
  // tax figure on a page taking money.
  res.json({
    // What the customer is being asked to pay. An advance is not a bill —
    // saying "Invoice CI-000041" over a job that has not been invoiced yet
    // would be wrong on the one page where the customer is deciding whether
    // this is real.
    kind,
    invoice_number: kind === 'advance'
      ? null
      : `CI-${String(invoice.id).padStart(6, '0')}`,
    // The amount asked for on THIS link. For an invoice it is the balance; for
    // an advance it is what the workshop chose to collect now, which is less
    // than the job total by design.
    link_amount: Number(link.amount),
    customer_name: invoice.customer_name || '',
    // Masked even on the customer's own link: it is here so they can confirm
    // the bill is theirs, which the last five digits do, and the URL is public.
    mobile: maskMobile(invoice.mobile),
    vehicle_number: invoice.vehicle_number || '',

    subtotal_ex_gst: kind === 'advance' ? invoice.subtotal_ex_gst : ctx.subtotal_ex_gst,
    total_gst:       kind === 'advance' ? invoice.total_gst       : ctx.total_gst,
    total: invoice.grand_total,
    amount_paid: invoice.amount_paid,
    balance: invoice.balance,
    already_paid: invoice.balance <= 0.01,

    hub_label: ctx.hub_label,
    hub_location: ctx.hub_location,
    invoice_token: ctx.invoice_token,
    support_phone: ctx.support_phone,

    // The real moment it stops working, not an assumed end of day. A link made
    // at 3:42 pm expires at 3:42 pm, and telling someone they have until
    // midnight leaves them with a dead link and no explanation.
    expires_at: link.expires_at,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/pay/:token/order
// ─────────────────────────────────────────────────────────────────────────────
const createPublicOrder = handler(async (req, res) => {
  const token = tokenParam.parse(req.params.token);
  const { link, kind, target } = await loadLink(token);

  if (target.balance <= 0.01) {
    throw fail(409, kind === 'advance'
      ? 'The full amount for this job has already been received. Thank you.'
      : 'This invoice has already been paid in full. Thank you.');
  }

  const body = z.object({
    amount: z.coerce.number().positive().optional().nullable(),
  }).parse(req.body || {});

  // An ADVANCE has a transaction already — it was created with the link, so
  // that the pair could never disagree about which estimate they belong to.
  //
  // The amount is the LINK's, not the request's. An invoice payment can be
  // part-paid by the customer because the balance is theirs to settle at their
  // own pace; an advance is a figure the workshop asked for, and letting the
  // page reduce it would make the receipt disagree with what was requested.
  if (kind === 'advance') {
    // The SEED is the pristine row created alongside the link — the one that has
    // never been given an order id. Ordered so that row wins whenever it exists.
    //
    // This matters now that each order gets its own row: taking "the newest"
    // would pick a row THIS function created, and the derived txn_ref below
    // would chain — PY…-a1b2c3d4-e5f6a7b8 — growing by nine characters per
    // opening until it overflows VARCHAR(40) and the insert starts failing on
    // the fourth or fifth tap. Anchoring on the pristine row keeps every derived
    // ref exactly one generation deep.
    const t = await pool.query(
      `SELECT * FROM payment_transactions
        WHERE payment_link_id = $1 AND status IN ('created','attempted')
        ORDER BY (gateway_order_id IS NULL) DESC, id ASC
        LIMIT 1`, [link.id]);
    if (!t.rows[0]) throw fail(409, 'This payment request is no longer open. Please ask the workshop for a new link.');
    const seed = t.rows[0];

    const gateway = getGateway();
    const order = await gateway.createOrder({
      amount: Number(seed.amount),
      receipt: seed.txn_ref,
      notes: { txn_ref: seed.txn_ref, estimate_id: String(link.entity_id) },
    });

    // ── ONE TRANSACTION ROW PER ORDER ────────────────────────────────────────
    //
    // This used to UPDATE gateway_order_id on the single row created with the
    // link, the way the invoice path does NOT — createInvoiceOrder inserts a
    // fresh row per order, and that difference was the bug.
    //
    // A pay link gets forwarded. Customer opens it and taps Pay (order A lands
    // on the row); their spouse opens the same link and taps Pay a few seconds
    // later (order B OVERWRITES it). Both complete the UPI payment. The webhook
    // finds our row only via findTxn({order_id}), so order A now matches
    // nothing: it is logged as "payment.captured for an unknown order", dropped,
    // and answered 200 so the gateway never retries. ₹4,000 taken from
    // customers, ₹2,000 recorded, no ledger row and no voucher for the rest.
    //
    // A row per order means every order id stays resolvable for ever. The second
    // capture then lands as an ordinary second advance — visible, refundable,
    // and allocatable — instead of vanishing.
    //
    // Everything except the order id and the status is copied from the seed row,
    // so the pair still cannot disagree about which estimate they belong to.
    const ins = await pool.query(
      `INSERT INTO payment_transactions
         (txn_ref, gateway, mode, entity_type, entity_id, payment_link_id,
          amount, currency, status, gateway_order_id, hub_id, mobile, created_by)
       SELECT $1, gateway, mode, entity_type, entity_id, payment_link_id,
              amount, currency, 'attempted', $2, hub_id, mobile, created_by
         FROM payment_transactions WHERE id = $3
       RETURNING id, txn_ref, amount`,
      // txn_ref is VARCHAR(40) and UNIQUE. 30 + 1 + 8 = 39, so the derived ref
      // fits whatever the generator produces, and the order-id tail keeps it
      // unique per order without another round trip to check.
      [`${String(seed.txn_ref).slice(0, 30)}-${String(order.id).slice(-8)}`, order.id, seed.id]);

    // The seed row keeps its own identity and stays 'created' until it is either
    // used or expires. It is never handed an order id it did not open.
    const txn = ins.rows[0] || seed;

    return res.status(201).json({
      order_id: order.id,
      key_id: order.key_id,             // PUBLIC key. Never the secret.
      amount: Number(txn.amount),
      currency: 'INR',
      txn_ref: txn.txn_ref,
      mock: Boolean(order.mock),
    });
  }

  // createInvoiceOrder recomputes the balance and clamps whatever is asked for.
  // The invoice id comes from the LINK, never from the request body — a caller
  // cannot point their token at someone else's invoice.
  const { order } = await createInvoiceOrder({
    customerInvoiceId: link.entity_id,
    requestedAmount: body.amount ?? null,
    userId: null,                       // no staff member involved
    paymentLinkId: link.id,
  });

  res.status(201).json(order);           // public key only
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/pay/:token/verify
// ─────────────────────────────────────────────────────────────────────────────
const verifyPublicPayment = handler(async (req, res) => {
  const token = tokenParam.parse(req.params.token);
  const { link, kind } = await loadLink(token);

  const body = z.object({
    gateway_order_id:   z.string().trim().min(1).max(100),
    gateway_payment_id: z.string().trim().min(1).max(100),
    signature:          z.string().trim().max(200).optional().nullable(),
  }).parse(req.body || {});

  // The order must belong to THIS link. Without this check a valid signature
  // for any order in the system could be replayed through any token — the
  // signature proves the gateway issued the pair, not that it relates to the
  // invoice this caller holds a link for.
  const own = await pool.query(
    `SELECT id FROM payment_transactions WHERE gateway_order_id = $1 AND payment_link_id = $2`,
    [body.gateway_order_id, link.id]);
  if (!own.rows[0]) throw fail(404, 'We could not match that payment. Please contact the workshop.');

  // An advance verifies the same signature and captures down a different path,
  // because there is no invoice to recalculate. The check above is identical
  // and comes first either way — nothing is believed before it.
  if (kind === 'advance') {
    const gateway = getGateway();
    if (!gateway.verifyPaymentSignature({
      orderId: body.gateway_order_id,
      paymentId: body.gateway_payment_id,
      signature: body.signature,
    })) {
      await markFailed({ txnId: own.rows[0].id, code: 'SIGNATURE_MISMATCH',
                         description: 'Signature verification failed' });
      throw fail(400,
        'We could not verify that payment. If money has left your account it will be returned '
        + 'automatically — please contact the workshop.');
    }

    let gatewayPayment = null;
    try { gatewayPayment = await gateway.fetchPayment(body.gateway_payment_id); }
    catch (err) { console.error('[advance] could not fetch payment detail:', err.message); }

    const { captureAdvance } = require('../services/advances.service');
    const out = await captureAdvance({
      txnId: own.rows[0].id,
      gatewayPaymentId: body.gateway_payment_id,
      gatewayPayment,
      via: 'callback',
    });
    return res.json({
      ok: true,
      amount: out.amount,
      // The receipt number, so the customer's confirmation screen carries the
      // same reference as the voucher they will be sent.
      reference: out.advance?.voucher_no || out.txn?.txn_ref || null,
      fully_paid: false,
    });
  }

  const result = await verifyCallback({
    gatewayOrderId: body.gateway_order_id,
    gatewayPaymentId: body.gateway_payment_id,
    signature: body.signature,
  });

  res.json({
    ok: true,
    amount: result.amount,
    reference: result.txn.txn_ref,
    fully_paid: result.invoice_status === 'paid',
  });
});

module.exports = { getPayPage, createPublicOrder, verifyPublicPayment };
