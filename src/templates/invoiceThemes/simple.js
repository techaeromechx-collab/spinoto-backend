/**
 * "Simple" theme — the reference implementation every other theme follows.
 * Minimal, monochrome, accent used only for two rules — optimised for
 * legibility and least ink on real paper.
 *
 * ── The document contract ───────────────────────────────────────────────────
 * render({ doc, cfg }) where:
 *   doc — the canonical document from templates/documentAdapter.js. Works for
 *         an estimate, a customer invoice or a purchase invoice; the theme
 *         never branches on doc.docType for DATA, only (rarely) for cosmetics.
 *   cfg — resolveDocumentConfig(raw, docType, viewerRole)
 *
 * A theme decides how things LOOK. What appears — which columns, which header
 * rows, which totals, whether terms/signature/bank print — is decided by
 * docShared.js. Anything hard-coded here that belongs there will silently
 * diverge across the other 8 themes.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

// Maps docShared's semantic alignment onto this theme's CSS classes.
const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 7.4, 8.5);
  const accent = doc.accent || '#4f46e5';
  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const thead = columns.map(c => `<th class="${cls(c.align)}">${c.label}</th>`).join('');
  const rows = (doc.items || []).map((it, i) =>
    `<tr>${columns.map(c => `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`).join('')}</tr>`
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; ${pageScale} }
  .row { display: flex; justify-content: space-between; }
  .company-name { font-size: 16px; font-weight: 700; }
  .muted { color: #555; line-height: 1.5; }
  .title { text-align: right; }
  .title h1 { font-size: 16px; letter-spacing: 1px; }
  /* Two fixed columns, both right-aligned, the pair pushed to the right edge.
     Previously each row was one line of inline text inside a text-align:right
     block with the label as a 96px inline-block. Because the label box sat
     BEFORE a variable-width value, every row started at a different x — so
     neither the labels nor the values lined up, they just shared a ragged
     right edge. Fixed widths on both cells give each column its own true
     edge; a long value wraps inside its column instead of shifting the row. */
  .meta { margin-top: 6px; font-size: 11px; }
  .meta .m { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 2px; line-height: 1.5; }
  .meta .k { width: 90px; flex-shrink: 0; text-align: right; font-weight: 700; }
  .meta .v { width: 120px; text-align: right; word-break: break-word; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .logo { height: 48px; width: auto; max-width: 160px; object-fit: contain; margin-bottom: 6px; }
  hr { border: none; border-top: 2px solid ${accent}; margin: 14px 0; }
  .bill-to { margin-top: 10px; }
  .bill-to .label { font-weight: 700; font-size: 10px; letter-spacing: .5px; color: #666; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  thead th { background: #f2f2f2; text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .3px; padding: 6px 8px; border-bottom: 2px solid ${accent}; }
  thead th.c { text-align: center; }
  thead th.r { text-align: right; }
  tbody td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .c { text-align: center; }
  .r { text-align: right; }
  .b { font-weight: 700; }
  .totals { width: 270px; margin-left: auto; margin-top: 14px; }
  .totals div.line { display: flex; justify-content: space-between; padding: 3px 0; }
  .totals .gst-line { color: #666; font-size: 10px; }
  .totals .grand { border-top: 1px solid #333; margin-top: 6px; padding-top: 6px; font-weight: 700; font-size: 13px; }
  .totals .strong { font-weight: 700; }
  .words { margin-top: 14px; font-size: 10px; font-style: italic; color: #444; border-left: 3px solid ${accent}; padding: 6px 10px; background: #fafafa; }

  /* Two short blocks on one row. align-items:stretch (the flex default) makes
     the accent bar on .words run the full row height instead of stopping at its
     own single line of text, so the two halves read as a matched pair. The row
     owns the top margin; the cells drop theirs or it would be doubled. */
  .side-row { display: flex; gap: 20px; align-items: stretch; margin-top: 14px; }
  .side-row > .side-cell { flex: 1 1 50%; min-width: 0; margin-top: 0; }
  .blocks { margin-top: 18px; display: flex; justify-content: space-between; gap: 24px; }
  .blocks .bk { font-size: 9.5px; color: #555; line-height: 1.6; max-width: 55%; }
  .blocks .bk .h { font-weight: 700; color: #333; margin-bottom: 3px; }
  .sign { text-align: right; font-size: 9.5px; color: #555; min-width: 170px; }
  .sign .space { height: 42px; }
  .sign .rule { border-top: 1px solid #999; padding-top: 3px; }
  .pay { margin-top: 16px; }
  .pay .h { font-weight: 700; font-size: 10px; letter-spacing: .5px; color: #666; margin-bottom: 4px; }
  .footer { margin-top: 26px; padding-top: 8px; border-top: 1px solid #ddd; text-align: center; font-size: 9.5px; color: #555; line-height: 1.6; }
  .ln-name { font-weight: 600; }
  .ln-desc { font-size: 9px; color: #666; margin-top: 2px; line-height: 1.4; }
  .ln-hist { font-size: 8.5px; color: #999; margin-top: 2px; font-style: italic; }
  .ln-sub  { font-size: 9px; color: #888; }
  .ln-free { font-weight: 700; letter-spacing: .5px; }
  .sign-img { max-height: 58px; max-width: 150px; object-fit: contain; display: block; margin-left: auto; }
  .qr-blk { margin-top: 8px; text-align: right; }
  .qr-blk img { width: 66px; height: 66px; image-rendering: pixelated; }
  .qr-cap { font-size: 7px; color: #999; margin-top: 2px; }
</style></head>
<body>
  <div class="row">
    <div>
      ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
      <div class="company-name">${esc(doc.seller.name)}</div>
      <div class="muted">
        ${sellerAddressHtml(doc)}${doc.seller.address.length ? '<br/>' : ''}
        ${doc.seller.gstin ? `GSTIN: ${esc(doc.seller.gstin)}<br/>` : ''}
        ${contact}
      </div>
    </div>
    <div class="title">
      <h1>${esc(doc.title)}</h1>
      <div class="meta">
        ${header.map(f => `<div class="m"><div class="k">${f.label}</div><div class="v">${f.value}</div></div>`).join('')}
      </div>
      ${blocks.qrDataUri ? `<div class="qr-blk"><img src="${blocks.qrDataUri}" alt="" /><div class="qr-cap">${QR_CAPTION}</div></div>` : ''}
    </div>
  </div>

  <hr/>

  <div class="bill-to">
    <div class="label">BILL TO</div>
    <div class="b">${esc(doc.buyer.name)}</div>
    <div class="muted">
      ${buyerRows.map(r => `${r.label}: ${r.value}`).join('<br/>')}
    </div>
  </div>

  <table>
    <thead><tr>${thead}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${columns.length}" class="c muted">No items</td></tr>`}</tbody>
  </table>

  <div class="totals">
    ${totals.map(t => {
      const cl = t.kind === 'grand' ? 'grand' : t.kind === 'strong' ? 'strong' : '';
      const gst = t.key === 'gst' && gstLines.length
        ? gstLines.map(g => `<div class="line gst-line"><span>${g.label}</span><span>₹ ${g.value}</span></div>`).join('')
        : '';
      return `<div class="line ${cl}"><span>${t.label}</span><span>₹ ${t.value}</span></div>${gst}`;
    }).join('')}
  </div>

  ${/* Amount-in-words and Notes share a row. Both are one or two lines, so
        stacking them full-width left two near-empty bands under the totals.
        Either alone goes full width — a lone half-width block with the other
        half blank reads as a rendering fault. */''}
  ${(blocks.amountInWords && doc.notes) ? `
  <div class="side-row">
    <div class="words side-cell">${esc(amountInWords(grandTotalOf(doc)))}</div>
    <div class="pay side-cell"><div class="h">NOTES</div><div class="muted">${esc(doc.notes)}</div></div>
  </div>` : blocks.amountInWords
    ? `<div class="words">${esc(amountInWords(grandTotalOf(doc)))}</div>`
    : doc.notes
      ? `<div class="pay"><div class="h">NOTES</div><div class="muted">${esc(doc.notes)}</div></div>`
      : ''}

  ${coverage.length ? `
  <div class="pay">
    <div class="h">WARRANTY &amp; GUARANTEE</div>
    <table>
      <thead><tr><th>Service / Package</th><th>Type</th><th>Coverage / Validity</th></tr></thead>
      <tbody>${coverage.map(c => `<tr><td>${c.item}</td><td>${c.type}</td><td>${c.coverage}</td></tr>`).join('')}</tbody>
    </table>
  </div>` : ''}

  ${/* NOTES is rendered above, beside the amount in words. */''}

  ${(doc.payments || []).length ? `
  <div class="pay">
    <div class="h">PAYMENTS</div>
    <table>
      <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead>
      <tbody>${doc.payments.map(p => `<tr>
        <td>${esc(String(p.date || '').slice(0, 10))}</td>
        <td>${esc(p.method || '')}</td>
        <td>${esc(p.reference || '—')}</td>
        <td class="r b">${money(p.amount)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>` : ''}

  ${(blocks.terms || blocks.bankDetails || blocks.signature) ? `
  <div class="blocks">
    <div class="bk">
      ${blocks.terms ? `<div class="h">Terms &amp; Conditions</div><div>${blocks.terms}</div>` : ''}
      ${blocks.bankDetails ? `<div class="h" style="margin-top:8px">Bank Details</div><div>${blocks.bankDetails}</div>` : ''}
    </div>
    ${blocks.signature ? `<div class="sign">
      <div>For ${esc(doc.seller.name)}</div>
      ${blocks.signatureUrl ? `<img class="sign-img" src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
      <div class="rule">${blocks.signature}</div>
    </div>` : ''}
  </div>` : ''}

  <div class="footer">
    ${blocks.footerNote ? `${blocks.footerNote}<br/>` : ''}
    ${blocks.footerDisclaimer ? `${blocks.footerDisclaimer}` : ''}
  </div>
</body></html>`;
}

module.exports = { render };
