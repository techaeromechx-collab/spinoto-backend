/**
 * "Stylish" theme — the clean, borderless MyBillBook-style tax invoice.
 *
 * Rebuilt to match the supplied reference exactly. Where "Advanced GST" is a
 * fully-ruled form (every cell boxed), this is its opposite: almost no rules at
 * all. Structure comes from whitespace, weight and three hairlines.
 *
 *   TAX INVOICE  [ORIGINAL FOR RECIPIENT]        ← plain title row
 *          logo   COMPANY NAME (large, centred)
 *                 address · mobile · GSTIN · email
 *   ┌──────────────────────────────────────────┐ ← grey meta band
 *   │ Invoice No. │ Invoice Date │ Due Date    │
 *   └──────────────────────────────────────────┘
 *   BILL TO                              [ QR ]
 *   Party name, address, GSTIN, place of supply
 *   ──────────────────────────────────────────── hairline
 *   ITEMS  HSN  QTY  RATE  DISC.  TAX   AMOUNT   ← no vertical rules
 *   ...items, then the band stretches...
 *   ──────────────────────────────────────────── hairline
 *   SUBTOTAL          4    1,051.43  1,724.57  12,816
 *   ────────────────────────────────────────────
 *   BANK DETAILS          │      Taxable Amount
 *   NOTES                 │      IGST @5% / @18%
 *   TERMS AND CONDITIONS  │      ═ Total Amount ═
 *                         │      Received Amount
 *                         │      Amount in words
 *                         │      [stamp] AUTHORISED SIGNATORY
 *
 * The item band stretches to fill the page so SUBTOTAL sits low and the lower
 * section stays pinned near the bottom, the way pre-printed stationery does.
 *
 * Deliberately near-monochrome, like the reference. The accent colour is used
 * for one thing only — the grand-total figure — so the colour picker still
 * does something without turning this into a different design.
 *
 * Contract: render({ doc, cfg, pageSize }) — see simple.js. Layout only; which
 * columns/fields/blocks exist comes from docShared.js.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

// Which columns carry a figure in the SUBTOTAL row. Everything else prints
// blank so the row stays aligned however many columns are switched on.
const SUM_OF = {
  qty: 'qty',
  disc: 'disc',
  gst: 'tax',          // single combined GST column
  tax_amount: 'tax',   // ...or the split-tax variant's amount column
  amount: 'amount',
};

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 12, 10);
  const accent = doc.accent || '#4f46e5';

  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const items = doc.items || [];

  const sums = items.reduce((a, it) => ({
    qty: a.qty + Number(it.qty || 0),
    disc: a.disc + Number(it.discount || 0),
    tax: a.tax + Number(it.gstAmount || 0),
    amount: a.amount + Number(it.total || 0),
  }), { qty: 0, disc: 0, tax: 0, amount: 0 });

  const thead = columns.map(c => `<th class="${cls(c.align)}">${c.label}</th>`).join('');

  const rows = items.map((it, i) =>
    `<tr>${columns.map(c => `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`).join('')}</tr>`
  ).join('');

  // Absorbs the page's slack so SUBTOTAL is pushed to the foot of the band.
  const filler = `<tr class="filler">${columns.map(() => '<td></td>').join('')}</tr>`;

  // "SUBTOTAL" spans the first two columns (# and Item); each summable column
  // then prints its own figure directly under its own heading.
  const subtotalRow = columns.map((c, i) => {
    if (i === 0) return '<td class="b" colspan="2">SUBTOTAL</td>';
    if (i === 1) return '';                        // absorbed by the colspan
    const key = SUM_OF[c.key];
    if (!key) return '<td></td>';
    if (key === 'qty') return `<td class="${cls(c.align)} b">${sums.qty}</td>`;
    return `<td class="${cls(c.align)} b">₹ ${money(sums[key])}</td>`;
  }).join('');

  // The reference prints the rate-wise GST lines (IGST @5%, IGST @18%) in place
  // of a single lumped "GST" row, so the generic row is swapped out whenever a
  // breakup is available.
  const totalsHtml = totals.map(t => {
    if (t.key === 'gst' && gstLines.length) {
      return gstLines.map(g =>
        `<div class="trow"><span>${g.label}</span><span>₹ ${g.value}</span></div>`
      ).join('');
    }
    if (t.kind === 'grand') {
      return `<div class="trow trow--grand"><span>${t.label}</span><span>₹ ${t.value}</span></div>`;
    }
    if (t.kind === 'strong') {
      return `<div class="trow trow--strong"><span>${t.label}</span><span>₹ ${t.value}</span></div>`;
    }
    return `<div class="trow"><span>${t.label}</span><span>₹ ${t.value}</span></div>`;
  }).join('');

  const billLabel = doc.docType === 'purchase_invoice' ? 'BILL TO (HUB)' : 'BILL TO';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body {
    font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    ${pageScale}
  }

  /* Flex column so the item band can absorb the page's slack. */
  .sheet { display: flex; flex-direction: column; min-height: 265mm; }

  /* ── title row ── */
  .topbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .topbar .t { font-size: 10px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; }
  .topbar .copy { border: 1px solid #bbb; color: #555; font-size: 7.5px; letter-spacing: .3px; padding: 2px 6px; text-transform: uppercase; }

  /* ── letterhead: logo pinned left, company block centred in what remains ── */
  .hd { display: flex; align-items: center; gap: 14px; padding: 0 0 16px; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .hd .logo { height: 52px; width: auto; max-width: 110px; object-fit: contain; flex-shrink: 0; }
  .hd .co { flex: 1; min-width: 0; text-align: center; }
  .hd .co-name { font-size: 19px; font-weight: 700; line-height: 1.2; letter-spacing: -.2px; text-transform: uppercase; }
  .hd .co-addr { margin-top: 6px; line-height: 1.6; color: #333; }
  .hd .co-ids { margin-top: 3px; line-height: 1.6; color: #333; }
  .hd .co-ids b { font-weight: 700; color: #111; }

  /* ── meta band ── */
  .metaband {
    display: flex; flex-wrap: wrap;
    background: #f4f4f4; border-top: 1px solid #e2e2e2; border-bottom: 1px solid #e2e2e2;
    padding: 9px 4px;
  }
  .mcell { flex: 1 1 33%; min-width: 33%; padding: 3px 10px; line-height: 1.5; }
  .mcell b { font-weight: 700; }

  /* ── parties ── */
  .parties { display: flex; align-items: flex-start; gap: 20px; padding: 14px 0 16px; }
  .p-left { flex: 1; min-width: 0; }
  .lbl { font-weight: 700; letter-spacing: .3px; text-transform: uppercase; margin-bottom: 7px; }
  .pname { font-weight: 700; font-size: 10px; margin-bottom: 5px; }
  .prow { line-height: 1.7; color: #333; }
  .p-right { flex-shrink: 0; text-align: center; }
  .p-right img { width: 66px; height: 66px; image-rendering: pixelated; }
  .qr-cap { font-size: 6.5px; color: #888; margin-top: 2px; }

  /* ── items ──
     No vertical rules anywhere: this layout is held together by whitespace and
     three hairlines (above the header, above SUBTOTAL, below it). The band is
     a plain block, NOT a flex container — as a flex item the table would size
     to its content and ignore height:100%, leaving SUBTOTAL floating directly
     under the last row instead of at the foot of the page. */
  .items-band { flex: 1; }
  table.items { width: 100%; border-collapse: collapse; height: 100%; }
  table.items th {
    border-top: 1px solid #111; border-bottom: 1px solid #111;
    padding: 8px 6px; font-size: 8.5px; font-weight: 700; letter-spacing: .4px;
    text-align: left; text-transform: uppercase; color: #111;
  }
  table.items th.c, table.items td.c { text-align: center; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items td { padding: 9px 6px; vertical-align: top; line-height: 1.5; }
  table.items tbody tr:first-child td { padding-top: 12px; }
  /* Takes ALL the leftover height, so the item rows keep their natural spacing
     instead of being stretched apart to fill the page. */
  table.items tr.filler { height: 100%; }
  table.items tr.filler td { padding: 0; }
  /* In <tbody>, not <tfoot>: a table-footer-group repeats at the foot of every
     page in paged media, so a long invoice would carry SUBTOTAL on each one. */
  table.items tr.totrow td {
    border-top: 1px solid #111; border-bottom: 1px solid #111;
    padding: 9px 6px; font-weight: 700;
  }
  .b { font-weight: 700; }
  .empty { text-align: center; color: #888; padding: 20px 6px; }

  /* ── lower section ── */
  .lower { display: flex; gap: 26px; padding-top: 14px; align-items: flex-start; }
  .lo-left { flex: 1; min-width: 0; }
  .lo-right { width: 250px; flex-shrink: 0; }

  .blk { margin-bottom: 14px; }
  .blk .h { font-weight: 700; letter-spacing: .3px; text-transform: uppercase; margin-bottom: 6px; }
  .blk .body { color: #333; line-height: 1.65; }
  .kv { display: flex; line-height: 1.7; }
  .kv .k { width: 74px; flex-shrink: 0; color: #333; }
  .kv .v { flex: 1; font-weight: 700; word-break: break-word; }

  table.mini { width: 100%; border-collapse: collapse; }
  table.mini th { text-align: left; font-size: 8px; font-weight: 700; color: #555; padding: 4px 6px 4px 0; border-bottom: 1px solid #e2e2e2; }
  table.mini td { padding: 4px 6px 4px 0; color: #333; line-height: 1.5; border-bottom: 1px solid #f0f0f0; }
  table.mini tr:last-child td { border-bottom: none; }

  /* Totals stack — right-aligned, the grand total ruled above and below. */
  .trow { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; line-height: 1.5; color: #333; }
  .trow span:last-child { font-weight: 700; color: #111; white-space: nowrap; }
  .trow--grand {
    border-top: 1px solid #111; border-bottom: 1px solid #111;
    margin: 6px 0; padding: 7px 0; font-weight: 700; color: #111;
  }
  .trow--grand span:last-child { color: ${accent}; }
  .trow--strong { font-weight: 700; color: #111; }

  .words { margin-top: 14px; text-align: right; }
  .words .h { font-weight: 700; margin-bottom: 3px; }
  .words .v { color: #333; line-height: 1.55; }

  .sign { margin-top: 20px; text-align: right; }
  .sign .space { height: 46px; }
  .sign img { max-height: 62px; max-width: 130px; object-fit: contain; display: block; margin-left: auto; margin-bottom: 4px; }
  .sign .who { font-weight: 700; letter-spacing: .2px; text-transform: uppercase; line-height: 1.5; }

  .tail { margin-top: 12px; text-align: center; color: #666; font-size: 7.5px; line-height: 1.5; }

  /* Line-item sub-text. Block display puts "(10%)" UNDER the discount amount
     and "(18%)" under the tax amount, as the reference does. */
  .ln-name { font-weight: 400; }
  .ln-desc { font-size: 8px; color: #777; margin-top: 2px; line-height: 1.4; }
  .ln-hist { font-size: 7.5px; color: #999; margin-top: 1px; font-style: italic; }
  .ln-sub  { display: block; font-size: 7.5px; color: #888; font-weight: 400; }
  .ln-free { font-weight: 700; color: ${accent}; }
</style></head>
<body>
<div class="sheet">

  <div class="topbar">
    <span class="t">${esc(doc.title)}</span>
    <span class="copy">Original for Recipient</span>
  </div>

  <div class="hd">
    ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
    <div class="co">
      <div class="co-name">${esc(doc.seller.name)}</div>
      <div class="co-addr">${sellerAddressHtml(doc)}</div>
      <div class="co-ids">
        ${doc.seller.phone ? `<b>Mobile:</b> ${esc(doc.seller.phone)}` : ''}
        ${doc.seller.phone && doc.seller.gstin ? '&nbsp;&nbsp;&nbsp;' : ''}
        ${doc.seller.gstin ? `<b>GSTIN:</b> ${esc(doc.seller.gstin)}` : ''}
      </div>
      ${contact ? `<div class="co-ids">${contact}</div>` : ''}
    </div>
  </div>

  <div class="metaband">
    ${header.map(f => `<div class="mcell"><b>${f.label}:</b> ${f.value}</div>`).join('')}
  </div>

  <div class="parties">
    <div class="p-left">
      <div class="lbl">${billLabel}</div>
      <div class="pname">${esc(doc.buyer.name)}</div>
      ${(doc.buyer.address || []).length
        ? `<div class="prow">${(doc.buyer.address || []).map(esc).join('<br/>')}</div>`
        : ''}
      ${buyerRows.map(r => `<div class="prow">${r.label}: ${r.value}</div>`).join('')}
    </div>
    ${blocks.qrDataUri
      ? `<div class="p-right"><img src="${blocks.qrDataUri}" alt="" /><div class="qr-cap">${QR_CAPTION}</div></div>`
      : ''}
  </div>

  <div class="items-band">
    <table class="items">
      <thead><tr>${thead}</tr></thead>
      <tbody>
        ${rows || `<tr><td class="empty" colspan="${columns.length}">No items</td></tr>`}
        ${filler}
        <tr class="totrow">${subtotalRow}</tr>
      </tbody>
    </table>
  </div>

  <div class="lower">
    <div class="lo-left">
      ${blocks.bankRows.length ? `
      <div class="blk">
        <div class="h">Bank Details</div>
        ${blocks.bankRows.map(r => `<div class="kv"><div class="k">${r.label}:</div><div class="v">${r.value}</div></div>`).join('')}
      </div>` : (blocks.bankDetails ? `
      <div class="blk">
        <div class="h">Bank Details</div>
        <div class="body">${blocks.bankDetails}</div>
      </div>` : '')}

      ${doc.notes ? `
      <div class="blk">
        <div class="h">Notes</div>
        <div class="body">${esc(doc.notes)}</div>
      </div>` : ''}

      ${blocks.terms ? `
      <div class="blk">
        <div class="h">Terms and Conditions</div>
        <div class="body">${blocks.terms}</div>
      </div>` : ''}

      ${coverage.length ? `
      <div class="blk">
        <div class="h">Warranty &amp; Guarantee</div>
        <table class="mini">
          <thead><tr><th>Item</th><th>Type</th><th>Coverage</th></tr></thead>
          <tbody>${coverage.map(c => `<tr><td>${c.item}</td><td>${c.type}</td><td>${c.coverage}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      ${(doc.payments || []).length ? `
      <div class="blk">
        <div class="h">Payments</div>
        <table class="mini">
          <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead>
          <tbody>${doc.payments.map(p => `<tr>
            <td>${esc(String(p.date || '').slice(0, 10))}</td>
            <td>${esc(p.method || '')}</td>
            <td>${esc(p.reference || '—')}</td>
            <td class="r b">${money(p.amount)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
    </div>

    <div class="lo-right">
      ${totalsHtml}

      ${blocks.amountInWords ? `
      <div class="words">
        <div class="h">Total Amount (in words)</div>
        <div class="v">${esc(amountInWords(grandTotalOf(doc)))}</div>
      </div>` : ''}

      ${blocks.signature ? `
      <div class="sign">
        ${blocks.signatureUrl
          ? `<img src="${blocks.signatureUrl}" alt="" />`
          : '<div class="space"></div>'}
        <div class="who">${blocks.signature} for<br/>${esc(doc.seller.name)}</div>
      </div>` : ''}
    </div>
  </div>

  ${(blocks.footerNote || blocks.footerDisclaimer) ? `
  <div class="tail">
    ${blocks.footerNote ? `${blocks.footerNote}<br/>` : ''}
    ${blocks.footerDisclaimer || ''}
  </div>` : ''}

</div>
</body></html>`;
}

module.exports = { render };
