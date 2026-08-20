'use strict';

/**
 * PUBLIC, UNAUTHENTICATED document access.
 *
 * A customer holding the link in their WhatsApp message — or scanning the QR on
 * a printed invoice — gets their own invoice back as a PDF. No login.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * utils/qr.js has been putting a QR code on printed invoices for a while, and
 * its own module comment says that QR encodes "the document's PUBLIC share link
 * — the same /:token URL the customer already receives".
 *
 * It did not. Every by-token route is behind auth —
 *
 *   customer_invoices.routes.js:40   router.get('/by-token/:token', canView, …)
 *   purchase_invoices.routes.js:27   router.get('/by-token/:token', canView, …)
 *   estimates.routes.js:37           router.get('/by-token/:token', canView, …)
 *
 * — and server.js mounted exactly one public router, /api/public/booking. So
 * scanning the QR on an invoice took the customer to a login screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **Never reuse CI_SELECT here.**
 *
 * The authenticated select (customer_invoices.controller.js:50) carries
 * purchase_invoice_id, linked_purchase_invoice_id,
 * linked_purchase_invoice_token, linked_pi_amount_paid, customer_token,
 * estimate_token and warranty_claim_id. The purchase invoice is what we PAY THE
 * HUB — the difference between it and the customer invoice is the margin on the
 * job. A customer must never reach any of it, and `linked_purchase_invoice_token`
 * is a ready-made key to fetch it with.
 *
 * The select below is therefore built from scratch, column by column, against
 * the adapter's documented read-set. It is NOT CI_SELECT with a delete pass or
 * a destructure applied afterwards, because both of those fail open: add a
 * column to the admin select next year and a filter list silently starts
 * leaking it, whereas this query simply continues not to know about it.
 *
 * If you are adding a field here, the test is not "is it useful?" but "would I
 * be happy for this to appear on a link that can be forwarded?"
 */

const { pool } = require('../config/db');
const { resolveTokenToId } = require('../utils/publicToken');
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');

// ─────────────────────────────────────────────────────────────────────────────
// The allowlist
// ─────────────────────────────────────────────────────────────────────────────
//
// Every column here is read by documentAdapter.buildDocument('customer_invoice')
// — nothing is selected "just in case". Grouped to match the adapter so the two
// can be diffed by eye.

const PUBLIC_CI_SELECT = `
  SELECT
    -- Identity, numbering and dates. public_token feeds the QR block only.
    ci.id,
    ci.public_token,
    ci.invoice_date::text AS invoice_date,
    ci.created_at,
    ci.status,

    -- Buyer. Falls back to the appointment for invoices whose own columns were
    -- left null, exactly as the authenticated select does.
    COALESCE(ci.customer_name, a.customer_name) AS customer_name,
    COALESCE(ci.mobile,        a.mobile)        AS mobile,
    ci.is_b2b, ci.b2b_company_name, ci.b2b_gst_number, ci.b2b_address,

    -- Pickup block. Printed under BILL TO when the job was a pickup; it is the
    -- customer's own address, which they gave us.
    a.pickup_required, a.pickup_address_line1, a.pickup_address_line2,
    a.pickup_city, a.pickup_pincode,

    -- Vehicle.
    COALESCE(ci.vehicle_number, a.vehicle_number) AS vehicle_number,
    vm.name   AS make_name,
    vmod.name AS model_name,
    bt.name   AS body_type_name,
    cc.name   AS cc_category_name,

    -- Header extras, each gated by invoice_config in the adapter.
    ci.po_number, ci.eway_bill_number, ci.custom_fields,

    -- Drives the IGST vs CGST/SGST split, so it is needed even when the row
    -- itself is configured not to print.
    ci.place_of_supply_code,

    -- Seller labelling.
    ('Spinoto ' || ar.name) AS hub_name,
    h.hub_name              AS hub_full_name,
    h.gst_number            AS hub_gst,

    -- Money. What the CUSTOMER owes — no hub rate, no commission, no payable.
    ci.subtotal_ex_gst, ci.total_gst, ci.grand_total, ci.amount_paid,
    (ci.grand_total - ci.amount_paid) AS balance,
    ci.transaction_discount_amount,

    -- The advance split. THIS IS NOT OPTIONAL HERE.
    --
    -- The adapter splits the Paid row using these two columns. Omit them and
    -- they arrive as undefined, coerce to 0, and the split silently does not
    -- happen — so the copy a customer opens from their WhatsApp link says
    -- "Paid ₹8,000" while the copy an advisor prints says "Advance Applied
    -- ₹2,000 · Payments Received ₹6,000". Two documents, same invoice,
    -- different story, and nothing errors.
    --
    -- It is safe to expose: it is the customer's OWN money, already visible to
    -- them as a receipt voucher they were sent when they paid it.
    (SELECT COALESCE(SUM(a.amount), 0)
       FROM payment_allocations a
       JOIN customer_invoice_payments p ON p.id = a.ledger_payment_id
      WHERE a.customer_invoice_id = ci.id
        AND p.payment_type = 'advance') AS advance_applied,
    (SELECT string_agg(DISTINCT p.voucher_no, ', ' ORDER BY p.voucher_no)
       FROM payment_allocations a
       JOIN customer_invoice_payments p ON p.id = a.ledger_payment_id
      WHERE a.customer_invoice_id = ci.id
        AND p.payment_type = 'advance'
        AND p.voucher_no IS NOT NULL) AS advance_vouchers,

    ci.notes

  FROM customer_invoices ci
  LEFT JOIN hubs           h    ON h.id    = ci.hub_id
  LEFT JOIN areas          ar   ON ar.id   = h.area_id
  LEFT JOIN appointments   a    ON a.id    = ci.appointment_id
  LEFT JOIN estimates      est  ON est.id  = ci.estimate_id
  LEFT JOIN vehicle_makes  vm   ON vm.id   = COALESCE(a.make_id, est.make_id)
  LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, est.model_id)
  LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, est.body_type_id)
  LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, est.cc_category_id)
  WHERE ci.id = $1
`;

/**
 * Line items, narrowed the same way.
 *
 * Deliberately absent: `commission_percent`. documentAdapter's itemFrom()
 * (:335-336) copies customer_rate and commission_percent onto the built
 * document UNCONDITIONALLY, for all three document types. A customer invoice
 * theme never renders commission — the column is gated on
 * docType === 'purchase_invoice' — but the value would still be sitting on the
 * object. Not selecting it is what makes that structurally impossible rather
 * than conditionally invisible.
 *
 * Also absent: estimate_item_id and the warranty-claim join. The adapter reads
 * neither, and claim identifiers are internal workflow.
 */
async function _publicItems(ciId) {
  const r = await pool.query(
    `SELECT cii.id, cii.item_type, cii.description, cii.item_description,
            cii.hsn_sac, cii.quantity, cii.customer_rate,
            cii.total_inc_gst, cii.gst_percent, cii.gst_amount,
            cii.discount_type, cii.discount_value, cii.discount_amount,
            cii.batch_no, cii.mfg_date, cii.exp_date, cii.is_free,
            cii.custom_values,
            cii.warranty_months, cii.warranty_days, cii.warranty_km, cii.warranty_text,
            cii.guarantee_months, cii.guarantee_days, cii.guarantee_km, cii.guarantee_text
       FROM customer_invoice_items cii
      WHERE cii.customer_invoice_id = $1
      ORDER BY cii.id`,
    [ciId]
  );
  return r.rows;
}

/**
 * Payments. The adapter reads exactly five properties (documentAdapter:499);
 * this selects exactly those.
 *
 * `created_by_name` is in the authenticated version and is omitted here — which
 * member of staff took a payment is our record, not the customer's receipt.
 */
async function _publicPayments(ciId) {
  const r = await pool.query(
    `SELECT cip.paid_at, cip.method, cip.reference_no, cip.amount, cip.notes
       FROM invoice_payment_lines cip
      WHERE cip.customer_invoice_id = $1
      ORDER BY cip.paid_at ASC`,
    [ciId]
  );
  return r.rows;
}

/**
 * GET /api/public/documents/customer-invoice/:token
 *
 * Responds with the invoice PDF inline, so the link opens to a readable
 * document on a phone without a page to build or a session to establish.
 */
async function getPublicCustomerInvoice(req, res, next) {
  try {
    const token = String(req.params.token || '');

    // Length-bounded before it reaches the database. public_token is
    // VARCHAR(20) (migration 085), so anything longer cannot match and there is
    // no reason to pay for the query.
    if (!token || token.length > 20) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // The table name is a hardcoded literal, never request-derived —
    // publicToken.js:66-70 requires this, as it is interpolated into the SQL.
    //
    // Note this endpoint resolves customer_invoices and NOTHING ELSE. There is
    // deliberately no :type parameter: a route that took the table from the URL
    // would be one typo away from serving purchase invoices publicly.
    const id = await resolveTokenToId(pool, 'customer_invoices', token);

    // Same 404 for "no such token" and "malformed token". A distinguishable
    // response would turn this into an oracle for probing which tokens exist.
    if (!id) return res.status(404).json({ error: 'Document not found' });

    const r = await pool.query(PUBLIC_CI_SELECT, [id]);
    const invoice = r.rows[0];
    if (!invoice) return res.status(404).json({ error: 'Document not found' });

    // A cancelled invoice is not a bill and must not be handed back as one.
    // 410 rather than 404: the customer's link was valid, so telling them the
    // document is gone is more use than pretending it never existed.
    if (invoice.status === 'cancelled') {
      return res.status(410).json({
        error: 'This invoice has been cancelled. Please contact us if you need a copy.',
      });
    }

    // The authenticated PDF routes are protected from intermediary caching by
    // their Authorization header — there is nothing to vary on here, so a CDN,
    // reverse proxy or corporate proxy would be free to cache a named
    // customer's invoice and hand it to the next person who asked. Set
    // explicitly on this response rather than inside sendPdf(), which every
    // authenticated caller also uses.
    res.set('Cache-Control', 'private, no-store');

    invoice.items    = await _publicItems(id);
    invoice.payments = await _publicPayments(id);

    const company = await loadCompany();

    // share: true selects auto_share_theme, which is what the customer-facing
    // copy is configured to look like.
    //
    // The user argument is null, so viewerRoleFor() returns 'admin'. For a
    // customer invoice that only affects the title and number prefix
    // (documentConfig.js:302-306) — the hub view exists to relabel PURCHASE
    // invoices, which this endpoint cannot serve. No margin column keys off it;
    // docShared.js:197-199 gates those on docType as well as role.
    const { cfg, theme } = resolveRender(company, 'customer_invoice', null, { share: true });

    // The two optional enrichments the authenticated PDF route applies are
    // deliberately skipped:
    //
    //   price_history      — what this customer paid for the same part before
    //   show_party_balance — their total outstanding across ALL invoices
    //
    // Both are reasonable on a screen someone has logged in to see. On a link
    // that can be forwarded, the second in particular turns "here is your bill"
    // into "here is everything you owe us", which is a wider disclosure than
    // the message promised. If they are ever wanted here, that should be a
    // deliberate config flag, not an inherited default.

    await sendPdf(res, {
      docType: 'customer_invoice',
      row: invoice,
      company,
      cfg,
      theme,
      // No baseUrl fallback from Origin/Referer here. On a public request those
      // headers are attacker-controlled, and qr.js:44 would happily bake the
      // supplied value into the QR on the customer's own invoice. PUBLIC_APP_URL
      // or no QR at all.
      baseUrl: null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/public/documents/advance/:token
 *
 * The customer's own copy of a receipt voucher, or of a refund voucher — the
 * token decides which, and it is looked up in that order.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ONE DOES NOT NEED A SECOND NARROW SELECT
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule at the top of this file exists because CI_SELECT carries the
 * purchase invoice — what we pay the hub — and the margin between the two.
 *
 * advances.service.readReceiptVoucher has no such neighbour to leak. It selects
 * one payment row, the estimate's grand total, the customer's own name and
 * vehicle, and the hub label that already prints on every document they
 * receive. There is no hub rate, no commission, no margin and no other
 * customer's data reachable from it — the query is scoped by the token itself.
 *
 * Sharing it with the staff route is therefore the safer choice, not the lazier
 * one: the customer's copy and the advisor's copy of a NUMBERED TAX DOCUMENT
 * must be byte-identical, and two queries are two things to drift.
 *
 * What is deliberately not passed here, exactly as on the invoice route:
 *   • no baseUrl from the request — on a public request Origin and Referer are
 *     attacker-controlled, and qr.js would bake the supplied value into the QR
 *     printed on the customer's own voucher;
 *   • no user, so viewerRole is 'admin' — which on this document affects only
 *     the title, and phone masking, which applies to hub views of a document
 *     this endpoint cannot serve.
 */
async function getPublicAdvanceVoucher(req, res, next) {
  try {
    const token = String(req.params.token || '');

    // public_token is VARCHAR(20); anything longer cannot match, so there is no
    // reason to pay for the query.
    if (!token || token.length > 20) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const svc = require('../services/advances.service');

    // Receipt first, then refund. The two token spaces are separate columns on
    // separate tables and both are random, so a token means one document or
    // none — the order is for cost, not correctness.
    const row = await svc.readReceiptVoucher(pool, { publicToken: token })
             || await svc.readRefundVoucher(pool, { publicToken: token });

    // Same 404 for "no such token", "malformed token" and "never captured". A
    // distinguishable response would turn this into an oracle for which tokens
    // exist and which links were paid.
    if (!row) return res.status(404).json({ error: 'Document not found' });

    // Nothing here varies on a header, so without this a CDN or corporate proxy
    // would be free to cache a named customer's receipt and hand it to the next
    // person who asked. Set on this response rather than inside sendPdf, which
    // every authenticated caller also uses.
    res.set('Cache-Control', 'private, no-store');

    const company = await loadCompany();
    const { cfg, theme } = resolveRender(company, 'advance_receipt', null, { share: true });

    await sendPdf(res, {
      docType: 'advance_receipt',
      row,
      company,
      cfg,
      theme,
      filename: `${row.voucher_no}.pdf`,
      baseUrl: null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPublicCustomerInvoice, getPublicAdvanceVoucher };
