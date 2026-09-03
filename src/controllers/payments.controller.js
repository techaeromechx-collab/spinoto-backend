'use strict';

/**
 * Payments — HTTP layer. Validation, authorisation and shaping only; every
 * decision about money lives in services/payments.service.js.
 *
 * AUTHORISATION HAS TWO HALVES HERE, NOT ONE
 * ──────────────────────────────────────────
 * The route's requirePermission() is the first half. The second is the explicit
 * hub rejection in the handlers that must never run for a hub login.
 *
 * That is not belt-and-braces for its own sake. `requirePermissionOrHub` in
 * middleware/auth.middleware.js passes ANY hub user through — including one
 * with zero permission rows — and a hub login is the most permissive
 * configuration in this system, not the least. Payments touch the company's
 * bank account and its gateway credentials, so the rule is stated in the
 * handler where it cannot be lost by someone later swapping one middleware for
 * the other.
 *
 * Hub logins have no Payments screen today (the user's decision). The scoping
 * is written anyway — hubScopeSql on every list — so turning it on later is a
 * nav entry, not a security review.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { isHubUser, hubScopeSql } = require('../utils/hubScope');
const { buildSearchSql } = require('../utils/listSearch');
const { gatewayStatus, getGateway: getGatewayAdapter } = require('../services/gateway');
const {
  getSetting, settingSource, putSetting,
} = require('../services/integrationSettings.service');
const { logActivity } = require('../services/activityLog.service');
const {
  createInvoiceOrder, verifyCallback, createInvoiceQr, cancelInvoiceQr,
} = require('../services/payments.service');

const idParam = z.coerce.number().int().positive();

// Declared once so the list and the CSV export cannot drift apart — the same
// mistake the invoice screens had already made once, where an export silently
// searched different columns from the list it was exported from.
//
// txn_ref is searchable as free text rather than through idColumn: it is our
// own reference and people read it off a screen or a support email, so
// "PYMSR5..." must find its payment. The gateway's own payment id is
// deliberately NOT searchable — staff should be reaching for our reference, and
// making the provider's id a lookup key spreads it through the UI.
const PAY_SEARCH = {
  // reference_no joins the list because a manual payment has no txn_ref — the
  // thing a person reads off a cash receipt or a bank statement IS the
  // reference, and a search that could not find it would make every manual row
  // unreachable except by scrolling.
  // voucher_no and t.vehicle_number are here because an ADVANCE has neither a
  // txn_ref nor, usually, a reference_no — the one number printed on the
  // document the customer holds is ADV-2026-27-000003, and typing it returned
  // nothing under a box that says "reference, customer, vehicle or mobile".
  textColumns: ['t.txn_ref', 't.reference_no', 't.voucher_no', 't.mobile',
                'ci.customer_name', 't.vehicle_number', 'ci.vehicle_number'],
  idColumn: 't.entity_id',
  idPrefixes: ['ci', 'inv'],
};

// ─────────────────────────────────────────────────────────────────────────────
// ONE PAYMENTS LIST, TWO SOURCES
//
// This screen used to read payment_transactions alone, so it showed every
// online payment and no cash at all. "What did we collect today" answered with
// a number that silently excluded most of a workshop's actual takings — which
// is worse than not having the screen, because it looks complete.
//
// The fix is a UNION presented under the alias `t`, so the filter builder, the
// projection, the summary and the CSV export all keep working against one
// relation and cannot drift apart.
//
// WHAT THE TWO SIDES MEAN
// ───────────────────────
//   gateway  a payment ATTEMPT. Most rows never become money: a customer who
//            opens checkout and closes the tab leaves a 'created' row forever.
//   manual   money already received. A row exists only because somebody took
//            cash, a card or a transfer, so its status is 'captured' by
//            definition and there is no failure state to represent.
//
// That difference is why `status` is synthesised rather than left NULL for
// manual rows: the status filter, the KPI cards and the "Collected" sum all key
// on 'captured', and a NULL would drop every cash payment out of the totals
// this union exists to correct.
//
// `mode` is 'live' for manual rows for the same reason and with the same
// honesty: cash is not test money. A workshop running test gateway keys and
// taking real cash will see TEST tags on the former and not the latter, which
// is the true picture.
//
// txn_id / ledger_id are how the refund subquery finds the right rows without a
// second query. A manual row has no txn_id, so `rf.payment_transaction_id =
// t.txn_id` is NULL — never true — and gateway refunds cannot leak onto cash.
// ─────────────────────────────────────────────────────────────────────────────
const PAY_UNION = `(
  SELECT 'gateway'::text            AS kind,
         t.id                       AS txn_id,
         NULL::int                  AS ledger_id,
         'T' || t.id                AS row_key,
         t.txn_ref, t.status, t.mode, t.gateway,
         t.amount, t.currency, t.method_detail,
         NULL::varchar              AS reference_no,
         t.entity_type, t.entity_id, t.hub_id, t.mobile,
         t.gateway_payment_id, t.gateway_order_id, t.payment_link_id,
         t.error_code, t.error_description,
         t.qr_image_url, t.qr_expires_at,
         t.created_at, t.updated_at, t.created_by,
         NULL::text                 AS notes,
         NULL::varchar              AS voucher_no,
         NULL::varchar              AS vehicle_number,
         -- An advance is raised against an ESTIMATE, so that is where its
         -- customer's name comes from when no invoice exists yet.
         CASE WHEN t.entity_type = 'estimate' THEN t.entity_id END AS estimate_id,
         -- A gateway transaction is not a ledger row, so it has no allocation
         -- of its own — the ledger row it produces on capture carries that.
         -- NULL rather than 0 so "not applicable" and "nothing applied yet"
         -- stay distinguishable.
         NULL::numeric              AS allocated
    FROM payment_transactions t

  UNION ALL

  SELECT 'manual'::text             AS kind,
         NULL::int                  AS txn_id,
         cip.id                     AS ledger_id,
         'M' || cip.id              AS row_key,
         NULL::varchar              AS txn_ref,
         'captured'::varchar        AS status,
         'live'::varchar            AS mode,
         'manual'::varchar          AS gateway,
         cip.amount, 'INR'::varchar AS currency,
         cip.method                 AS method_detail,
         cip.reference_no,
         -- Was hard-coded 'customer_invoice' for EVERY manual row, which is false
         -- for an advance: its customer_invoice_id is NULL, so the list built an
         -- invoice label out of String(null) and printed "CI-00null".
         CASE WHEN cip.customer_invoice_id IS NOT NULL THEN 'customer_invoice'
              WHEN cip.estimate_id         IS NOT NULL THEN 'estimate'
              ELSE 'customer' END::varchar AS entity_type,
         cip.customer_invoice_id    AS entity_id,
         cip.hub_id,
         -- Was NULL, with the projection's COALESCE(t.mobile, ci.mobile) expected
         -- to fill it from the invoice. That works for an invoice payment and not
         -- for an advance, which has no invoice — so every advance and account
         -- credit on this screen was a sum of money attributed to nobody.
         cip.mobile,
         NULL::varchar              AS gateway_payment_id,
         NULL::varchar              AS gateway_order_id,
         NULL::int                  AS payment_link_id,
         NULL::varchar              AS error_code,
         NULL::text                 AS error_description,
         NULL::text                 AS qr_image_url,
         NULL::timestamptz          AS qr_expires_at,
         -- paid_at, not created_at: the list is ordered and date-filtered on
         -- when the money arrived, which for a backdated cash entry is not when
         -- somebody typed it in.
         cip.paid_at                AS created_at,
         cip.created_at             AS updated_at,
         cip.created_by,
         cip.notes,
         cip.voucher_no,
         cip.vehicle_number,
         cip.estimate_id,
         -- How much of this payment has been put against an invoice.
         --
         -- Today it always equals cip.amount, because every manual payment is
         -- allocated in full in the same transaction that records it. It stops
         -- being redundant the moment advances exist: a ₹2,000 advance with
         -- ₹1,500 applied is one row here showing 2000 received and 1500 used,
         -- and the ₹500 difference is the customer's credit. Selected now so
         -- the list does not need re-plumbing later.
         (SELECT COALESCE(SUM(al.amount), 0)
            FROM payment_allocations al
           WHERE al.ledger_payment_id = cip.id) AS allocated
    FROM customer_invoice_payments cip
   WHERE cip.source = 'manual'
) t`;

// One projection for the list, the detail drawer and the export. raw_response is
// absent on purpose: it can carry gateway internals and a support screen has no
// use for a JSON dump.
const PAY_SELECT = `
  SELECT t.row_key AS id, t.kind, t.txn_id, t.ledger_id,
         t.allocated,
         t.txn_ref, t.reference_no,
         t.qr_image_url, t.qr_expires_at,
         t.status, t.mode, t.gateway,
         t.amount, t.currency, t.method_detail,
         t.entity_type, t.entity_id, t.hub_id,
         -- The gateway row denormalises the mobile; a ledger row does not, so it
         -- comes from the invoice. COALESCE rather than dropping t.mobile: a
         -- transaction's mobile is what was captured at the time, and an invoice
         -- edited since should not rewrite it.
         COALESCE(t.mobile, ci.mobile) AS mobile,
         t.gateway_payment_id, t.gateway_order_id, t.payment_link_id,
         t.error_code, t.error_description,
         t.created_at, t.updated_at, t.notes,
         /* The same instant as created_at, already reduced to the IST CALENDAR
            DATE, for the CSV export.
            ────────────────────────────────────────────────────────────────────
            The export used to build this in Node, as
              new Date(created_at).toISOString().slice(0, 10)
            and toISOString ALWAYS renders UTC, whatever the process
            timezone, and IST is UTC+5:30 — so every instant before 05:30 IST
            came out as the previous day.

            That is not the rare night-time case it sounds like. A manual
            payment is entered as a DATE with no time, which Postgres stores as
            00:00 IST — and midnight IST is always the previous day in UTC. So
            EVERY hand-entered payment exported one day early: a payment taken
            on 27 Aug appeared in the file as 26 Aug.

            AT TIME ZONE 'Asia/Kolkata' rather than trusting the session's
            TimeZone. config/db.js does pin it on the connection, but this value
            is what an accountant reconciles a bank statement against; it should
            not depend on a setting one missed connection could drop.

            Added as its own column rather than casting created_at in place:
            created_at is returned to the payments SCREEN as a timestamptz and
            formatted in the browser, which is already correct. Changing its
            type would fix the export by breaking the list. */
         (t.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date_ist,
         t.voucher_no,
         u.name AS created_by_name,
         -- WHO THIS MONEY CAME FROM, in the order the answer is most reliable.
         --
         -- ci.customer_name alone was the whole of this, which quietly means
         -- "the name on the invoice this paid" — and an advance has no invoice,
         -- so it read as a row belonging to nobody. The estimate is next because
         -- an advance is taken against one; the customer profile after that; and
         -- last the earliest name anyone ever recorded against this number,
         -- which is the same rule getCustomer uses to title the profile page.
         --
         -- That final term is not redundant: a display_name is only set when
         -- somebody edits the customer, so for most people the only name in the
         -- system is the one typed on their first appointment. Without it the
         -- COALESCE ends at NULL for exactly the customers who have never been
         -- edited. COALESCE short-circuits, so it costs nothing on the rows the
         -- earlier terms already answered.
         COALESCE(
           ci.customer_name,
           e.customer_name,
           (SELECT NULLIF(TRIM(cp.display_name), '') FROM customer_profiles cp
             WHERE cp.mobile = t.mobile AND NOT COALESCE(cp.is_deleted, FALSE)),
           (SELECT n.customer_name FROM (
              SELECT ap.customer_name, ap.created_at FROM appointments ap
               WHERE ap.mobile = t.mobile AND ap.customer_name IS NOT NULL
              UNION ALL
              SELECT es.customer_name, es.created_at FROM estimates es
               WHERE es.mobile = t.mobile AND es.customer_name IS NOT NULL
              UNION ALL
              SELECT civ.customer_name, civ.created_at FROM customer_invoices civ
               WHERE civ.mobile = t.mobile AND civ.customer_name IS NOT NULL
            ) n ORDER BY n.created_at ASC LIMIT 1)
         ) AS customer_name,
         COALESCE(ci.vehicle_number, t.vehicle_number, e.vehicle_number) AS vehicle_number,
         ci.grand_total AS invoice_total,
         ci.status AS invoice_status, ci.public_token AS invoice_token,
         ('Spinoto ' || ar.name) AS hub_name,
         -- Matched on txn_id OR ledger_id. Both are NULL on the opposite side of
         -- the union, and NULL = NULL is not true, so neither can pick up the
         -- other's refunds.
         (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
           WHERE rf.status = 'processed'
             AND (rf.payment_transaction_id = t.txn_id
                  OR rf.ledger_payment_id = t.ledger_id)) AS refunded,

         -- WHICH INVOICES THIS MONEY REACHED.
         --
         -- The Invoice column used to read entity_id, which is the invoice a
         -- payment was TAKEN against — NULL for an advance, so an advance showed
         -- a dash even after its money had settled two invoices. That dash is
         -- what made people look for a separate "credit applied" row: the screen
         -- was saying the money had gone nowhere.
         --
         -- Allocations answer the other question — not what it was taken
         -- against, but what it paid for. NULL on a gateway row, whose
         -- ledger_id is NULL, so the two sides of the union stay distinct.
         -- The token comes along so each invoice named here can be opened
         -- directly. Without it the screen can print CI-000064 and not reach it:
         -- the invoice page is addressed by public_token, and t.invoice_token is
         -- the token of the invoice this payment was TAKEN against — which for
         -- an advance is no invoice at all.
         (SELECT json_agg(json_build_object('invoice_id', a.customer_invoice_id,
                                            'amount', a.amount,
                                            'token', aci.public_token)
                          ORDER BY a.created_at)
            FROM payment_allocations a
            LEFT JOIN customer_invoices aci ON aci.id = a.customer_invoice_id
           WHERE a.ledger_payment_id = t.ledger_id) AS allocations
    FROM ${PAY_UNION}
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN customer_invoices ci
           ON t.entity_type = 'customer_invoice' AND ci.id = t.entity_id
    -- Advances only: t.estimate_id is NULL on every other row, so this costs
    -- nothing on an ordinary invoice payment and is the only way an advance
    -- gets a customer name and a vehicle.
    LEFT JOIN estimates e ON e.id = t.estimate_id
    LEFT JOIN hubs h ON h.id = t.hub_id
    LEFT JOIN areas ar ON ar.id = h.area_id
`;

/**
 * Async wrapper matching the convention in customer_invoices.controller.js,
 * plus one addition: 42P01 (undefined_table). The payments tables arrive in
 * migrations 122–125, and until those are applied every endpoint here fails
 * with a bare 500 that reads like a code fault rather than a pending migration.
 * The same courtesy the invoice controller already extends for 42703.
 */
function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '42P01' && /payment_transactions|payment_links|payment_refunds/i.test(err.message || '')) {
      console.error('[payments] missing table — migrations not applied:', err.message);
      return res.status(503).json({
        error: 'Database is behind the code: the payments tables are missing. '
             + 'Run `npm run db:migrate` in backend/ to apply migrations 122–125.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err.code === '42703' && /gateway_qr_id|qr_image_url|qr_expires_at/i.test(err.message || '')) {
      console.error('[payments] missing column — migration 129 not applied:', err.message);
      return res.status(503).json({
        error: 'Database is behind the code: the QR payment columns are missing. '
             + 'Run `npm run db:migrate` in backend/ to apply migration 129.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err.code === '42703' && /payment_transaction_id|source/i.test(err.message || '')) {
      console.error('[payments] missing column — migration 125 not applied:', err.message);
      return res.status(503).json({
        error: 'Database is behind the code: the payment ledger columns are missing. '
             + 'Run `npm run db:migrate` in backend/ to apply migration 125.',
        code: 'MIGRATION_PENDING',
      });
    }
    next(err);
  });
}

/** Refuses a hub login outright. See the header for why this is not redundant. */
function denyHub(req, what = 'This') {
  if (isHubUser(req)) {
    throw Object.assign(
      new Error(`${what} is not available from the hub portal.`), { status: 403 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/order
// ─────────────────────────────────────────────────────────────────────────────
function createOrder(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Taking an online payment');

    const body = z.object({
      customer_invoice_id: idParam,
      // Optional part payment. The service clamps it to the real balance — this
      // schema only stops nonsense reaching it.
      amount: z.coerce.number().positive().optional().nullable(),
    }).parse(req.body || {});

    const { order } = await createInvoiceOrder({
      customerInvoiceId: body.customer_invoice_id,
      requestedAmount: body.amount ?? null,
      userId: req.user?.id || null,
    });

    // order.key_id is the gateway's PUBLIC key — designed to sit in a web page.
    // Nothing else about the credentials is in this response, and there is no
    // code path here that could add it.
    res.status(201).json(order);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/qr — a UPI QR the customer scans at the counter
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Same permission as createOrder, same hub rejection, same amount rules. A QR
 * is a way of taking a payment, not a different kind of authority.
 *
 * The response carries an image URL and an expiry and nothing else about the
 * gateway. The QR id is deliberately absent: the UI polls on txn_ref, our own
 * reference, exactly as the rest of the payments screen does.
 */
function createQr(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Taking a QR payment');

    const body = z.object({
      customer_invoice_id: idParam,
      amount: z.coerce.number().positive().optional().nullable(),
      // Minutes. Razorpay's own ceiling is 2 hours and the adapter clamps to
      // it; this schema stops a nonsense value reaching the gateway.
      expires_in_minutes: z.coerce.number().int().min(2).max(120).optional().nullable(),
    }).parse(req.body || {});

    const { qr } = await createInvoiceQr({
      customerInvoiceId: body.customer_invoice_id,
      requestedAmount: body.amount ?? null,
      userId: req.user?.id || null,
      ttlSeconds: body.expires_in_minutes ? body.expires_in_minutes * 60 : null,
    });

    res.status(201).json(qr);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/qr/:ref/cancel — staff closing an unpaid QR
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Closing the modal should not leave a live QR against the invoice: the
 * customer could still scan a code from a photo of the screen and pay an
 * amount the advisor has since changed.
 *
 * Returns 200 with captured:true when the customer paid while this was in
 * flight. That is not an error — it is the most ordinary race this feature has,
 * and the UI shows success rather than a failure message about a payment that
 * actually worked.
 */
function cancelQr(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Cancelling a QR payment');
    const ref = z.string().trim().min(3).max(40).parse(req.params.ref);

    // Hub scoping on the read, for the same reason every other handler carries
    // it: the screen is admin-only today and that must not be the only thing
    // standing between a hub login and another hub's payment.
    const params = [ref];
    const hubSql = hubScopeSql(req, params, 't.hub_id');
    const own = await pool.query(
      `SELECT t.id FROM payment_transactions t
        WHERE t.txn_ref = $1 ${hubSql ? `AND ${hubSql}` : ''}`, params);
    if (!own.rows[0]) return res.status(404).json({ error: 'Payment not found' });

    const result = await cancelInvoiceQr({ txnRef: ref, userId: req.user?.id || null });

    res.json({
      ok: true,
      cancelled: result.cancelled,
      captured: result.captured,
      status: result.txn?.status || null,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Advances — money taken before the invoice exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/advance
 *
 * Two behaviours behind one endpoint, chosen by `method`:
 *   'link'   opens a gateway payment link; nothing is money until the webhook
 *   anything else  records cash/UPI/card taken at the counter, immediately
 *
 * One endpoint rather than two because it is one act from the staff member's
 * point of view — "take ₹2,000 from this customer now" — and splitting it would
 * put the choice of instrument into the URL, where it does not belong.
 */
function createAdvance(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Taking an advance payment');

    const body = z.object({
      estimate_id: idParam,
      amount: z.coerce.number().positive(),
      method: z.enum(['link', 'cash', 'upi', 'card', 'bank_transfer', 'other']).default('link'),
      reference_no: z.string().trim().max(100).optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
      expires_in_days: z.coerce.number().int().min(1).max(90).optional().nullable(),
    }).parse(req.body || {});

    const svc = require('../services/advances.service');

    if (body.method === 'link') {
      const out = await svc.createAdvanceLink({
        estimateId: body.estimate_id,
        amount: body.amount,
        userId: req.user?.id || null,
        expiresInDays: body.expires_in_days,
      });
      // The same helper createPaymentLink uses — built from configuration, not
      // from this request's Host header, which a forwarded request could set to
      // somebody else's domain and land in a link staff are about to send.
      // null rather than a broken relative URL when nothing is configured; the
      // frontend falls back to its own origin, which is right in development.
      const { publicBaseUrl } = require('../utils/qr');
      const base = publicBaseUrl();
      return res.status(201).json({
        kind: 'link',
        token: out.link.token,
        url: base ? `${base}/pay/${out.link.token}` : null,
        amount: out.amount,
        gst_amount: out.gst_amount,
        expires_at: out.link.expires_at,
        txn_ref: out.txn.txn_ref,
        // No voucher number yet, and saying so matters: it is issued when the
        // customer actually pays, so an abandoned link leaves no gap in the
        // receipt series.
        voucher_no: null,
      });
    }

    const out = await svc.createManualAdvance({
      estimateId: body.estimate_id,
      amount: body.amount,
      method: body.method,
      referenceNo: body.reference_no || null,
      notes: body.notes || null,
      userId: req.user?.id || null,
    });
    res.status(201).json({
      kind: 'manual',
      payment_id: out.advance.id,
      amount: Number(out.advance.amount),
      gst_amount: Number(out.advance.gst_amount),
      voucher_no: out.advance.voucher_no,
      method: out.advance.method,
    });
  });
}

/**
 * POST /api/payments/apply-credit — put a customer's unused money on an invoice.
 *
 * ALLOCATE_PAYMENT, not COLLECT_PAYMENT. Nothing new arrives here; what changes
 * is WHERE money already received is counted, and putting it against the wrong
 * invoice makes one job look settled and another look unpaid.
 *
 * One call rather than one per credit row: the service does the whole thing in
 * a single transaction, so a browser closed halfway cannot leave an invoice
 * part-paid from three receipts and untouched by a fourth.
 */
function applyCustomerCredit(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Applying a customer\'s credit');

    const body = z.object({
      mobile: z.string().trim().min(6).max(20),
      customer_invoice_id: idParam,
      // Optional cap, for a part-application. Absent means "as much as this
      // invoice still owes".
      amount: z.coerce.number().positive().optional().nullable(),
    }).parse(req.body || {});

    const svc = require('../services/advances.service');
    const out = await svc.applyCustomerCredit({
      mobile: body.mobile,
      customerInvoiceId: body.customer_invoice_id,
      userId: req.user?.id || null,
      limit: body.amount ?? null,
    });

    const { readInvoiceBalance } = require('../services/invoiceBalance.service');
    const bal = await readInvoiceBalance(pool, body.customer_invoice_id);

    res.status(201).json({
      ...out,
      balance: bal,
      message: `₹${out.total.toFixed(2)} of credit applied.`,
    });
  });
}

/**
 * Does this session hold a permission, without being middleware about it?
 *
 * requirePermission is a gate on a whole route, and /receive cannot be gated
 * that way: whether it needs ALLOCATE_PAYMENT depends on what is in the body.
 * Taking ₹5,000 as credit is COLLECT_PAYMENT; the same ₹5,000 landing on three
 * invoices is also an allocation. One route, two different answers, decided per
 * request.
 *
 * Super admins pass everything, exactly as requirePermission has them do —
 * written here rather than assumed, because a copy of an authorisation rule
 * that quietly disagrees with the original is worse than no copy.
 */
function holds(req, ...codes) {
  if (!req.user) return false;
  if (req.user.is_super_admin) return true;
  return codes.some((c) => req.user.permissions.has(c));
}

/**
 * GET /api/payments/plan — where would this money go?
 *
 * The dialog's live preview. Read-only, and deliberately ADVISORY: the answer
 * can go stale the moment another advisor settles one of these invoices, so
 * nothing about it is binding. POST /receive re-runs the same planner inside
 * its own transaction rather than trusting whatever the browser last drew.
 *
 * ── denyHub, matching customerCredit ────────────────────────────────────────
 * The reply carries the customer's company-wide credit and names the invoices
 * at OTHER hubs that the automatic split declined to touch. Both are
 * company-level facts. A hub reading them would learn what a customer is
 * holding and owing at a competing hub, which is the exact thing
 * GET /credit/:mobile was closed for.
 */
function planPayment(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'The payment plan');

    const q = z.object({
      mobile: z.string().trim().min(6).max(20),
      // Zero is allowed and useful: an empty amount box should still show the
      // customer's credit and outstanding invoices rather than an error.
      amount: z.coerce.number().nonnegative().default(0),
      hub_id: z.coerce.number().int().positive().optional().nullable(),
      // NOT z.coerce.boolean(). Coercion is Boolean(value), and every non-empty
      // string is true — including the string "false", which is exactly what a
      // query string carries for an unticked box. The preview would have shown
      // the customer's credit being spent when nobody asked for it.
      use_credit: z.enum(['true', 'false', '1', '0', '']).optional()
        .transform(v => v === 'true' || v === '1'),
      // Invoices the user unticked, as "51,53,54". They take nothing AND pass
      // nothing to the invoice below them — see planAllocation's header.
      exclude: z.string().trim().max(400).optional()
        .transform(v => (v ? v.split(',').map(Number).filter(Number.isInteger) : null)),
    }).parse(req.query || {});

    const svc = require('../services/advances.service');
    const plan = await svc.planAllocation(pool, {
      mobile:    q.mobile,
      amount:    q.amount,
      hubId:     q.hub_id ?? null,
      useCredit: q.use_credit,
      excludeInvoiceIds: q.exclude,
    });

    // What the caller may actually do with this plan, so the dialog can grey
    // the right things instead of offering a path that ends in a 403.
    res.json({
      ...plan,
      can_allocate: holds(req, 'ALLOCATE_PAYMENT'),
      can_collect:  holds(req, 'COLLECT_PAYMENT'),
    });
  });
}

/**
 * POST /api/payments/receive — one payment in, wherever it belongs.
 *
 * The single entry point behind the merged Payment dialog. It replaces the
 * choice a user used to make BEFORE typing anything — Take Payment or Record
 * Payment — with a choice the amount makes for them.
 *
 * ── One payment row, many allocations ───────────────────────────────────────
 *
 * The money is recorded once. Where it lands is zero or more rows in
 * payment_allocations, written by advances.service.allocate — the same function
 * every other path already uses, so the invoice status recalculation, the hub
 * payout date, the appointment closing and the invoice.paid WhatsApp event all
 * happen for free and identically.
 *
 * ── Why the client does not decide the split ────────────────────────────────
 *
 * With `allocations` absent, the body carries an AMOUNT and nothing else, and
 * the planner runs again inside this transaction under the locks allocate()
 * takes. The preview the user was looking at is never trusted. That removes the
 * entire class of bug where somebody settles an invoice in the seconds between
 * a dialog opening and its Save button — there is no window to lose.
 *
 * With `allocations` present a human overrode the split on purpose, so it is
 * honoured — and validated line by line. If an invoice moved underneath them
 * the request FAILS and names it, rather than silently reallocating their money
 * somewhere they did not choose. Quietly doing something reasonable is the
 * wrong answer when the whole reason the list is there is that they had a
 * specific intention.
 *
 * ── Permissions, per decision 4 ─────────────────────────────────────────────
 *
 * COLLECT_PAYMENT gates the route: no permission, no money in. ALLOCATE_PAYMENT
 * is checked here, and only when the request actually allocates something —
 * putting money against an invoice or spending existing credit. Somebody who
 * may take a deposit but not settle invoices keeps working; they simply cannot
 * ask for the invoice branch.
 */
function receivePayment(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Receiving a payment');

    const body = z.object({
      mobile: z.string().trim().min(6).max(20),
      amount: z.coerce.number().positive(),
      method: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'other']).default('cash'),
      reference_no:   z.string().trim().max(100).optional().nullable(),
      vehicle_number: z.string().trim().max(30).optional().nullable(),
      notes:          z.string().trim().max(500).optional().nullable(),
      hub_id:     z.coerce.number().int().positive().optional().nullable(),
      use_credit: z.coerce.boolean().default(false),
      // null / absent = decide it for me. An empty ARRAY is not the same thing
      // and does not mean that: it means "allocate to nothing, keep it all as
      // credit", which is a real and different instruction.
      allocations: z.array(z.object({
        customer_invoice_id: idParam,
        amount: z.coerce.number().positive(),
      })).optional().nullable(),
      // Unticked in the dialog. Sent alongside `allocations: null`, because the
      // server still decides the split — it is just told which invoices are out
      // of it. Their share becomes credit rather than moving down the list.
      exclude_invoice_ids: z.array(idParam).max(200).optional().nullable(),
    }).parse(req.body || {});

    const svc = require('../services/advances.service');
    const wantsInvoices = body.allocations === undefined || body.allocations === null
      ? true                      // automatic: it will use invoices if there are any
      : body.allocations.length > 0;

    // ── Two different rights, kept apart ────────────────────────────────────
    //
    // NEW money landing on an invoice is what ADD_INVOICE_PAYMENT has always
    // meant — POST /customer-invoices/:id/payments is gated on exactly that,
    // and this endpoint is the same act with the invoice chosen for you.
    // Requiring ALLOCATE_PAYMENT here instead would take that away from
    // everyone who has it today, which is a regression wearing the costume of
    // a tightening.
    //
    // Spending money the customer ALREADY gave you is the other right, and it
    // is stricter on purpose: nothing arrives, what changes is where existing
    // money counts. That is ALLOCATE_PAYMENT and nothing else.
    if (wantsInvoices && !holds(req, 'ALLOCATE_PAYMENT', 'ADD_INVOICE_PAYMENT')) {
      throw Object.assign(new Error(
        'You can take money on this customer, but putting it against an invoice '
        + 'needs the Record Invoice Payment or Allocate Payment permission. '
        + 'Choose "Keep as credit" instead, or ask an administrator.'), { status: 403 });
    }
    if (body.use_credit && !holds(req, 'ALLOCATE_PAYMENT')) {
      throw Object.assign(new Error(
        'Spending credit the customer has already paid needs the Allocate Payment '
        + 'permission. Untick "use it too" to record just the new money.'), { status: 403 });
    }

    const out = await svc.receivePayment({
      mobile:        body.mobile,
      amount:        body.amount,
      method:        body.method,
      referenceNo:   body.reference_no || null,
      vehicleNumber: body.vehicle_number || null,
      notes:         body.notes || null,
      hubId:         body.hub_id ?? null,
      useCredit:     body.use_credit,
      allocations:   body.allocations ?? null,
      excludeInvoiceIds: body.exclude_invoice_ids ?? null,
      userId:        req.user?.id || null,
    });

    res.status(201).json(out);
  });
}

/**
 * POST /api/payments/account-credit — money from a customer, with no job.
 *
 * Separate from POST /advance, which takes a slice of a quoted total. The two
 * differ in what they can validate: that one has a ceiling and a destination,
 * this one has neither. Folding them into one endpoint with a nullable
 * estimate_id would hide exactly the difference that matters.
 *
 * Refuses outright until the GST rate has been configured — see
 * advances.service.accountCreditRate for why an unset rate is a refusal rather
 * than a default.
 */
function createAccountCredit(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Taking money on account');

    const body = z.object({
      mobile: z.string().trim().min(6).max(20),
      amount: z.coerce.number().positive(),
      method: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'other']).default('cash'),
      reference_no: z.string().trim().max(100).optional().nullable(),
      vehicle_number: z.string().trim().max(30).optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    }).parse(req.body || {});

    const svc = require('../services/advances.service');
    const out = await svc.createAccountCredit({
      mobile: body.mobile,
      amount: body.amount,
      method: body.method,
      referenceNo: body.reference_no || null,
      vehicleNumber: body.vehicle_number || null,
      notes: body.notes || null,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      kind: 'account_credit',
      payment_id: out.advance.id,
      amount: Number(out.advance.amount),
      gst_amount: Number(out.advance.gst_amount),
      gst_rate: Number(out.advance.gst_rate),
      voucher_no: out.advance.voucher_no,
      method: out.advance.method,
    });
  });
}

/**
 * GET /api/payments/account-credit/rate — is the feature switched on?
 *
 * The screen asks before offering the button, so an advisor is not shown a way
 * in that ends in a refusal.
 */
function accountCreditRate(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT advance_default_gst_rate FROM company_settings WHERE id = 1 LIMIT 1`);
    const rate = r.rows[0]?.advance_default_gst_rate;
    res.json({
      enabled: rate !== null && rate !== undefined,
      gst_rate: rate === null || rate === undefined ? null : Number(rate),
    });
  });
}

/**
 * GET /api/payments/advance/:id/voucher — the receipt voucher as a PDF.
 *
 * `id` is the LEDGER payment id, the same identifier the allocate route takes.
 * An advance paid in cash never had a gateway transaction, so there is no
 * txn_ref to address it by.
 *
 * 404 when the payment has no voucher number. That is not a missing document —
 * it is money that was never captured (a payment link nobody paid), and
 * rendering a receipt for it would state that money changed hands.
 */
function advanceVoucherPdf(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Advance receipt vouchers');

    const id = idParam.parse(req.params.id);
    const svc = require('../services/advances.service');
    const row = await svc.readReceiptVoucher(pool, { ledgerPaymentId: id });
    if (!row) return res.status(404).json({ error: 'Receipt voucher not found' });

    const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
    const company = await loadCompany();
    const { cfg, theme } = resolveRender(company, 'advance_receipt', req.user);

    await sendPdf(res, {
      docType: 'advance_receipt',
      row,
      company,
      cfg,
      theme,
      filename: `${row.voucher_no}${row.vehicle_number ? `_${row.vehicle_number}` : ''}.pdf`,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  });
}

/**
 * GET /api/payments/refund/:id/voucher — the refund voucher as a PDF.
 *
 * 404 until the refund is PROCESSED. A pending gateway refund has no number
 * because the money has not left yet, and a tax document saying it has is worse
 * than no document at all.
 */
function refundVoucherPdf(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Refund vouchers');

    const id = idParam.parse(req.params.id);
    const svc = require('../services/advances.service');
    const row = await svc.readRefundVoucher(pool, { refundId: id });
    if (!row) {
      return res.status(404).json({
        error: 'Refund voucher not available yet — it is issued once the refund reaches the customer.',
      });
    }

    const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
    const company = await loadCompany();
    const { cfg, theme } = resolveRender(company, 'advance_receipt', req.user);

    await sendPdf(res, {
      docType: 'advance_receipt',
      row,
      company,
      cfg,
      theme,
      filename: `${row.voucher_no}.pdf`,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  });
}

/**
 * POST /api/payments/advance/:id/refund — return unapplied advance money.
 *
 * Separate from POST /:ref/refund, which reverses a GATEWAY transaction by its
 * txn_ref. This one takes a ledger payment id, because an advance taken in cash
 * has no transaction to reverse — the money is handed back across the counter,
 * and the record is the only thing that has to be got right.
 *
 * The service decides what may be returned: only the part not yet applied to an
 * invoice, less anything already refunded or still in flight.
 */
function refundAdvancePayment(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Refunding an advance');

    const id = idParam.parse(req.params.id);
    const body = z.object({
      amount: z.coerce.number().positive(),
      // Same rule as the gateway refund path: a refund with no stated reason is
      // the one an audit asks about years later.
      reason: z.string().trim().min(3).max(500),
    }).parse(req.body || {});

    const svc = require('../services/advances.service');
    const refund = await svc.refundAdvance({
      ledgerPaymentId: id,
      amount: body.amount,
      reason: body.reason,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      refund,
      pending: refund.pending,
      message: refund.pending
        ? 'Refund requested. It usually reaches the customer in 5–7 working days, and the refund voucher is issued once the bank confirms it.'
        : `Refunded. Voucher ${refund.voucher_no}.`,
    });
  });
}

/**
 * POST /api/payments/:ref/allocate — apply received money to an invoice.
 *
 * Its own permission. Putting money against the wrong invoice is a different
 * error from taking a payment: it makes one invoice look settled and another
 * look unpaid, and unwinding it touches both.
 */
function allocatePayment(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Applying a payment to an invoice');
    const ref = z.string().trim().min(1).max(40).parse(req.params.ref);
    const body = z.object({
      customer_invoice_id: idParam,
      amount: z.coerce.number().positive().optional().nullable(),
    }).parse(req.body || {});

    // `ref` is a LEDGER payment id here, not a txn_ref — an advance taken in
    // cash never had a gateway transaction, so it has no txn_ref to be found by.
    const payId = Number(ref);
    if (!Number.isInteger(payId) || payId <= 0) throw Object.assign(new Error('Payment not found'), { status: 404 });

    const params = [payId];
    const hubSql = hubScopeSql(req, params, 'p.hub_id');
    const own = await pool.query(
      `SELECT p.id FROM customer_invoice_payments p
        WHERE p.id = $1 ${hubSql ? `AND ${hubSql}` : ''}`, params);
    if (!own.rows[0]) return res.status(404).json({ error: 'Payment not found' });

    const svc = require('../services/advances.service');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await svc.allocate(client, {
        ledgerPaymentId: payId,
        customerInvoiceId: body.customer_invoice_id,
        amount: body.amount ?? null,
        userId: req.user?.id || null,
      });
      await client.query('COMMIT');
      res.json({
        ok: true, applied: out.applied, remaining: out.remaining,
        invoice_status: out.state.status, invoice_balance: out.state.balance,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  });
}

/**
 * GET /api/payments/credit/:mobile — what this customer has not yet used.
 *
 * ── REFUSED FOR HUB LOGINS ──────────────────────────────────────────────────
 * This was the one read in this file with no hub handling at all — every
 * sibling applies hubScopeSql or denyHub. `creditFor` sums the customer's
 * unapplied advances across EVERY hub, so a hub that had seen the number on one
 * of its own jobs could read what that customer is holding company-wide,
 * including money taken at a competing hub.
 *
 * denyHub rather than a scoped variant, deliberately: credit is a
 * company-level balance, not a per-hub one. A hub-scoped figure would be a
 * different number wearing the same name — and the screens that spend credit
 * (allocate, apply-to-invoice) are already denyHub'd, so a hub has nothing to do
 * with the answer either way.
 */
function customerCredit(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Customer credit');
    const mobile = z.string().trim().min(6).max(20).parse(req.params.mobile);
    const svc = require('../services/advances.service');
    res.json({ mobile, credit: await svc.creditFor(pool, mobile) });
  });
}

/**
 * GET /api/payments/refunds — every refund, both kinds, in one list.
 *
 * ── WHY THIS HAD TO EXIST ───────────────────────────────────────────────────
 * A refund voucher is a tax document. Before this there was no screen that
 * could produce one: openRefundVoucher was linked from exactly one place, the
 * success panel of the refund dialog. Close it and the document was
 * unreachable. Worse for a gateway refund, where the voucher number is issued
 * by issueRefundVoucher from applyRefundOutcome — which runs from a webhook,
 * days later. The one button that linked it was shown at the one moment the
 * voucher did not yet exist.
 *
 * getPayment loads refunds too, but only through payment_transaction_id keyed
 * on txn_ref — so it covers gateway refunds alone. A CASH advance refund has no
 * txn_ref and appeared on no screen in the system at all.
 *
 * ── THE JOINS ARE LEFT JOINS, AND THAT IS THE WHOLE QUERY ──────────────────
 * A cash refund has ledger_payment_id and NO payment_transaction_id. A refund
 * against an ordinary invoice payment has the transaction and NO ledger link.
 * An INNER JOIN on either side silently drops one entire category — and the one
 * it drops is the category that has no other screen.
 *
 * ── NO denyHub ─────────────────────────────────────────────────────────────
 * This is a read, and a hub seeing its own refunds is correct. hubScopeSql
 * pins them to their own rows exactly as listPayments does.
 */
function listRefunds(req, res, next) {
  handle(req, res, next, async () => {
    const conditions = [];
    const params = [];

    const hubSql = hubScopeSql(req, params, 'rf.hub_id');
    if (hubSql) conditions.push(hubSql);

    if (req.query.status) {
      const wanted = String(req.query.status).split(',').map(x => x.trim()).filter(Boolean);
      if (wanted.length) {
        params.push(wanted);
        conditions.push(`rf.status = ANY($${params.length}::text[])`);
      }
    }
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`rf.created_at::date >= $${params.length}::date`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`rf.created_at::date <= $${params.length}::date`);
    }
    if (req.query.mobile) {
      params.push(String(req.query.mobile).trim());
      conditions.push(`cip.mobile = $${params.length}`);
    }
    if (req.query.q) {
      // One parameter used by four branches. The voucher number is what a
      // customer quotes back, so it has to match; the reason is what an
      // accountant searches six months later.
      params.push(`%${String(req.query.q).trim()}%`);
      const i = params.length;
      conditions.push(`(rf.voucher_no ILIKE $${i} OR cip.voucher_no ILIKE $${i}
                        OR pt.txn_ref ILIKE $${i} OR rf.reason ILIKE $${i})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10)));

    const r = await pool.query(
      `SELECT rf.id, rf.amount, rf.reason, rf.status, rf.created_at, rf.processed_at,
              rf.voucher_no, rf.gateway_refund_id, rf.error_description,
              rf.hub_id, rf.customer_invoice_id, rf.ledger_payment_id,
              rf.gst_amount, rf.gst_rate,
              cip.mobile, cip.voucher_no AS receipt_voucher_no, cip.payment_type,
              cip.public_token AS receipt_token,
              pt.txn_ref,
              u.name AS requested_by_name,
              -- Named however the record can name them: an advance carries the
              -- mobile but no customer name, so the profile is the only source
              -- for a refund that never touched an invoice.
              COALESCE(ci.customer_name, NULLIF(TRIM(cp.display_name), '')) AS customer_name,
              ('Spinoto ' || ar.name) AS hub_name
         FROM payment_refunds rf
         LEFT JOIN customer_invoice_payments cip ON cip.id = rf.ledger_payment_id
         LEFT JOIN payment_transactions      pt  ON pt.id  = rf.payment_transaction_id
         LEFT JOIN customer_invoices         ci  ON ci.id  = rf.customer_invoice_id
         LEFT JOIN customer_profiles         cp  ON cp.mobile = cip.mobile
         LEFT JOIN users u  ON u.id = rf.requested_by
         LEFT JOIN hubs  h  ON h.id = rf.hub_id
         LEFT JOIN areas ar ON ar.id = h.area_id
         ${where}
        ORDER BY rf.created_at DESC
        LIMIT ${limit}`,
      params);

    const total = r.rows.reduce(
      (s, x) => x.status === 'processed' ? s + Number(x.amount) : s, 0);

    res.json({
      items: r.rows,
      // Processed only. A pending refund has not left the account and a failed
      // one never will — summing all three would give a figure that matches no
      // bank statement.
      total_processed: Number(total.toFixed(2)),
    });
  });
}

/**
 * GET /api/payments/unallocated — money held against no invoice.
 *
 * The aged-advance list. Money sitting here for months is either a refund owed
 * or income to recognise, and neither answer is available if nobody can see it.
 */
// The unapplied-remainder arithmetic, imported rather than re-typed — see the
// comment on REMAINING_SQL in advances.service.js.
const { REMAINING_SQL } = require('../services/advances.service');

function listUnallocated(req, res, next) {
  handle(req, res, next, async () => {
    const params = [];
    const hubSql = hubScopeSql(req, params, 'p.hub_id');
    const r = await pool.query(
      `SELECT p.id, p.voucher_no, p.amount, p.gst_amount, p.method, p.paid_at,
              p.mobile, p.vehicle_number, p.estimate_id, p.appointment_id, p.source,
              -- ── THE REFUNDS TERM ────────────────────────────────────────
              -- This was the fifth copy of "what is left of this payment", and
              -- the one that forgot refunds. advances.service.REMAINING_SQL
              -- exists verbatim to stop that happening and says so in its own
              -- comment; it is imported here rather than re-typed.
              --
              -- Without it a fully-refunded advance still satisfied
              -- "amount > allocations", so it sat on the aged-advance tab for
              -- ever with days_held climbing — and the panel sums that column
              -- into the headline "money held against no invoice". The company's
              -- unapplied-advance liability was overstated by every refund ever
              -- made, which is the exact figure an accountant would either
              -- refund a second time or recognise as income.
              ${REMAINING_SQL} AS remaining,
              ('Spinoto ' || ar.name) AS hub_name,
              (NOW()::date - p.paid_at::date) AS days_held
         FROM customer_invoice_payments p
         LEFT JOIN hubs h  ON h.id = p.hub_id
         LEFT JOIN areas ar ON ar.id = h.area_id
        WHERE (${REMAINING_SQL}) > 0.011
          ${hubSql ? `AND ${hubSql}` : ''}
        ORDER BY p.paid_at ASC`, params);
    res.json({ items: r.rows });
  });
}

/** GET /api/payments/for-customer/:mobile — the customer Payments tab. */
function listForCustomer(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = z.string().trim().min(6).max(20).parse(req.params.mobile);
    const params = [mobile];
    const hubSql = hubScopeSql(req, params, 'p.hub_id');
    const r = await pool.query(
      `SELECT p.id, p.voucher_no, p.amount, p.gst_amount, p.method, p.reference_no,
              p.paid_at, p.notes, p.source, p.payment_type,
              p.estimate_id, p.appointment_id, p.customer_invoice_id,
              p.vehicle_number,
              -- The customer's own link to their receipt voucher. Returned so
              -- an advisor can copy and send it again without asking anyone to
              -- dig the original WhatsApp message out.
              p.public_token,
              pt.txn_ref,
              u.name AS created_by_name,
              ('Spinoto ' || ar.name) AS hub_name,
              COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                         WHERE a.ledger_payment_id = p.id), 0) AS allocated,
              -- ── WHAT HAS BEEN GIVEN BACK ────────────────────────────────
              -- Absent until now, and the row was unreadable without it: a
              -- ₹50,000 advance refunded in full still showed ₹50,000 unused,
              -- still offered a Refund button, and said nothing anywhere about
              -- the money having gone back. The screen looked exactly as it did
              -- before the refund.
              --
              -- Split into processed and pending on purpose. They are different
              -- facts: processed money has left, pending money is on its way and
              -- can still fail. Both stop the amount being spendable — which is
              -- why REMAINING_SQL counts both — but only one of them is final,
              -- and a row that says "refunded" about a refund that later fails
              -- would be worse than one that says nothing.
              COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                         WHERE rf.ledger_payment_id = p.id
                           AND rf.status = 'processed'), 0) AS refunded,
              COALESCE((SELECT SUM(rf.amount) FROM payment_refunds rf
                         WHERE rf.ledger_payment_id = p.id
                           AND rf.status = 'pending'), 0) AS refund_pending,
              (SELECT MAX(rf.processed_at) FROM payment_refunds rf
                WHERE rf.ledger_payment_id = p.id AND rf.status = 'processed') AS refunded_at,
              -- The numbered credit note, when one was issued. It is what the
              -- customer was given, so it is what they will quote back.
              --
              -- The id comes back beside it because openRefundVoucher takes the
              -- REFUND's id, not the payment's — without this the row can name
              -- the document and still not open it.
              (SELECT rf.id FROM payment_refunds rf
                WHERE rf.ledger_payment_id = p.id AND rf.voucher_no IS NOT NULL
                ORDER BY rf.id DESC LIMIT 1) AS refund_id,
              (SELECT rf.voucher_no FROM payment_refunds rf
                WHERE rf.ledger_payment_id = p.id AND rf.voucher_no IS NOT NULL
                ORDER BY rf.id DESC LIMIT 1) AS refund_voucher_no,
              -- The invoices this money actually reached. An advance split
              -- across two jobs shows both, which one column could not.
              (SELECT json_agg(json_build_object('invoice_id', a.customer_invoice_id, 'amount', a.amount)
                               ORDER BY a.created_at)
                 FROM payment_allocations a WHERE a.ledger_payment_id = p.id) AS allocations
         FROM customer_invoice_payments p
         LEFT JOIN payment_transactions pt ON pt.id = p.payment_transaction_id
         LEFT JOIN users u  ON u.id = p.created_by
         LEFT JOIN hubs h   ON h.id = p.hub_id
         LEFT JOIN areas ar ON ar.id = h.area_id
        WHERE p.mobile = $1 ${hubSql ? `AND ${hubSql}` : ''}
        ORDER BY p.paid_at DESC, p.id DESC`, params);
    res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify — what the browser calls after checkout
// ─────────────────────────────────────────────────────────────────────────────
function verifyPayment(req, res, next) {
  handle(req, res, next, async () => {
    const body = z.object({
      gateway_order_id:   z.string().trim().min(1).max(100),
      gateway_payment_id: z.string().trim().min(1).max(100),
      signature:          z.string().trim().max(200).optional().nullable(),
    }).parse(req.body || {});

    const result = await verifyCallback({
      gatewayOrderId: body.gateway_order_id,
      gatewayPaymentId: body.gateway_payment_id,
      signature: body.signature,
    });

    res.json({
      ok: true,
      // `duplicate` is not an error. The webhook may well have got here first,
      // and the customer should see success either way.
      duplicate: result.duplicate,
      txn_ref: result.txn.txn_ref,
      amount: result.amount,
      invoice_id: result.invoice_id,
      invoice_status: result.invoice_status,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/for-invoice/:id — the invoice screen's Payments tab
// ─────────────────────────────────────────────────────────────────────────────
function listForInvoice(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    // Hub logins have no payments screen, but this endpoint is scoped anyway so
    // that enabling one later cannot accidentally expose another hub's money.
    const params = [id];
    const hubSql = hubScopeSql(req, params, 't.hub_id');

    const r = await pool.query(
      `SELECT t.id, t.txn_ref, t.status, t.amount, t.currency, t.mode,
              t.method_detail, t.gateway_payment_id, t.error_code, t.error_description,
              t.created_at, t.updated_at,
              u.name AS created_by_name,
              (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
                WHERE rf.payment_transaction_id = t.id AND rf.status = 'processed') AS refunded
         FROM payment_transactions t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.entity_type = 'customer_invoice' AND t.entity_id = $1
          ${hubSql ? `AND ${hubSql}` : ''}
        ORDER BY t.created_at DESC`,
      params
    );
    res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared filter builder for the list, the summary and the export.
//
// One function, so a filter that narrows the list narrows the totals above it
// too. Three copies of this is how a screen ends up showing 12 transactions
// under a heading that says 47.
// ─────────────────────────────────────────────────────────────────────────────
const listQuery = z.object({
  status:    z.string().trim().max(30).optional(),
  // 'manual' = cash / UPI / card / transfer recorded by hand.
  // 'gateway' = taken through Razorpay. Absent = both, which is the point.
  source:    z.enum(['manual', 'gateway']).optional(),
  mode:      z.enum(['test', 'live']).optional(),
  method:    z.string().trim().max(30).optional(),
  hub_ids:   z.string().trim().max(200).optional(),
  date_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to:   z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search:    z.string().trim().max(200).optional(),
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(200).default(50),
}).partial({ page: true, limit: true });

function buildFilters(req, q) {
  const params = [];
  const where = [];

  // Hub scoping FIRST, and it replaces the query-string filter rather than
  // combining with it. utils/hubScope.js explains why an override cannot widen
  // where an intersection might. Hubs have no Payments screen today; this is
  // here so that turning one on is a nav change and not a security review.
  const hubSql = hubScopeSql(req, params, 't.hub_id');
  if (hubSql) {
    where.push(hubSql);
  } else if (q.hub_ids) {
    const ids = q.hub_ids.split(',').map(s => parseInt(s, 10)).filter(Number.isInteger);
    if (ids.length) { params.push(ids); where.push(`t.hub_id = ANY($${params.length}::int[])`); }
  }

  if (q.status) {
    const list = q.status.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) { params.push(list); where.push(`t.status = ANY($${params.length}::text[])`); }
  }
  if (q.source) { params.push(q.source); where.push(`t.kind = $${params.length}`); }
  if (q.mode)   { params.push(q.mode);   where.push(`t.mode = $${params.length}`); }
  if (q.method) { params.push(q.method); where.push(`t.method_detail = $${params.length}`); }

  // ::date on the LEFT would defeat the index on created_at. Comparing against
  // a date boundary keeps it usable; +1 day on the upper bound makes date_to
  // inclusive, which is what a person picking "to 5 Aug" means.
  if (q.date_from) { params.push(q.date_from); where.push(`t.created_at >= $${params.length}::date`); }
  if (q.date_to)   { params.push(q.date_to);   where.push(`t.created_at < ($${params.length}::date + INTERVAL '1 day')`); }

  const searchSql = buildSearchSql({ search: q.search, params, ...PAY_SEARCH });
  if (searchSql) where.push(searchSql);

  return { params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments
// ─────────────────────────────────────────────────────────────────────────────
function listPayments(req, res, next) {
  handle(req, res, next, async () => {
    const q = listQuery.parse(req.query || {});
    const { params, whereSql } = buildFilters(req, q);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM ${PAY_UNION}
         LEFT JOIN customer_invoices ci
                ON t.entity_type = 'customer_invoice' AND ci.id = t.entity_id
        ${whereSql}`, params);

    const p2 = [...params, q.limit, (q.page - 1) * q.limit];
    // row_key, not id: `id` is no longer unique across the union — a gateway
    // transaction and a ledger row can both be 41. row_key is 'T41' and 'M41',
    // which also makes the ordering stable rather than interleaving two
    // sequences that happen to overlap.
    const rows = await pool.query(
      `${PAY_SELECT} ${whereSql}
        ORDER BY t.created_at DESC, t.row_key DESC
        LIMIT $${p2.length - 1} OFFSET $${p2.length}`, p2);

    res.json({
      items: rows.rows,
      total: countRes.rows[0].total,
      page: q.page,
      limit: q.limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/summary — the Overview cards
// ─────────────────────────────────────────────────────────────────────────────
function paymentsSummary(req, res, next) {
  handle(req, res, next, async () => {
    const q = listQuery.parse(req.query || {});
    const { params, whereSql } = buildFilters(req, q);

    // One pass, aggregated in the database.
    //
    // Not "fetch a page and add it up in JavaScript" — the staff dashboard
    // already has money cards that sum a single 200-row page and quietly
    // understate every total past the first page. Doing this over a filtered
    // set with no LIMIT is the only way the number on the card is the number.
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS attempts,
         COUNT(*) FILTER (WHERE t.status = 'captured')::int AS captured_count,
         -- Failure and abandonment are GATEWAY lifecycle states. A manual row
         -- exists only because money was taken, so it has neither — and
         -- counting cash among "successful attempts" would inflate a success
         -- rate that is supposed to describe how often checkout works.
         COUNT(*) FILTER (WHERE t.kind = 'gateway' AND t.status = 'captured')::int AS gateway_captured,
         COUNT(*) FILTER (WHERE t.kind = 'gateway' AND t.status = 'failed')::int   AS failed_count,
         COUNT(*) FILTER (WHERE t.kind = 'gateway' AND t.status IN ('created','attempted'))::int AS pending_count,
         COALESCE(SUM(t.amount) FILTER (
           WHERE t.status IN ('captured','refunded','partially_refunded')), 0) AS collected,
         -- The same total split by where the money came from, so "we took
         -- ₹84,000" can be read as "₹51,000 of it in cash" without running a
         -- second query against a different filter.
         COALESCE(SUM(t.amount) FILTER (
           WHERE t.kind = 'manual' AND t.status = 'captured'), 0) AS collected_manual,
         COALESCE(SUM(t.amount) FILTER (
           WHERE t.kind = 'gateway'
             AND t.status IN ('captured','refunded','partially_refunded')), 0) AS collected_online,
         -- Refunds summed per row and then aggregated, rather than through a
         -- second copy of the WHERE clause. Repeating the filter would mean
         -- repeating its placeholders and passing every parameter twice, which
         -- is exactly the kind of thing that works until someone adds a filter.
         COALESCE(SUM(
           (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
             WHERE rf.status = 'processed'
               AND (rf.payment_transaction_id = t.txn_id
                    OR rf.ledger_payment_id = t.ledger_id))
         ), 0) AS refunded
         FROM ${PAY_UNION}
         LEFT JOIN customer_invoices ci
                ON t.entity_type = 'customer_invoice' AND ci.id = t.entity_id
        ${whereSql}`,
      params
    );

    const s = r.rows[0];
    const collected = Number(s.collected);
    const refunded = Number(s.refunded);
    res.json({
      attempts: s.attempts,
      captured_count: s.captured_count,
      failed_count: s.failed_count,
      pending_count: s.pending_count,
      collected,
      collected_manual: Number(s.collected_manual),
      collected_online: Number(s.collected_online),
      refunded,
      net: Number((collected - refunded).toFixed(2)),
      // Of the GATEWAY attempts that reached a conclusion. Counting orders
      // nobody ever opened as failures makes the rate meaningless, and so does
      // counting cash — which cannot fail — as a success.
      success_rate: (s.gateway_captured + s.failed_count) > 0
        ? Number((s.gateway_captured * 100 / (s.gateway_captured + s.failed_count)).toFixed(1))
        : null,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/by-hub — what each hub collected, over the same filters
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The query hub_id on the ledger exists to make possible.
 *
 * Before migration 131 this could only be answered for online payments, because
 * only payment_transactions carried a hub. Cash had to be reached through the
 * invoice, which meant a different query with a different set of joins — so in
 * practice nobody asked.
 *
 * Grouped in the database over the whole filtered set, not a page of it: the
 * mistake this codebase has already made once is summing a 200-row page and
 * presenting it as a total.
 */
function paymentsByHub(req, res, next) {
  handle(req, res, next, async () => {
    const q = listQuery.parse(req.query || {});
    const { params, whereSql } = buildFilters(req, q);

    const r = await pool.query(
      `SELECT t.hub_id,
              COALESCE('Spinoto ' || ar.name, 'No hub') AS hub_name,
              COUNT(*) FILTER (WHERE t.status = 'captured')::int AS payments,
              COALESCE(SUM(t.amount) FILTER (
                WHERE t.status IN ('captured','refunded','partially_refunded')), 0) AS collected,
              COALESCE(SUM(t.amount) FILTER (
                WHERE t.kind = 'manual' AND t.status = 'captured'), 0) AS collected_manual,
              COALESCE(SUM(t.amount) FILTER (
                WHERE t.kind = 'gateway'
                  AND t.status IN ('captured','refunded','partially_refunded')), 0) AS collected_online
         FROM ${PAY_UNION}
         LEFT JOIN customer_invoices ci
                ON t.entity_type = 'customer_invoice' AND ci.id = t.entity_id
         LEFT JOIN hubs h  ON h.id = t.hub_id
         LEFT JOIN areas ar ON ar.id = h.area_id
        ${whereSql}
        GROUP BY t.hub_id, ar.name
        ORDER BY collected DESC`,
      params
    );

    res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:ref — the detail drawer, by OUR reference
// ─────────────────────────────────────────────────────────────────────────────
function getPayment(req, res, next) {
  handle(req, res, next, async () => {
    const ref = z.string().trim().min(3).max(40).parse(req.params.ref);

    const params = [ref];
    const hubSql = hubScopeSql(req, params, 't.hub_id');
    const r = await pool.query(
      `${PAY_SELECT} WHERE t.txn_ref = $1 ${hubSql ? `AND ${hubSql}` : ''}`, params);
    const txn = r.rows[0];
    // 404, not 403, when a hub asks for another hub's payment — a 403 confirms
    // the row exists and turns enumeration into a census. Same reasoning as
    // assertHubOwns in utils/hubScope.js.
    if (!txn) return res.status(404).json({ error: 'Payment not found' });

    // txn.txn_id, NOT txn.id.
    //
    // PAY_SELECT's `id` is now the union's row_key — 'T41', a string — because
    // a transaction and a ledger row can both be numbered 41. The integer these
    // two lookups need is txn_id. Passing the row_key here would send 'T41'
    // into an integer column and produce a 22P02 on the one screen a person
    // opens when a payment has already gone wrong.
    //
    // This handler only ever matches gateway rows (a manual row has no
    // txn_ref), so txn_id is always present.
    const refunds = await pool.query(
      `SELECT rf.id, rf.amount, rf.reason, rf.status, rf.gateway_refund_id,
              rf.created_at, rf.processed_at, rf.error_description,
              u.name AS requested_by_name
         FROM payment_refunds rf
         LEFT JOIN users u ON u.id = rf.requested_by
        WHERE rf.payment_transaction_id = $1
        ORDER BY rf.created_at DESC`, [txn.txn_id]);

    // The webhook trail. This is the answer to "did we ever hear about this?",
    // which is the first question on every payment support ticket.
    const events = await pool.query(
      `SELECT event_type, status, received_at, processed_at, error_text
         FROM payment_webhook_events
        WHERE payment_transaction_id = $1 OR gateway_payment_id = $2
        ORDER BY received_at DESC LIMIT 20`,
      [txn.txn_id, txn.gateway_payment_id]);

    res.json({ item: { ...txn, refunds: refunds.rows, events: events.rows } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/export — CSV
// ─────────────────────────────────────────────────────────────────────────────
function exportPayments(req, res, next) {
  handle(req, res, next, async () => {
    const q = listQuery.parse(req.query || {});
    const { params, whereSql } = buildFilters(req, q);

    // Capped rather than unbounded: an export is built entirely in memory here,
    // and a request with no filters would otherwise stream the whole history
    // through the Node heap.
    const rows = await pool.query(
      `${PAY_SELECT} ${whereSql} ORDER BY t.created_at DESC LIMIT 5000`, params);

    const header = ['Reference', 'Source', 'Date', 'Status', 'Mode', 'Amount', 'Refunded',
                    'Method', 'Customer', 'Mobile', 'Vehicle', 'Invoice', 'Hub',
                    'Gateway Payment ID', 'Taken by', 'Error'];
    const lines = [header.join(',')];
    for (const r of rows.rows) {
      lines.push([
        // A manual payment has no txn_ref; what an accountant reconciles it
        // against is the reference somebody typed off the receipt.
        r.txn_ref || r.reference_no || '',
        r.kind === 'manual' ? 'Manual' : 'Online',
        // date_ist, NOT new Date(created_at).toISOString() — see PAY_SELECT.
        // Postgres has already reduced the instant to its IST calendar date;
        // re-deriving it in Node is what put every manual payment a day early.
        r.date_ist || '',
        r.status, r.mode, r.amount, r.refunded,
        r.method_detail || '',
        r.customer_name || '',
        // Already masked for hub sessions by the router's middleware, which
        // wraps res.json — so it is applied deliberately here rather than
        // relied on, because a CSV does not go through res.json.
        maskIfHub(req, r.mobile),
        r.vehicle_number || '',
        r.entity_type === 'customer_invoice' ? `CI-${String(r.entity_id).padStart(6, '0')}` : '',
        r.hub_name || '',
        r.gateway_payment_id || '',
        r.created_by_name || '',
        r.error_description || '',
      ].map(csvCell).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send('﻿' + lines.join('\n'));   // BOM so Excel reads UTF-8
  });
}

function csvCell(v) {
  const s = String(v ?? '');
  // A leading =, +, - or @ makes Excel evaluate the cell as a formula, which is
  // how a customer name becomes a command. Prefixed with a quote, as elsewhere
  // in this codebase's exports.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function maskIfHub(req, mobile) {
  if (!isHubUser(req)) return mobile || '';
  const { maskMobile } = require('../utils/maskMobile');
  return maskMobile(mobile) || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment links
// ─────────────────────────────────────────────────────────────────────────────
/**
 * How long a payment link lives when the caller does not say.
 *
 * A function rather than a constant, for the same reason the gateway keys are:
 * it is settable from the Gateway screen, and a constant read at import time
 * would mean the screen accepted a new number and every link kept using the old
 * one until a restart.
 *
 * Clamped to the same 1–90 window the request schema enforces. A saved value of
 * 0, or "seven", or 400 must not produce a link that expires immediately or
 * never — a bad setting falls back to 7 rather than becoming a liability.
 */
const LINK_TTL_DEFAULT = 7;
function linkTtlDays() {
  const n = Number(getSetting('payment_link_ttl_days'));
  if (!Number.isFinite(n)) return LINK_TTL_DEFAULT;
  const i = Math.trunc(n);
  return i >= 1 && i <= 90 ? i : LINK_TTL_DEFAULT;
}

function createPaymentLink(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Creating a payment link');

    const body = z.object({
      customer_invoice_id: idParam,
      // Capped at 90 days. An immortal payment URL is a liability, and the cap
      // is here rather than only in the UI because this endpoint is the one
      // that matters.
      expires_in_days: z.coerce.number().int().min(1).max(90).default(linkTtlDays()),
      notes: z.string().trim().max(500).optional().nullable(),
    }).parse(req.body || {});

    const { readInvoiceBalance } = require('../services/invoiceBalance.service');
    const inv = await readInvoiceBalance(pool, body.customer_invoice_id);
    if (!inv) return res.status(404).json({ error: 'Customer invoice not found' });
    if (inv.status === 'cancelled') {
      return res.status(409).json({ error: 'This invoice has been cancelled.' });
    }
    if (inv.balance <= 0.01) {
      return res.status(409).json({ error: 'This invoice is already fully paid.' });
    }

    // withTokenRetry rather than a bare insert: the token column is unique, and
    // regenerating on a 23505 keeps this correct rather than assuming a
    // collision is impossible. Same helper every other public token uses.
    const { withTokenRetry } = require('../utils/publicToken');
    const row = await withTokenRetry(token => pool.query(
      `INSERT INTO payment_links
         (token, entity_type, entity_id, hub_id, amount, status, expires_at, notes, created_by)
       VALUES ($1,'customer_invoice',$2,$3,$4,'active', NOW() + ($5 || ' days')::interval, $6,$7)
       RETURNING *`,
      [token, inv.id, inv.hub_id, inv.balance,
       String(body.expires_in_days), body.notes || null, req.user?.id || null]
    ).then(r => r.rows[0]));

    // publicBaseUrl() from utils/qr.js — the SAME helper that builds the QR on
    // every printed invoice and the links WhatsApp sends. Reused rather than
    // reading an env var here, so a payment link can never point at a different
    // host from the invoice QR the customer scanned an hour earlier.
    //
    // It resolves PUBLIC_APP_URL, falling back to APP_URL then FRONTEND_URL,
    // and is built from configuration — never from this request's Host header,
    // which a forwarded request could set to an attacker's domain and land in a
    // link staff are about to send to a customer.
    const { publicBaseUrl } = require('../utils/qr');
    const base = publicBaseUrl();
    res.status(201).json({
      link: row,
      // null, not a broken relative URL, when nothing is configured — the
      // frontend falls back to its own origin, which is right in development.
      url: base ? `${base}/pay/${row.token}` : null,
    });
  });
}

function listPaymentLinks(req, res, next) {
  handle(req, res, next, async () => {
    const q = z.object({
      customer_invoice_id: z.coerce.number().int().positive().optional(),
      status: z.string().trim().max(20).optional(),
    }).parse(req.query || {});

    const params = [];
    const where = [];
    const hubSql = hubScopeSql(req, params, 'l.hub_id');
    if (hubSql) where.push(hubSql);
    if (q.customer_invoice_id) {
      params.push(q.customer_invoice_id);
      where.push(`l.entity_id = $${params.length} AND l.entity_type = 'customer_invoice'`);
    }
    if (q.status) { params.push(q.status); where.push(`l.status = $${params.length}`); }

    const r = await pool.query(
      `SELECT l.id, l.token, l.entity_id, l.amount, l.status, l.expires_at,
              l.opened_count, l.last_opened_at, l.notes, l.created_at,
              u.name AS created_by_name,
              ci.customer_name, ci.status AS invoice_status,
              -- Evaluated at read time rather than trusted from the column: a
              -- link that lapsed while nobody was looking still reads as
              -- expired, without needing a sweep to have run.
              (l.status = 'active' AND l.expires_at < NOW()) AS is_expired
         FROM payment_links l
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN customer_invoices ci ON ci.id = l.entity_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.created_at DESC
        LIMIT 200`, params);

    res.json({ items: r.rows });
  });
}

function cancelPaymentLink(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Cancelling a payment link');
    const id = idParam.parse(req.params.id);

    // Only an active link can be cancelled. Re-cancelling a paid one would
    // rewrite history to say the money was never collected through it.
    const r = await pool.query(
      `UPDATE payment_links SET status='cancelled', updated_at=NOW()
        WHERE id = $1 AND status = 'active' RETURNING *`, [id]);
    if (!r.rows[0]) {
      return res.status(409).json({ error: 'That link is not active, so there is nothing to cancel.' });
    }
    res.json({ link: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/:ref/refund
// ─────────────────────────────────────────────────────────────────────────────
function refundPayment(req, res, next) {
  handle(req, res, next, async () => {
    // Refusing hub sessions here as well as at the route is the point of
    // denyHub — a refund moves real money out of the company's account, and
    // that rule should not be one middleware swap away from disappearing.
    denyHub(req, 'Refunding a payment');

    const ref = z.string().trim().min(3).max(40).parse(req.params.ref);
    const body = z.object({
      amount: z.coerce.number().positive(),
      // Enforced here, in the schema, and NOT NULL in the table. A refund with
      // no stated reason is the one an audit asks about years later.
      reason: z.string().trim().min(3).max(500),
    }).parse(req.body || {});

    const t = await pool.query(
      `SELECT t.id, t.entity_type,
              (SELECT p.id FROM customer_invoice_payments p
                WHERE p.payment_transaction_id = t.id AND p.payment_type = 'advance'
                LIMIT 1) AS advance_ledger_id
         FROM payment_transactions t WHERE t.txn_ref = $1`, [ref]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Payment not found' });

    // ── AN ADVANCE IS NOT REFUNDED THROUGH THIS PATH ────────────────────────
    //
    // This endpoint used to look a transaction up by txn_ref with no regard for
    // what kind of money it was, and hand it straight to requestRefund. For a
    // gateway ADVANCE that skipped every guard refundAdvance exists to apply:
    //
    //   · the ceiling became the WHOLE payment instead of the UNALLOCATED part,
    //     so an advance that had already settled an invoice could be refunded in
    //     full — money out, invoice still PAID, hub payout still scheduled;
    //   · ledger_payment_id was left NULL, so REMAINING_SQL never subtracted the
    //     refund and the same credit stayed spendable afterwards;
    //   · and no refund voucher was issued, so real money left with no numbered
    //     tax document.
    //
    // It is reachable from the UI — PaymentDrawer's Refund button gates on
    // status only. Routed to the correct function rather than blocked, because
    // "refund this" is a reasonable thing to click on an advance; it just has to
    // go through the code that understands what an advance is.
    const svc = require('../services/advances.service');
    if (t.rows[0].advance_ledger_id) {
      const refund = await svc.refundAdvance({
        ledgerPaymentId: t.rows[0].advance_ledger_id,
        amount: body.amount,
        reason: body.reason,
        userId: req.user?.id || null,
      });
      return res.status(201).json({ refund, advance: true });
    }

    const { requestRefund } = require('../services/refunds.service');
    const refund = await requestRefund({
      txnId: t.rows[0].id,
      amount: body.amount,
      reason: body.reason,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      refund,
      // The state that gets misread. The invoice has NOT moved yet and will not
      // until the gateway confirms, so the response says so rather than leaving
      // the UI to guess from a status string.
      pending: refund.status === 'pending',
      message: refund.status === 'processed'
        ? 'Refund completed.'
        : 'Refund requested. It usually reaches the customer in 5–7 working days, and the invoice balance changes only once the bank confirms it.',
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlements — read-only reconciliation
//
// A settlement is the gateway moving its accumulated balance into the company
// bank account: one transfer covering many payments, days later, net of fees.
// It is NOT revenue and it is NOT a payment. Nothing here creates or edits one
// — rows are fetched from the gateway, because a hand-typed settlement is a
// number that agrees with nothing.
// ─────────────────────────────────────────────────────────────────────────────
function listSettlements(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Settlements');

    const q = z.object({
      date_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to:   z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query || {});

    const params = [];
    const where = [];
    if (q.date_from) { params.push(q.date_from); where.push(`s.settled_at >= $${params.length}::date`); }
    if (q.date_to)   { params.push(q.date_to);   where.push(`s.settled_at < ($${params.length}::date + INTERVAL '1 day')`); }

    const r = await pool.query(
      `SELECT s.*,
              -- Gross is derived, not stored: it must always equal what the
              -- gateway says landed plus what it says it kept, and a stored
              -- copy is one more thing that can disagree.
              (s.amount + s.fees + s.tax) AS gross,
              (SELECT COUNT(*)::int FROM payment_transactions t
                WHERE t.settlement_id = s.id) AS payment_count
         FROM payment_settlements s
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.settled_at DESC NULLS LAST, s.id DESC
        LIMIT 200`, params);

    res.json({ items: r.rows });
  });
}

/**
 * Pulls settlements from the gateway for a date window and upserts them.
 *
 * Re-runnable by design: the window deliberately overlaps what was fetched
 * last time, because settlements can be reported late, and ON CONFLICT turns a
 * repeat into an update rather than a duplicate.
 */
function syncSettlements(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Settlements');

    const q = z.object({
      date_from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to:   z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query || {});

    const gateway = getGatewayAdapter();
    if (!gateway.isConfigured()) {
      return res.status(503).json({
        error: 'The payment gateway is not configured, so there are no settlements to fetch.',
      });
    }

    // Default: the last 30 days. Long enough to catch anything reported late,
    // short enough that a routine sync is one small request.
    const to = q.date_to || new Date().toISOString().slice(0, 10);
    const from = q.date_from
      || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const rows = await gateway.listSettlements({ from, to });
    let written = 0;
    for (const s of rows) {
      const r = await pool.query(
        `INSERT INTO payment_settlements
           (gateway, gateway_settlement_id, amount, fees, tax, currency, utr, status, settled_at, raw_response, fetched_at)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9::jsonb,NOW())
         ON CONFLICT (gateway, gateway_settlement_id) DO UPDATE
           SET amount = EXCLUDED.amount, fees = EXCLUDED.fees, tax = EXCLUDED.tax,
               utr = EXCLUDED.utr, status = EXCLUDED.status,
               settled_at = EXCLUDED.settled_at, raw_response = EXCLUDED.raw_response,
               fetched_at = NOW()
         RETURNING id`,
        [gateway.name, s.gateway_settlement_id, s.amount, s.fees, s.tax,
         s.utr, s.status, s.settled_at, s.raw ? JSON.stringify(s.raw) : null]);
      if (r.rowCount) written++;
    }

    // ── Link each settlement to the payments inside it ────────────────────
    //
    // payment_transactions.settlement_id has existed since migration 127, with
    // a foreign key and its own index — and nothing ever wrote it. The Payments
    // column on the Settlements tab reads it, so it showed a dash on every row
    // for ever: you could see that ₹9,791 landed and never which payments made
    // it up, which is the one question a settlement that looks wrong provokes.
    //
    // It cannot be captured any earlier. A payment is not settled when it is
    // captured — the settlement does not exist for another two or three days —
    // so the link can only be made here, looking backwards.
    //
    // Keyed by DATE because the gateway's recon report is (see the adapter).
    // One call per distinct settled date in what was just fetched, which for a
    // routine sync is a handful and usually one.
    let linked = 0;
    if (typeof gateway.listSettlementRecon === 'function') {
      const days = [...new Set(
        rows.map(s => (s.settled_at ? String(s.settled_at).slice(0, 10) : null)).filter(Boolean)
      )];

      for (const day of days) {
        const [y, m, d] = day.split('-').map(Number);
        let recon;
        try {
          recon = await gateway.listSettlementRecon({ year: y, month: m, day: d });
        } catch (err) {
          // A recon failure must not fail the sync. The settlements themselves
          // are already saved and correct; only the breakdown is missing, and
          // the next sync re-reads the same window and fills it in then.
          console.error('[payments] settlement recon failed for', day, err.message);
          continue;
        }
        if (!recon.length) continue;

        // One statement for the whole day rather than one per payment: unnest
        // turns the two arrays into rows to join against, so a 400-payment day
        // is a single round trip instead of 400.
        //
        // IS DISTINCT FROM, not <>. settlement_id is NULL on every unlinked
        // row, and `NULL <> 5` is NULL rather than true — so a plain inequality
        // would match nothing and link nothing, which is exactly the kind of
        // silent no-op this whole block exists to undo.
        const upd = await pool.query(
          `UPDATE payment_transactions t
              SET settlement_id = s.id, updated_at = NOW()
             FROM unnest($1::text[], $2::text[]) AS m(payment_id, settlement_id)
             JOIN payment_settlements s
               ON s.gateway_settlement_id = m.settlement_id AND s.gateway = $3
            WHERE t.gateway_payment_id = m.payment_id
              AND t.settlement_id IS DISTINCT FROM s.id`,
          [recon.map(r => r.gateway_payment_id),
           recon.map(r => r.gateway_settlement_id),
           gateway.name]
        );
        linked += upd.rowCount;
      }
    }

    res.json({ fetched: rows.length, written, linked, from, to });
  });
}

/**
 * GET /api/payments/settlements/:id/payments — what is inside one settlement.
 *
 * The answer to "this transfer is not the number I expected". Reads the link
 * syncSettlements writes; a settlement nobody has reconciled yet returns an
 * empty list rather than an error, because "not linked yet" and "no payments"
 * are different states and only the person looking knows which one matters.
 */
function listSettlementPayments(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Settlements');
    const id = z.coerce.number().int().positive().parse(req.params.id);

    const r = await pool.query(
      `SELECT t.id, t.txn_ref, t.gateway_payment_id, t.amount, t.method_detail,
              t.status, t.created_at, t.entity_type, t.entity_id,
              -- The invoice's name where there is one, else the number the
              -- payment was taken against. Never blank: a list of amounts with
              -- nothing to attach them to answers no question.
              COALESCE(ci.customer_name, t.mobile) AS customer_name
         FROM payment_transactions t
         LEFT JOIN customer_invoices ci
                ON t.entity_type = 'customer_invoice' AND ci.id = t.entity_id
        WHERE t.settlement_id = $1
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT 500`, [id]);

    res.json({ items: r.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET / PUT /api/payments/gateway — configuration, never credentials
//
// The credentials CAN now be set from this screen (integration_settings, the
// same table the WhatsApp Connection tab writes). What still never happens is a
// secret coming BACK: the GET returns {configured, last4, source} per field and
// nothing else, so there is no response a stale tab, a browser cache or a
// screenshot in a support chat can leak a key from. Writes are one-way.
//
// The two non-secret fields — the API base URL and the link lifetime — are
// returned whole, because they are not secrets and an admin cannot check a
// URL they can only see the last four characters of.
// ─────────────────────────────────────────────────────────────────────────────

/** {configured, last4, source} — the whole of what the screen may know. */
function describeSetting(key) {
  const v = getSetting(key);
  return {
    configured: v.length > 0,
    last4: v.length > 0 ? v.slice(-4) : null,
    // 'database' (set from this screen), 'environment' (.env fallback), null.
    source: settingSource(key),
  };
}

/** Trailing slashes stripped once, here, so nothing downstream doubles them. */
function apiBaseUrl() {
  return String(getSetting('public_api_base_url') || '').replace(/\/+$/, '');
}

function gatewaySettingsPayload() {
  // gatewayStatus() returns mode, a MASKED key id, and booleans. There is no
  // parameter that makes it return a secret.
  const status = gatewayStatus();

  // The customer-facing site. Same helper as the invoice QR and the WhatsApp
  // links, so all three can never disagree about which host is ours.
  const { publicBaseUrl } = require('../utils/qr');
  const appBase = publicBaseUrl();

  // The API's own public address — every other PUBLIC_* names the FRONTEND, and
  // the frontend and the API are different hosts in this deployment. Needed to
  // display the webhook URL for an admin to paste into the gateway dashboard.
  //
  // Deliberately NOT derived from this request's Host header: an admin is about
  // to register whatever this says as the endpoint that marks invoices paid,
  // and a forwarded Host would put someone else's domain there.
  const apiBase = apiBaseUrl();

  return {
    ...status,
    webhook_url: apiBase ? `${apiBase}/api/webhooks/razorpay` : null,
    pay_link_base: appBase ? `${appBase}/pay/` : null,

    // Per-field state, so the screen can show "set here" beside one row and
    // "from the server environment" beside the next. An admin who cannot see
    // WHICH of the two a value came from cannot reason about why clearing it
    // did not take effect.
    settings: {
      key_id:         describeSetting('razorpay_key_id'),
      key_secret:     describeSetting('razorpay_key_secret'),
      webhook_secret: describeSetting('razorpay_webhook_secret'),
      api_base_url: {
        ...describeSetting('public_api_base_url'),
        value: apiBase || null,
      },
      link_ttl_days: {
        ...describeSetting('payment_link_ttl_days'),
        value: linkTtlDays(),
      },
    },

    // Named individually so the screen can say WHICH value is missing.
    // "Not configured" tells an admin nothing about what to do next.
    missing: [
      !status.configured && 'Razorpay Key ID and Key Secret',
      !status.webhook_configured && 'Razorpay Webhook Secret',
      // PUBLIC_APP_URL is the one that genuinely is NOT settable here. It is
      // read by utils/qr at a dozen call sites that have nothing to do with
      // payments — invoice QRs, WhatsApp link templates — so moving it belongs
      // with those, not smuggled into the gateway screen.
      !appBase && 'PUBLIC_APP_URL (the customer-facing site address — server environment only)',
      !apiBase && 'The API\'s public address',
    ].filter(Boolean),
  };
}

/** GET /api/payments/gateway */
function getGatewaySettings(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Gateway configuration');
    res.json(gatewaySettingsPayload());
  });
}

const gatewaySettingsSchema = z.object({
  // undefined = leave alone; '' = clear the row and fall back to the env var.
  key_id:         z.string().trim().max(200).optional(),
  key_secret:     z.string().trim().max(200).optional(),
  webhook_secret: z.string().trim().max(200).optional(),
  api_base_url:   z.string().trim().max(300).optional(),
  link_ttl_days:  z.string().trim().max(4).optional(),
});

/**
 * PUT /api/payments/gateway
 *
 * ── VALIDATED BEFORE IT IS STORED ───────────────────────────────────────────
 * Every check below exists because the failure it prevents is silent. A key id
 * with a space pasted on the end authenticates as a wrong password; an api base
 * without a scheme produces a webhook URL Razorpay accepts and never calls.
 * Both look like a working save and surface days later as "payments stopped".
 */
function saveGatewaySettings(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Gateway configuration');
    const d = gatewaySettingsSchema.parse(req.body || {});

    const fields = ['key_id', 'key_secret', 'webhook_secret', 'api_base_url', 'link_ttl_days'];
    if (fields.every(f => d[f] === undefined)) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    // A Razorpay key id is rzp_test_… or rzp_live_…, and the prefix is what
    // mode() reads to decide whether this install is taking real money. A
    // secret pasted into the id box would silently put the system in "test"
    // forever, which is the single most expensive typo available on this
    // screen.
    if (d.key_id) {
      if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(d.key_id)) {
        return res.status(422).json({
          error: 'That is not a Razorpay Key ID. It starts with rzp_test_ or rzp_live_ — '
               + 'copy it from Razorpay Dashboard → Settings → API Keys.',
        });
      }
    }

    // The secret is opaque, so there is nothing to pattern-match. What CAN be
    // caught is the other half of the same mix-up: a key id pasted into the
    // secret box. That one would leave the system "configured" with a secret
    // that signs nothing, and every callback would fail verification.
    if (d.key_secret && /^rzp_(test|live)_/.test(d.key_secret)) {
      return res.status(422).json({
        error: 'That looks like the Key ID, not the Key Secret. The secret is the value '
             + 'Razorpay showed only once, when the key pair was generated.',
      });
    }

    if (d.api_base_url) {
      let u;
      try { u = new URL(d.api_base_url); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) {
        return res.status(422).json({
          error: 'Enter the full address of this API, including https:// — for example '
               + 'https://spinoto-backend.onrender.com',
        });
      }
      // A path here means the webhook URL becomes …/some/path/api/webhooks/razorpay.
      // Razorpay will accept it and then call a 404 forever.
      if (u.pathname !== '/' && u.pathname !== '') {
        return res.status(422).json({
          error: 'Enter the address only, with no path after the host name.',
        });
      }
      d.api_base_url = `${u.protocol}//${u.host}`;
    }

    if (d.link_ttl_days) {
      const n = Number(d.link_ttl_days);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return res.status(422).json({ error: 'Payment links must last between 1 and 90 days.' });
      }
      d.link_ttl_days = String(n);
    }

    const uid = req.user?.id || null;
    const changed = [];
    const KEYS = {
      key_id:         'razorpay_key_id',
      key_secret:     'razorpay_key_secret',
      webhook_secret: 'razorpay_webhook_secret',
      api_base_url:   'public_api_base_url',
      link_ttl_days:  'payment_link_ttl_days',
    };
    for (const f of fields) {
      if (d[f] === undefined) continue;
      await putSetting(pool, KEYS[f], d[f], uid);
      changed.push(d[f] === '' ? `${f} (cleared)` : f);
    }

    // Which fields changed, NEVER their values. "Someone rotated the key on
    // Tuesday and payments stopped on Tuesday" is the question this answers.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'integration_settings',
      entityId: null,
      description: `Payment gateway settings changed: ${changed.join(', ')}`,
    });

    // The freshly-computed state, so the screen never has to guess what the
    // save did — including mode flipping from test to live, which is the one
    // thing an admin must see confirmed rather than assume.
    res.json(gatewaySettingsPayload());
  });
}

/**
 * A live round-trip to the gateway.
 *
 * Answers the only question the settings screen cannot answer from environment
 * variables: are these credentials actually accepted? A key that is present but
 * revoked, or a test key on a live server, looks identical to a working one
 * until the first customer tries to pay.
 *
 * Implemented as a settlements read rather than an order creation — it touches
 * nothing, costs nothing, and cannot leave a stray order behind.
 */
function testGatewayConnection(req, res, next) {
  handle(req, res, next, async () => {
    denyHub(req, 'Gateway configuration');
    const gateway = getGatewayAdapter();
    if (!gateway.isConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'No gateway credentials are set. Add the Key ID and Key Secret above and save, then test again.',
      });
    }
    try {
      await gateway.listSettlements({ count: 1 });
      res.json({ ok: true, mode: gateway.mode(), message: 'The gateway accepted these credentials.' });
    } catch (err) {
      // The gateway's own error code, never its full response — that can echo
      // request content back into an admin screen.
      res.status(502).json({
        ok: false,
        error: 'The gateway rejected these credentials or could not be reached.',
        code: err.gateway_error_code || null,
      });
    }
  });
}

module.exports = {
  listRefunds,
  createOrder,
  createQr,
  cancelQr,
  verifyPayment,
  listForInvoice,
  listPayments,
  paymentsSummary,
  paymentsByHub,
  createAdvance,
  allocatePayment,
  customerCredit,
  listUnallocated,
  listForCustomer,
  getPayment,
  exportPayments,
  refundPayment,
  advanceVoucherPdf,
  refundVoucherPdf,
  refundAdvancePayment,
  createAccountCredit,
  receivePayment,
  planPayment,
  accountCreditRate,
  applyCustomerCredit,
  createPaymentLink,
  listPaymentLinks,
  cancelPaymentLink,
  listSettlements,
  listSettlementPayments,
  syncSettlements,
  getGatewaySettings,
  saveGatewaySettings,
  testGatewayConnection,
};
