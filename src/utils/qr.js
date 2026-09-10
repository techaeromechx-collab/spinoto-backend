'use strict';

/**
 * QR generation for printed documents.
 *
 * The QR encodes the document's PUBLIC share link — the same /:token URL the
 * customer already receives — so scanning the printed invoice opens their own
 * copy. That's strictly more useful than the fixed "scan to download" image
 * the old print layout carried, which was the same picture on every invoice.
 *
 * Rendered as a data URI rather than a URL because the PDF is produced by
 * Puppeteer from a self-contained HTML string: an <img src="/qr.png"> would
 * need a reachable origin, whereas a data URI always resolves.
 *
 * Every failure path returns null and the themes simply omit the block — a
 * missing QR must never take a whole invoice down with it.
 */

let QRCode = null;
try {
  // Optional dependency: if it isn't installed the documents still render,
  // just without QR codes.
  QRCode = require('qrcode');
} catch {
  QRCode = null;
}

let warned = false;

/** Base URL customers use, e.g. https://app.spinoto.in — no trailing slash. */
function publicBaseUrl() {
  const raw = process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.FRONTEND_URL || '';
  return String(raw).replace(/\/+$/, '');
}

/**
 * The customer-facing URL for a document, or null when it can't be built
 * (no public token, or no base URL configured).
 */
function publicDocumentUrl(docType, publicToken, fallbackBase) {
  // PUBLIC_APP_URL is the right answer in production. `fallbackBase` is the
  // requesting app's own Origin, passed through by the controllers, so the QR
  // works out of the box in development without anyone configuring an env var.
  const base = publicBaseUrl() || String(fallbackBase || '').replace(/\/+$/, '');
  if (!base || !publicToken) return null;
  // Singular, and deliberately not the CRM's list paths.
  //
  // /invoice/<token> and /estimate/<token> are public unconditionally. The
  // plural paths they replaced double as staff deep links, so their meaning
  // depends on whether whoever scans the code is signed in — and a hub session
  // scanning one is redirected to /hub, seeing a dashboard instead of the
  // document. A QR on paper cannot be re-issued, so it has to encode the
  // address that will never be ambiguous.
  //
  // Codes already printed keep working: App.jsx redirects the old paths here.
  // purchase_invoice is unchanged — it has no public page, and it is a
  // hub-facing document rather than a customer-facing one.
  const path = {
    estimate: 'estimate',
    customer_invoice: 'invoice',
    purchase_invoice: 'purchase-invoices',
    // Public unconditionally, like /invoice and /estimate. The token is the
    // PAYMENT's public_token (or the refund's) — a receipt voucher must open
    // the receipt, not the job it was taken against.
    advance_receipt: 'advance',
  }[docType];
  if (!path) return null;
  return `${base}/${path}/${encodeURIComponent(publicToken)}`;
}

/**
 * PNG data URI for `text`, or null.
 *
 * Errors are swallowed deliberately — see the module comment. The first
 * missing-dependency case logs once so it's discoverable without spamming a
 * line per rendered document.
 */
async function qrDataUri(text, { size = 220 } = {}) {
  if (!text) return null;
  if (!QRCode) {
    if (!warned) {
      warned = true;
      console.warn('[qr] `qrcode` package not installed — QR codes will be omitted from documents. Run: npm install');
    }
    return null;
  }
  try {
    return await QRCode.toDataURL(String(text), {
      width: size,
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' },
    });
  } catch (err) {
    console.error('[qr] generation failed:', err.message);
    return null;
  }
}

/**
 * The customer-facing "pay this invoice" URL for a CUSTOMER INVOICE token.
 *
 * Deliberately built from the invoice's own permanent public token rather than
 * from a payment link's. A payment link expires in days and can be cancelled;
 * this URL is printed on paper and has to work in three months. The page it
 * lands on is the one that mints a fresh link at the moment somebody scans —
 * see controllers/public.payments.controller.js:startInvoicePayment.
 *
 * Same base resolution as publicDocumentUrl, for the same reason: the pay QR
 * and the document QR on one sheet of paper must never point at two different
 * hosts.
 */
function publicPayUrl(publicToken, fallbackBase) {
  const base = publicBaseUrl() || String(fallbackBase || '').replace(/\/+$/, '');
  if (!base || !publicToken) return null;
  return `${base}/invoice/${encodeURIComponent(publicToken)}/pay`;
}

/**
 * A UPI intent URI — what a printed "scan to pay" QR actually contains.
 *
 * WHY THIS EXISTS ALONGSIDE THE GATEWAY
 * ─────────────────────────────────────
 * A Razorpay QR cannot be printed. Their close_by caps at 2 HOURS from
 * creation (see migration 129), so a QR generated at render time is dead
 * before the customer reaches the counter. A plain UPI intent has no server
 * behind it and therefore no expiry at all — it is just an address, an amount
 * and a note, encoded.
 *
 * WHAT YOU GIVE UP BY USING IT
 * ────────────────────────────
 * Everything the gateway does. There is no order, no webhook and no
 * payment_transactions row: the money lands in the bank account behind the VPA
 * and NOTHING in this system knows. The invoice stays unpaid until a human
 * records the payment. That is not a bug to be fixed later — it is inherent to
 * a bank-to-bank UPI transfer, and it is why this is off by default and why
 * the settings screen says so in as many words.
 *
 * FIELDS
 *   pa  payee address (the VPA)          — required
 *   pn  payee name, shown in the UPI app — required in practice; apps show
 *                                          "Unknown" without it, which stops
 *                                          people mid-payment
 *   am  amount, 2dp                      — omitted when not positive, which
 *                                          leaves the customer to type it
 *   tn  transaction note                 — the invoice number, so the payment
 *                                          can be reconciled by hand later.
 *                                          UPI silently truncates this, so it
 *                                          carries the number and nothing else.
 *   cu  currency                         — INR is the only value UPI accepts
 */
function upiPayUri({ vpa, payeeName, amount = null, note = null }) {
  const pa = String(vpa || '').trim();
  if (!pa) return null;
  const p = new URLSearchParams();
  p.set('pa', pa);
  p.set('pn', String(payeeName || '').trim() || pa);
  const amt = Number(amount);
  if (Number.isFinite(amt) && amt > 0) p.set('am', amt.toFixed(2));
  p.set('cu', 'INR');
  if (note) p.set('tn', String(note).trim().slice(0, 50));
  // URLSearchParams encodes a space as '+', which some UPI apps show
  // literally in the note. %20 is understood everywhere.
  return `upi://pay?${p.toString().replace(/\+/g, '%20')}`;
}

module.exports = { qrDataUri, publicDocumentUrl, publicBaseUrl, publicPayUrl, upiPayUri };
