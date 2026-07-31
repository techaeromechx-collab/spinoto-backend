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
  const path = {
    estimate: 'estimates',
    customer_invoice: 'customer-invoices',
    purchase_invoice: 'purchase-invoices',
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

module.exports = { qrDataUri, publicDocumentUrl, publicBaseUrl };
