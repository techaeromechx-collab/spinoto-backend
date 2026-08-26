/**
 * "Advanced GST — Tally" theme.
 * Dense, fully-bordered, monospace-leaning layout that mimics the print output
 * of Indian accounting software (Tally ERP / Excel-printed-as-PDF). Every cell
 * in the meta grid, the line-items table, the tax summary and the totals block
 * gets a visible 1px black border — no rounded corners, near-zero colour, tiny
 * row heights. The only spot of colour is a thin rule under the company name,
 * drawn from doc.accent.
 *
 * ── The document contract ───────────────────────────────────────────────────
 * render({ doc, cfg }) — see simple.js for the reference implementation.
 *   doc — the canonical document from templates/documentAdapter.js. The same
 *         theme renders an estimate, a customer invoice or a purchase invoice;
 *         it never branches on doc.docType for DATA, only for cosmetics.
 *   cfg — resolveDocumentConfig(raw, docType, viewerRole)
 *
 * The tax summary table is no longer hard-coded: buildGstLines(doc) returns
 * either ONE IGST line per rate (inter-state) or a CGST/SGST PAIR per rate
 * (intra-state), each already labelled and formatted. The theme only decides
 * how those rows LOOK — it must not assume how many there are.
 */
const { esc, money, formatDate } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

// Maps docShared's semantic alignment onto this theme's CSS classes.
// `.desc` is this theme's left-aligned item cell style.
const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : 'desc');

// Column widths this theme has always used, kept keyed by column so they
// survive columns being toggled on and off. Unlisted (optional/custom)
// columns simply size themselves.
const TH_WIDTH = {
  sr: '22px', hsn: '52px', qty: '36px', rate: '56px',
  disc: '50px', gst: '56px', amount: '66px',
};

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 4.2, 5.3);
  const accent = doc.accent || '#4f46e5';
  const printedOn = formatDate(new Date());
  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const thead = columns
    .map(c => `<th class="${cls(c.align)}"${TH_WIDTH[c.key] ? ` style="width:${TH_WIDTH[c.key]};"` : ''}>${c.label}</th>`)
    .join('');

  const itemsRows = (doc.items || []).map((it, i) =>
    `<tr>${columns.map(c => `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`).join('')}</tr>`
  ).join('');

  // The header meta grid is a fixed 2-fields-per-row table. Every field —
  // number, date, place of supply, vehicle, custom — now comes from
  // buildHeaderFields and flows into the same grid.
  const metaRows = [];
  for (let i = 0; i < header.length; i += 2) {
    const a = header[i];
    const b = header[i + 1];
    metaRows.push(`
    <tr>
      <td class="meta-label">${a.label}</td><td>${a.value}</td>
      ${b ? `<td class="meta-label">${b.label}</td><td>${b.value}</td>` : '<td class="meta-label"></td><td></td>'}
    </tr>`);
  }

  const totalsRows = totals.map(t => `
        <tr${t.kind === 'grand' ? ' class="grand"' : ''}>
          <td class="label${t.kind === 'strong' ? ' b' : ''}">${t.label}</td>
          <td class="val${t.kind === 'strong' ? ' b' : ''}">Rs. ${t.value}</td>
        </tr>`).join('');

  // Each entry's label is already the full component name and percentage —
  // "IGST (18%)", "CGST (9%)", "SGST (9%)" — so this only styles the rows.
  const gstRateRows = gstLines.map(g => `
    <tr>
      <td class="desc">${g.label}</td>
      <td class="r">${g.value}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  html, body { background: #ffffff; }
  body {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 9.5px;
    line-height: 1.35;
    color: #000000;
    ${pageScale}
  }
  .accent-rule { height: 2px; background: ${accent}; width: 100%; margin: 4px 0 8px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .company-name { font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .logo { height: 36px; width: auto; max-width: 130px; object-fit: contain; margin-bottom: 4px; display: block; }
  .company-addr { font-size: 9px; line-height: 1.5; margin-top: 2px; }
  .doc-title { text-align: right; }
  .doc-title h1 {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 13px;
    letter-spacing: 1.5px;
    text-decoration: underline;
    text-transform: uppercase;
  }
  .doc-title .orig { font-size: 8.5px; margin-top: 3px; font-style: italic; }
  .doc-title .printed { font-size: 8px; margin-top: 2px; color: #333; }

  table.grid { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.grid th, table.grid td { border: 1px solid #000000; padding: 2.5px 5px; }
  th.meta-label, td.meta-label { font-weight: 700; width: 90px; background: #f0f0f0; }

  .invoice-meta-table { margin-top: 8px; }

  .bill-section { display: flex; gap: 0; margin-top: 8px; }
  .bill-box { flex: 1; border: 1px solid #000000; padding: 5px 7px; }
  .bill-box + .bill-box { border-left: none; }
  .bill-box .hd { font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: .3px; border-bottom: 1px solid #000; padding-bottom: 3px; margin-bottom: 3px; }
  .bill-box .name { font-weight: 700; font-size: 10px; }

  table.items { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.items th, table.items td { border: 1px solid #000000; padding: 3px 5px; }
  table.items thead th {
    background: #eaeaea;
    font-weight: 700;
    text-align: center;
    font-size: 9px;
    text-transform: uppercase;
  }
  table.items td.desc { font-family: Arial, Helvetica, sans-serif; text-align: left; }
  .c { text-align: center; }
  .r { text-align: right; }
  .b { font-weight: 700; }

  .bottom-grid { display: flex; gap: 10px; margin-top: 10px; align-items: flex-start; }
  .gst-summary { flex: 1; }
  .gst-summary table { width: 100%; border-collapse: collapse; }
  .gst-summary th, .gst-summary td { border: 1px solid #000000; padding: 3px 5px; }
  .gst-summary th { background: #eaeaea; font-size: 9px; text-transform: uppercase; }
  .gst-summary td.desc { font-family: Arial, Helvetica, sans-serif; text-align: left; }

  .totals { width: 260px; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals td { border: 1px solid #000000; padding: 3px 6px; }
  .totals td.label { font-weight: 700; }
  .totals td.val { text-align: right; }
  .totals tr.grand td { font-weight: 700; font-size: 11px; background: #f0f0f0; }

  .words-box { margin-top: 10px; border: 1px solid #000000; padding: 5px 8px; font-size: 9px; }
  .words-box .hd { font-weight: 700; text-transform: uppercase; font-size: 8.5px; margin-bottom: 2px; }

  /* Two boxes on one row. align-items:stretch (the flex default) keeps both
     borders the same height even when one holds more text than the other —
     otherwise the shorter box ends with a ragged bottom edge next to the taller
     one. The row owns the top margin; the cells drop theirs, or the gap would
     be doubled. */
  .pair-row { display: flex; gap: 8px; align-items: stretch; margin-top: 10px; }
  .pair-row > .pair-cell { flex: 1 1 50%; min-width: 0; margin-top: 0; }

  .declaration { margin-top: 10px; border: 1px solid #000000; padding: 6px 8px; font-size: 8.5px; line-height: 1.5; }
  .declaration .hd { font-weight: 700; text-transform: uppercase; font-size: 8.5px; margin-bottom: 2px; }

  .block-box { margin-top: 10px; border: 1px solid #000000; padding: 6px 8px; font-size: 8.5px; line-height: 1.55; }
  .block-box .hd { font-weight: 700; text-transform: uppercase; font-size: 8.5px; margin-bottom: 3px; border-bottom: 1px solid #000; padding-bottom: 2px; }

  .footer-row { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; align-items: flex-start; }
  .footer-row .terms-col { max-width: 60%; }
  .footer-row .terms-col .block-box { margin-top: 0; }
  .footer-row .terms-col .block-box + .block-box { margin-top: 8px; }
  .sign-box { width: 220px; border: 1px solid #000000; text-align: center; padding-bottom: 6px; font-size: 8.5px; }
  .sign-box .for { text-align: left; padding: 4px 6px 0; font-weight: 700; margin-bottom: 24px; }
  .sign-box .space { height: 24px; }

  .computer-generated { text-align: center; font-size: 8px; color: #444; margin-top: 10px; line-height: 1.5; }

  .ln-name { font-weight: 700; }
  .ln-desc { font-size: 8.5px; color: #333; margin-top: 1px; line-height: 1.35; }
  .ln-hist { font-size: 8px; color: #555; margin-top: 1px; font-style: italic; }
  .ln-sub  { font-size: 8.5px; color: #444; }
  .ln-free { font-weight: 700; letter-spacing: .5px; }
  .sign-img { max-height: 58px; max-width: 150px; object-fit: contain; display: block; margin-left: auto; }
  .qr-box { flex: 0 0 auto; text-align: center; }
  .qr-box img { width: 58px; height: 58px; image-rendering: pixelated; margin-top: 3px; }
</style></head>
<body>

  <div class="top">
    <div>
      ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
      <div class="company-name">${esc(doc.seller.name)}</div>
      <div class="company-addr">
        ${sellerAddressHtml(doc)}${doc.seller.address.length ? '<br/>' : ''}
        ${doc.seller.gstin ? `GSTIN: ${esc(doc.seller.gstin)} &nbsp; ` : ''}${contact}
      </div>
    </div>
    <div class="doc-title">
      <h1>${esc(doc.title)}</h1>
      <div class="orig">(Original for Recipient)</div>
      <div class="printed">Printed on: ${esc(printedOn)}</div>
    </div>
  </div>
  <div class="accent-rule"></div>

  ${metaRows.length ? `<table class="grid invoice-meta-table">${metaRows.join('')}
  </table>` : ''}

  <div class="bill-section">
    <div class="bill-box">
      <div class="hd">Bill To / Party</div>
      <div class="name">${esc(doc.buyer.name)}</div>
      ${buyerRows.map(r => `<div>${r.label}: ${r.value}</div>`).join('')}
    </div>
    <div class="bill-box">
      <div class="hd">Ship From / ${esc(doc.seller.name)}</div>
      ${sellerAddressHtml(doc) ? `<div>${sellerAddressHtml(doc)}</div>` : ''}
      ${doc.seller.gstin ? `<div>GSTIN: ${esc(doc.seller.gstin)}</div>` : ''}
      ${contact ? `<div>${contact}</div>` : ''}
    </div>
    ${blocks.qrDataUri ? `<div class="bill-box qr-box"><div class="hd">${QR_CAPTION}</div><img src="${blocks.qrDataUri}" alt="" /></div>` : ''}
  </div>


  <table class="items">
    <thead>
      <tr>${thead}</tr>
    </thead>
    <tbody>${itemsRows || `<tr><td colspan="${columns.length}" class="c">No items</td></tr>`}</tbody>
  </table>

  <div class="bottom-grid">
    <div class="gst-summary">
      <table>
        <thead><tr><th>Tax Component</th><th>Amount</th></tr></thead>
        <tbody>
          ${gstRateRows || '<tr><td class="desc">—</td><td class="r">0.00</td></tr>'}
        </tbody>
      </table>
      <div class="declaration">
        <div class="hd">Declaration</div>
        We declare that this document shows the actual price of the goods/services described and that all particulars are true and correct.
      </div>
    </div>
    <div class="totals">
      <table>${totalsRows}
      </table>
    </div>
  </div>

  ${/* Amount-in-words and Notes sit side by side. Both are short, and stacked
        full-width they ate two whole rows on an already dense form. When only
        one is present it takes the full width instead of leaving a gap. */''}
  ${(blocks.amountInWords && doc.notes) ? `
  <div class="pair-row">
    <div class="words-box pair-cell">
      <div class="hd">Amount Chargeable (in words)</div>
      ${esc(amountInWords(grandTotalOf(doc)))}
    </div>
    <div class="block-box pair-cell">
      <div class="hd">Notes</div>
      ${esc(doc.notes)}
    </div>
  </div>` : blocks.amountInWords ? `
  <div class="words-box">
    <div class="hd">Amount Chargeable (in words)</div>
    ${esc(amountInWords(grandTotalOf(doc)))}
  </div>` : doc.notes ? `
  <div class="block-box">
    <div class="hd">Notes</div>
    ${esc(doc.notes)}
  </div>` : ''}

  ${(doc.payments || []).length ? `
  <div class="block-box" style="padding:0; border:none;">
    <table class="grid" style="margin-top:10px;">
      <thead>
        <tr><th class="desc">Payment Date</th><th class="desc">Method</th><th class="desc">Reference</th><th class="r">Amount</th></tr>
      </thead>
      <tbody>${doc.payments.map(p => `
        <tr>
          <td class="desc">${esc(String(p.date || '').slice(0, 10))}</td>
          <td class="desc">${esc(p.method || '')}</td>
          <td class="desc">${esc(p.reference || '—')}</td>
          <td class="r b">${money(p.amount)}</td>
        </tr>`).join('')}</tbody>
    </table>
  </div>` : ''}

  <div class="footer-row">
    <div class="terms-col">
      ${blocks.terms ? `<div class="block-box"><div class="hd">Terms &amp; Conditions</div>${blocks.terms}</div>` : ''}
      ${blocks.bankDetails ? `<div class="block-box"><div class="hd">Bank Details</div>${blocks.bankDetails}</div>` : ''}
    </div>
    ${blocks.signature ? `<div class="sign-box">
      <div class="for">For ${esc(doc.seller.name)}</div>
      ${blocks.signatureUrl ? `<img class="sign-img" src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
      ${blocks.signature}
    </div>` : ''}
  </div>

  ${(blocks.footerNote || blocks.footerDisclaimer) ? `
  <div class="computer-generated">
    ${blocks.footerNote ? `*** ${blocks.footerNote} ***${blocks.footerDisclaimer ? '<br/>' : ''}` : ''}
    ${blocks.footerDisclaimer ? `${blocks.footerDisclaimer}` : ''}
  </div>` : ''}
  ${coverage.length ? `
  <div class="block-box"><div class="hd">Warranty &amp; Guarantee</div>
    ${coverage.map(c => `<div>${c.type} — ${c.item}: ${c.coverage}</div>`).join('')}
  </div>` : ''}
</body></html>`;
}

module.exports = { render };
