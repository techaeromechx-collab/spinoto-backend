/**
 * "Luxury" invoice theme — premium/boutique aesthetic.
 * Serif headline typography, centered/symmetric header, thin accent-colored
 * hairline rules with wide-letter-spaced section labels, generous line-height
 * and padding, sharp corners throughout (no rounding). The accent comes from
 * doc.accent (default #4f46e5) and is applied sparingly — as rule lines and
 * label colour rather than solid fills.
 *
 * ── The document contract ───────────────────────────────────────────────────
 * render({ doc, cfg }) — see simple.js, the reference implementation.
 *   doc — the canonical document from templates/documentAdapter.js. The same
 *         theme renders an estimate, a customer invoice or a purchase invoice;
 *         it never branches on doc.docType for DATA, only for cosmetics.
 *   cfg — resolveDocumentConfig(raw, docType, viewerRole)
 *
 * What appears — which columns, header rows, totals, whether terms/bank/
 * signature print — is decided by docShared.js. This theme decides only how
 * those things LOOK.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

// Maps docShared's semantic alignment onto this theme's CSS classes.
const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

// Totals row kinds → this theme's totals classes.
const totalsCls = (kind) => (kind === 'grand' ? 'grand' : kind === 'strong' ? 'balance' : 'line');

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 10.6, 12.7);
  const accent = doc.accent || '#4f46e5';
  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const thead = columns
    .map(c => `<th class="${cls(c.align)}">${c.label}</th>`)
    .join('');

  const itemsRows = (doc.items || []).map((it, i) => `
    <tr>${columns.map(c => `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`).join('')}</tr>`
  ).join('');

  // buildTotals already renders a negative as "- 1,234.00"; the theme only
  // moves the sign in front of the currency symbol, it never adds a second one.
  const amount = (t) => {
    const v = String(t.value);
    return v.startsWith('- ')
      ? `&minus; &#8377; ${v.slice(2)}`
      : `&#8377; ${v}`;
  };

  // GST breakup sits immediately under the Total GST row — either one IGST
  // line or a CGST/SGST pair, decided by place of supply in the adapter.
  const gstUnder = (t) => (t.key === 'gst' && gstLines.length
    ? gstLines.map(g => `<div class="line gst-line"><span>${g.label}</span><span>&#8377; ${g.value}</span></div>`).join('')
    : '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body {
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-size: 11px;
    color: #1a1a1a;
    line-height: 1.6;
    ${pageScale}
  }

  .header { text-align: center; margin-bottom: 22px; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .logo { height: 52px; width: auto; max-width: 170px; object-fit: contain; margin: 0 auto 10px; display: block; }
  .company-name { font-size: 22px; font-weight: 700; letter-spacing: .5px; }
  .company-meta { margin-top: 8px; font-size: 10.5px; color: #4a4a4a; font-family: Arial, Helvetica, sans-serif; letter-spacing: .2px; }
  .company-meta div { margin-bottom: 2px; }

  .rule { border: none; border-top: 1px solid ${accent}; margin: 20px 0; }
  .rule.thick { border-top-width: 2px; }

  .invoice-title { text-align: center; margin: 18px 0 20px; }
  .invoice-title h1 {
    font-size: 15px;
    font-weight: 400;
    letter-spacing: 6px;
    color: ${accent};
    text-transform: uppercase;
  }
  .invoice-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px 40px;
    margin-top: 10px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10.5px;
    color: #4a4a4a;
    letter-spacing: .3px;
  }
  .invoice-meta b { color: #1a1a1a; font-weight: 700; }

  .parties { display: flex; justify-content: space-between; gap: 30px; margin: 22px 0; }
  .party { flex: 1; }
  .party .label {
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 700;
    font-size: 9px;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: ${accent};
    margin-bottom: 8px;
  }
  .party .name { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .party .detail { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #3f3f3f; line-height: 1.7; }
  .party.right { text-align: right; }

  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-family: Arial, Helvetica, sans-serif; }
  thead th {
    text-align: left;
    font-size: 8.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: ${accent};
    padding: 8px 10px;
    border-top: 1px solid ${accent};
    border-bottom: 1px solid ${accent};
    font-weight: 700;
  }
  thead th.c { text-align: center; }
  thead th.r { text-align: right; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid #e2e2e2; vertical-align: top; font-size: 11px; }
  .c { text-align: center; }
  .r { text-align: right; }
  .b { font-weight: 700; }
  .empty { padding: 20px 10px; color: #8a8a8a; font-style: italic; letter-spacing: .5px; }

  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 18px; }
  .totals { width: 280px; font-family: Arial, Helvetica, sans-serif; }
  .totals .line { display: flex; justify-content: space-between; padding: 5px 0; font-size: 11px; color: #333; }
  .totals .line.discount { color: #7a3b1e; }
  .totals .gst-line { font-size: 9.5px; color: #8a8a8a; padding: 1px 0 1px 14px; letter-spacing: .3px; }
  .totals .grand {
    display: flex; justify-content: space-between;
    border-top: 2px solid ${accent};
    margin-top: 8px;
    padding-top: 10px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: .3px;
  }
  .totals .balance {
    display: flex; justify-content: space-between;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid #d8d8d8;
    font-size: 12px;
    font-weight: 700;
    color: ${accent};
  }

  .words {
    margin-top: 20px;
    text-align: center;
    font-style: italic;
    font-size: 11px;
    color: #3f3f3f;
    border-top: 1px solid #e2e2e2;
    border-bottom: 1px solid #e2e2e2;
    padding: 10px 0;
    letter-spacing: .2px;
  }

  .block { margin-top: 24px; }
  .block .label {
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 700; font-size: 9px; letter-spacing: 2.5px;
    text-transform: uppercase; color: ${accent}; margin-bottom: 8px;
  }
  .block .body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10px; color: #4a4a4a; line-height: 1.9;
  }

  .sign-row { display: flex; justify-content: flex-end; margin-top: 30px; }
  .sign { min-width: 220px; text-align: center; }
  .sign .for { font-size: 11px; font-weight: 700; letter-spacing: .3px; }
  .sign .space { height: 48px; }
  .sign .rule-line {
    border-top: 1px solid ${accent};
    padding-top: 6px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #4a4a4a;
  }

  .footer { margin-top: 34px; text-align: center; }
  .footer .label {
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 700; font-size: 9px; letter-spacing: 2.5px;
    text-transform: uppercase; color: ${accent}; margin-bottom: 8px;
  }
  .footer .terms {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10px; color: #4a4a4a; line-height: 1.9; max-width: 480px; margin: 0 auto;
  }
  .footer .thankyou { margin-top: 20px; font-style: italic; font-size: 12px; color: #1a1a1a; }
  .footer .disclaimer {
    margin-top: 6px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9px; color: #8a8a8a; letter-spacing: .2px;
  }

  /* Keeps the serif item name this theme has always used. */
  .ln-name { font-family: Georgia, 'Times New Roman', Times, serif; font-weight: 700; }
  .ln-desc { font-size: 9px; color: #6a6a6a; margin-top: 3px; line-height: 1.5; }
  .ln-hist { font-size: 8.5px; color: #9a9a9a; margin-top: 3px; font-style: italic; }
  .ln-sub  { font-size: 8.5px; color: #8a8a8a; }
  .ln-free { font-weight: 700; letter-spacing: 1px; color: ${accent}; }
  .sign-img { max-height: 58px; max-width: 150px; object-fit: contain; display: block; margin-left: auto; }
  .qr-blk { margin-top: 10px; }
  .party.right .qr-blk { text-align: right; }
  .qr-blk img { width: 66px; height: 66px; image-rendering: pixelated; }
  .qr-cap { font-size: 7px; color: #999; margin-top: 2px; }
</style></head>
<body>
  <div class="header">
    ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
    <div class="company-name">${esc(doc.seller.name)}</div>
    <div class="company-meta">
      ${sellerAddressHtml(doc)}${doc.seller.address.length ? '<br/>' : ''}
      ${doc.seller.gstin ? `GSTIN: ${esc(doc.seller.gstin)}${contact ? ' &nbsp;&nbsp;' : ''}` : ''}${contact}
    </div>
  </div>

  <hr class="rule thick"/>

  <div class="invoice-title">
    <h1>${esc(doc.title)}</h1>
    <div class="invoice-meta">
      ${header.map(f => `<div><b>${f.label}</b> ${f.value}</div>`).join('')}
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <div class="label">Billed To</div>
      <div class="name">${esc(doc.buyer.name)}</div>
      <div class="detail">
        ${buyerRows.map(r => `${r.label}: ${r.value}`).join('<br/>')}
      </div>
    </div>
    <div class="party right">
      <div class="label">Issued By</div>
      <div class="name">${esc(doc.seller.name)}</div>
      <div class="detail">
        ${doc.seller.gstin ? `GSTIN: ${esc(doc.seller.gstin)}<br/>` : ''}
        ${contact}
      </div>
      ${blocks.qrDataUri ? `<div class="qr-blk"><img src="${blocks.qrDataUri}" alt="" /><div class="qr-cap">${QR_CAPTION}</div></div>` : ''}
    </div>
  </div>


  <table>
    <thead><tr>${thead}</tr></thead>
    <tbody>${itemsRows || `<tr><td colspan="${columns.length}" class="c empty">No items</td></tr>`}</tbody>
  </table>

  <div class="totals-wrap">
    <div class="totals">
      ${totals.map(t => `<div class="${totalsCls(t.kind)}${t.key === 'discount' ? ' discount' : ''}"><span>${t.label}</span><span>${amount(t)}</span></div>${gstUnder(t)}`).join('')}
    </div>
  </div>

  ${blocks.amountInWords ? `<div class="words">${esc(amountInWords(grandTotalOf(doc)))}</div>` : ''}

  ${doc.notes ? `<div class="block"><div class="label">Notes</div><div class="body">${esc(doc.notes)}</div></div>` : ''}

  ${(doc.payments || []).length ? `
  <div class="block">
    <div class="label">Payments</div>
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

  ${blocks.bankDetails ? `<div class="block"><div class="label">Bank Details</div><div class="body">${blocks.bankDetails}</div></div>` : ''}

  ${blocks.signature ? `
  <div class="sign-row">
    <div class="sign">
      <div class="for">For ${esc(doc.seller.name)}</div>
      ${blocks.signatureUrl ? `<img class="sign-img" src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
      <div class="rule-line">${blocks.signature}</div>
    </div>
  </div>` : ''}

  <div class="footer">
    <hr class="rule"/>
    ${blocks.terms ? `<div class="label">Terms &amp; Conditions</div>
    <div class="terms">${blocks.terms}</div>` : ''}
    ${blocks.footerNote ? `<div class="thankyou">${blocks.footerNote}</div>` : ''}
    ${blocks.footerDisclaimer ? `<div class="disclaimer">${blocks.footerDisclaimer}</div>` : ''}
  </div>
  ${coverage.length ? `
  <div class="block">
    <div class="label">Warranty &amp; Guarantee</div>
    <div class="body">
      ${coverage.map(c => `<div>${c.type} — ${c.item}: ${c.coverage}</div>`).join('')}
    </div>
  </div>` : ''}
</body></html>`;
}

module.exports = { render };
