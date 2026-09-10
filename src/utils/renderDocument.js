'use strict';

/**
 * renderDocument — the single entry point every document PDF/preview goes
 * through, for all three document types.
 *
 * Centralised so that the company lookup, config resolution, theme selection
 * and viewer-role determination can't drift between the estimate, customer
 * invoice and purchase invoice endpoints. In particular viewerRole is derived
 * HERE from the authenticated user, never from a request parameter — a hub
 * user must not be able to ask for the admin view of a purchase invoice and
 * see the margin taken on their work.
 */

const { pool } = require('../config/db');
const { getTheme } = require('../templates/invoiceThemes/registry');
// Not in the registry: the registry maps a user-selectable theme key to a
// module, and this one is never selectable. See resolveRender below.
const advanceReceipt = require('../templates/invoiceThemes/advanceReceipt');
const { buildDocument } = require('../templates/documentAdapter');
const { resolveDocumentConfig, qrEnabled } = require('./documentConfig');
const { renderHtmlToPdf } = require('./pdf');
const { qrDataUri, publicDocumentUrl, publicPayUrl, upiPayUri } = require('./qr');
const { inlineAsset } = require('./assetInline');

/**
 * Company row + everything the renderer needs from settings.
 *
 * This list must cover every `company.*` field documentAdapter reads. A missing
 * column doesn't error — it arrives as undefined and the block silently doesn't
 * print. That is exactly how the uploaded signature went missing: signature_url
 * was absent here, so blocksFrom() saw undefined, set signatureUrl to null, and
 * every theme printed the signatory label over blank space with no image, on
 * both the PDF and the preview.
 */
async function loadCompany() {
  const r = await pool.query(
    `SELECT company_name, address_line1, address_line2, city, state, pincode,
            phone, email, gstin, invoice_theme, invoice_accent_color, logo_url,
            signature_url,
            invoice_config, document_config
     FROM company_settings WHERE id = 1 LIMIT 1`
  );
  return r.rows[0] || {};
}

/**
 * A hub user always gets the hub view. Derived from the authenticated session
 * only — deliberately not overridable by query param or body.
 */
function viewerRoleFor(user) {
  return user?.hub_id ? 'hub' : 'admin';
}

/**
 * Resolve config + theme for a document.
 *
 * Theme precedence, highest first:
 *   1. themeOverride  — the settings live preview / "try this theme"
 *   2. share theme    — auto_share_theme when the request is a customer share
 *   3. the document's configured theme
 */
function resolveRender(company, docType, user, { themeOverride, share } = {}) {
  const viewerRole = viewerRoleFor(user);
  const cfg = resolveDocumentConfig(company.document_config, docType, viewerRole);

  // The advance receipt has ONE renderer, and the theme setting does not apply
  // to it — there is no item table to style. Decided here rather than at each
  // call site so a caller cannot accidentally hand a receipt voucher to an
  // invoice theme, which would render a tax document with an empty item table
  // and a "Balance Due" row for a job that has not been invoiced.
  //
  // themeOverride is honoured for nothing on this document, including the
  // settings live preview: previewing a receipt voucher under "advanced_gst"
  // would show a layout it will never actually print in.
  if (docType === 'advance_receipt') {
    return { cfg, theme: advanceReceipt, themeKey: 'advance_receipt', viewerRole };
  }

  const shareTheme = share ? cfg.flags.auto_share_theme : null;
  const themeKey = themeOverride || shareTheme || cfg.theme;
  return { cfg, theme: getTheme(themeKey), themeKey, viewerRole };
}

/**
 * The sheet a document prints on.
 *
 * A theme's `fixedPageSize` wins over the global setting, because for the
 * "(A5)" variants the sheet IS the theme — picking one is how you ask for A5.
 * Only those variants declare it; see registry.js for why it isn't named
 * `pageSize` (the old name made the global setting dead code).
 *
 * Single source of truth: the HTML and the PDF must agree on this. They didn't
 * before, which is what broke A5 — Puppeteer was handed a smaller sheet while
 * the template still laid itself out for A4, so it spilled onto a second page.
 */
function pageSizeFor(theme, cfg) {
  return theme.fixedPageSize || cfg.global.page_size || 'A4';
}

// ─── Download filename ────────────────────────────────────────────────────────

// Reserved on Windows and/or meaningful to a filesystem. A stray "/" in a model
// name would read as a path separator, so these are stripped rather than
// substituted with anything clever.
const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;

/** One filename segment: safe, whitespace-collapsed, length-capped. */
function filenameSegment(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ILLEGAL_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * "CI-000109_GJ27CP7432_Passion Pro.pdf"
 *
 * Number comes from the BUILT document, not re-derived from the row: the
 * displayed number is composed by documentAdapter from the id plus the
 * configured prefix and padding, so deriving it a second time here would let
 * the filename drift from what's printed on the page.
 *
 * Empty segments are dropped rather than left as gaps — a walk-in job may have
 * no vehicle or no model, and "CI-000109__.pdf" looks broken.
 */
function documentFilename(doc, row) {
  const parts = [doc?.number, row?.vehicle_number, row?.model_name]
    .map(filenameSegment)
    .filter(Boolean);
  return `${parts.join('_') || 'document'}.pdf`;
}

/**
 * Content-Disposition value carrying both a plain ASCII filename and an RFC 5987
 * UTF-8 one.
 *
 * Two forms because the header is ASCII-only by spec: a model name with any
 * non-ASCII character would arrive mangled if sent raw. Modern browsers prefer
 * `filename*`; anything older falls back to the transliterated `filename`.
 */
function contentDisposition(name, { inline = true } = {}) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; ` +
         `filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Render a document to an HTML string.
 *
 * Returns { html, doc } — the caller needs the built document for the download
 * filename, and rebuilding it would risk the two disagreeing.
 *
 * Async because the QR code has to be generated and inlined as a data URI
 * BEFORE the (synchronous, pure) template runs — a theme can't await.
 */
async function renderHtml(docType, row, company, cfg, theme, { baseUrl } = {}) {
  const doc = buildDocument(docType, row, company, cfg);

  // Images must be inlined as data URIs before the (synchronous) template
  // runs. Puppeteer renders the HTML string with no document URL, so a
  // relative src like "/logo.svg" has no origin to resolve against and would
  // silently not appear. See utils/assetInline.js.
  const [logo, signature] = await Promise.all([
    inlineAsset(doc.seller?.logoUrl),
    inlineAsset(doc.blocks?.signatureUrl),
  ]);
  if (doc.seller) doc.seller.logoUrl = logo;
  if (doc.blocks) doc.blocks.signatureUrl = signature;

  // Skipped entirely when this document has the QR switched off — no point
  // paying for the generation just to have the adapter discard it.
  if (qrEnabled(cfg)) {
    const url = publicDocumentUrl(docType, doc.publicToken, baseUrl);
    // Null when there's no public token or no base URL available; the themes
    // then simply omit the QR block.
    doc.qrDataUri = await qrDataUri(url);
  }

  /* ── Ways to pay, printed on the document ────────────────────────────────
     Customer invoices only, and only while something is still owed.

     The balance test is the important one and it is deliberately not a
     setting. A paid invoice that still shows a Pay Now code is asking the
     customer to pay twice, and they have no way to tell the code is stale —
     the paper in their hand looks identical either way. `payable` is the same
     figure printed as Balance Due, so the code on the page and the number
     beside it can never disagree.

     A cent of tolerance rather than `> 0`: grand_total and amount_paid are
     both stored to the paisa and a fully-settled invoice can land a hair
     above zero. */
  const payable = Number(doc.payable);
  if (docType === 'customer_invoice' && Number.isFinite(payable) && payable > 0.01) {
    const g = cfg.global || {};

    /* ONLINE — the code encodes this invoice's own permanent token, not a
       payment link's. A link expires in days; this is going on paper. The page
       it opens mints a fresh link when somebody actually scans it. */
    if (g.pay_online || g.pay_button) {
      // One URL, both ways in. Generating it once is what guarantees the code
      // and the button on the same sheet cannot lead to different places.
      doc.payUrl = publicPayUrl(doc.publicToken, baseUrl);
      // The QR costs a render, so it is made only for the switch that shows it.
      if (doc.payUrl && g.pay_online) doc.payQrDataUri = await qrDataUri(doc.payUrl);
      doc.payButton = !!(doc.payUrl && g.pay_button);
    }

    /* UPI — a bare intent URI, which is why it can be printed at all (a
       gateway QR is dead in two hours). Skipped silently with no VPA
       configured: half a payment instruction is worse than none. */
    if (g.upi_qr && String(g.upi_vpa || '').trim()) {
      const uri = upiPayUri({
        vpa: g.upi_vpa,
        // The company's own name, not the hub's. The money goes to whoever
        // owns the VPA, and that is the business the customer is billed by.
        payeeName: g.upi_payee_name || company?.company_name || '',
        amount: payable,
        note: doc.number,
      });
      if (uri) {
        doc.upiQrDataUri = await qrDataUri(uri);
        // Printed under the code as text: a customer whose camera will not
        // focus, or who is paying from a different phone, can still type it.
        doc.upiVpa = String(g.upi_vpa).trim();
      }
    }
  }

  return { html: theme.render({ doc, cfg, pageSize: pageSizeFor(theme, cfg) }), doc };
}

/**
 * Render a document to a PDF buffer and send it.
 *
 * `filename` is optional — omit it and the name is derived from the document
 * itself (number_vehicle_model), which is what every caller wants.
 */
async function sendPdf(res, { docType, row, company, cfg, theme, filename, baseUrl }) {
  const { html, doc } = await renderHtml(docType, row, company, cfg, theme, { baseUrl });
  const name = filename || documentFilename(doc, row);
  const buf = await renderHtmlToPdf(html, { pageSize: pageSizeFor(theme, cfg) });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition(name),
    'Content-Length': buf.length,
  });
  res.send(buf);
}

module.exports = {
  loadCompany, viewerRoleFor, resolveRender, renderHtml, sendPdf, pageSizeFor,
  documentFilename, filenameSegment, contentDisposition,
};
