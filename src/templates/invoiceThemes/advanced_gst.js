/**
 * "Advanced GST" theme — the formal, fully-ruled Indian tax-invoice layout.
 *
 * Everything sits inside one outer border, divided into stacked bordered
 * bands, in the order a GST officer reads them:
 *
 *   TAX INVOICE  [ORIGINAL FOR RECIPIENT]      ← title bar, outside the box
 *   ┌──────────────────────┬───────────────────────────────┐
 *   │ logo + seller block  │ Invoice No. │ Date │ Due Date │
 *   ├──────────────────────┼───────────────────────────────┤
 *   │ BILL TO (party)      │ notes                          │
 *   ├──────────────────────┴───────────────────────────────┤
 *   │ item grid — stretches to fill the page                │
 *   ├───────────────────────────────────────────────────────┤
 *   │ TOTAL  ·  RECEIVED AMOUNT                             │
 *   ├───────────────────────────────────────────────────────┤
 *   │ HSN/SAC-wise tax summary (rate-wise, legally required) │
 *   ├───────────────────────────────────────────────────────┤
 *   │ Total Amount (in words)                               │
 *   ├──────────────────────┬───────────────────────────────┤
 *   │ Terms and Conditions │ Bank Details + signature       │
 *   └──────────────────────┴───────────────────────────────┘
 *
 * The item band uses flex:1 so a short invoice still fills the page and the
 * summary bands stay pinned near the bottom — the way pre-printed stationery
 * behaves — while a long invoice simply grows and paginates.
 *
 * Contract: render({ doc, cfg }) — see simple.js. Layout only; which
 * columns/fields/blocks exist comes from docShared.js.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildBlocks, buildHsnSummary,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS,
  // Aliased: render() has a local `pageScale` holding the CSS string, which
  // would shadow this function and fail at runtime with "not a function".
  pageScale: pageScaleRatio,
  QR_CAPTION,
} = require('./docShared');

const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

// Columns carrying a total in the TOTAL band; everything else stays blank so
// the band aligns however many columns are switched on.
const TOTAL_COLS = { qty: 'qty', disc: 'disc', gst: 'gst', amount: 'amount' };

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 12, 10);

  // The QR resists the A5 page zoom.
  //
  // Everything else on an A5 sheet shrinks to 70.5% — correct for text, wrong
  // for a QR, which has an absolute physical floor of roughly 10mm before a
  // phone camera stops resolving it. At a flat 52px, A4 prints 13.8mm but A5
  // prints only 9.7mm: unscannable. Dividing by the page scale cancels the
  // zoom, so both sheets print the same 13.8mm.
  const QR_PX = Math.round(52 / pageScaleRatio(pageSize));
  const accent = doc.accent || '#4f46e5';
  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const hsn = buildHsnSummary(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const items = doc.items || [];

  const sums = items.reduce((a, it) => ({
    qty: a.qty + Number(it.qty || 0),
    disc: a.disc + Number(it.discount || 0),
    gst: a.gst + Number(it.gstAmount || 0),
    amount: a.amount + Number(it.total || 0),
  }), { qty: 0, disc: 0, gst: 0, amount: 0 });

  // ── Shared column widths ────────────────────────────────────────────────
  // The item grid, the empty spacer and the TOTAL row are three separate
  // elements now, so their columns only line up if they're driven by ONE set
  // of widths. table-layout:fixed then honours these exactly instead of
  // sizing to content, which would drift between the two tables.
  //
  // "#" is narrow, every numeric column gets an equal share, and the item name
  // absorbs whatever is left — clamped so a document with many optional columns
  // can't squeeze it to nothing.
  const SR_W = 3.5, ITEM_MIN_W = 18, OTHER_MAX_W = 8.5;
  const otherCount = Math.max(0, columns.length - 2);
  const otherW = otherCount
    ? Math.min(OTHER_MAX_W, (100 - SR_W - ITEM_MIN_W) / otherCount)
    : 0;
  const itemW = 100 - SR_W - otherW * otherCount;
  const colWidths = columns.map((c, i) => (i === 0 ? SR_W : i === 1 ? itemW : otherW));
  const colgroup = `<colgroup>${colWidths.map(w => `<col style="width:${w.toFixed(3)}%" />`).join('')}</colgroup>`;

  const thead = columns.map(c => `<th class="${cls(c.align)}">${c.label}</th>`).join('');
  const rows = items.map((it, i) =>
    `<tr>${columns.map(c => `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`).join('')}</tr>`
  ).join('');

  // "TOTAL" spans the first two columns (# and Item), then each summable
  // column prints its own total under its own heading.
  const totalRow = columns.map((c, i) => {
    if (i === 0) return '<td class="r b" colspan="2">TOTAL</td>';
    if (i === 1) return '';                       // absorbed by the colspan
    const key = TOTAL_COLS[c.key];
    if (!key) return '<td></td>';
    if (key === 'qty') return `<td class="${cls(c.align)} b">${sums.qty}</td>`;
    return `<td class="${cls(c.align)} b">₹ ${money(sums[key])}</td>`;
  }).join('');

  const paid = totals.find(t => t.key === 'paid');
  const grand = totals.find(t => t.key === 'grand');

  // Built as inner fragments so the same content can be dropped into either a
  // half-width cell or a full-width one, depending on whether both exist.
  const wordsInner = (blocks.amountInWords && grand)
    ? `<div class="lbl">Total Amount (in words)</div>
       <div>${esc(amountInWords(grandTotalOf(doc)))}</div>`
    : null;

  const paymentsInner = (doc.payments || []).length
    ? `<div class="lbl">Payments</div>` + doc.payments.map(p => `<div class="kv">
         <span class="k">${esc(String(p.date || '').slice(0, 10))}</span>
         <span class="v">${esc(p.method || '')}${p.reference ? ` · ${esc(p.reference)}` : ''} — ₹ ${money(p.amount)}</span>
       </div>`).join('')
    : null;

  // The QR is rendered as one more cell in the meta grid rather than floated
  // beside it. In a ruled-form layout an element that sits outside the grid
  // has nowhere to align to — it ends up squeezed into whatever space is left
  // on the right edge, which is exactly how it looked before.
  // The QR now lives in the seller cell (see .seller below), not as a trailing
  // meta cell — so the meta grid is purely Invoice No. / Date / Status etc.
  const metaCells = header.map(f =>
    `<div class="mcell"><div class="mk">${f.label}</div><div class="mv">${f.value}</div></div>`
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body {
    font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #000;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    ${pageScale}
  }

  /* Flex column so the item band can absorb the page's slack. */
  .sheet { display: flex; flex-direction: column; min-height: 265mm; }

  /* Title strip: text on the left, logo on the PAGE centre.
     A 1fr auto 1fr grid, because the two 1fr tracks are always equal — so the
     middle track is exactly page-centred whatever the title's width.
     My first attempt used flex with an equal-grow spacer either side of the
     logo, which is NOT the same thing: with content on the left only, that
     centres the logo in the space LEFT OVER, pushing it right of centre by half
     the title's width. Grid has no such asymmetry. */
  .titlebar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin-bottom: 4px; }
  .titlebar .t { font-size: 12px; font-weight: 700; letter-spacing: .3px; white-space: nowrap; }
  /* Deliberately smaller than the old in-box logo. This is the dense, formal
     layout; every mm the header grows is taken straight off the item band. */
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .titlebar .logo { height: 34px; width: auto; max-width: 130px; object-fit: contain; justify-self: center; }

  .box { border: 1px solid #000; display: flex; flex-direction: column; flex: 1; }
  .band { display: flex; border-bottom: 1px solid #000; }
  .band:last-child { border-bottom: none; }
  .cellL { flex: 1; min-width: 0; padding: 7px 9px; border-right: 1px solid #000; }
  .cellR { width: 47%; flex-shrink: 0; padding: 0; }

  /* Everything on one left edge. The logo used to live here, which forced the
     text to centre in the space beside it; with the logo up in the title bar
     the name, address and ids can all share a single left margin — which is
     what a formal tax invoice wants. */
  /* Details on the left, QR pinned to the right of the SAME cell. The cell had
     a lot of dead space under the address once the logo moved to the title
     bar; this fills it without pushing anything down. align-items:flex-start
     keeps the QR level with the company name rather than centred against a
     tall address block. */
  .seller { display: flex; gap: 14px; align-items: flex-start; min-width: 0; }
  .seller .info { flex: 1; min-width: 0; text-align: left; }
  .seller .sqr { flex-shrink: 0; text-align: center; }
  /* Size comes from QR_PX, which cancels the A5 page zoom — see above. */
  .seller .sqr img { width: ${QR_PX}px; height: ${QR_PX}px; image-rendering: pixelated; display: block; }
  .seller .name { font-size: 11px; font-weight: 700; line-height: 1.3; text-transform: uppercase; }
  .seller .addr { line-height: 1.55; margin-top: 2px; }
  /* Two columns: labels on one left edge, values on a second. A fixed label
     width is what aligns the values — sizing it to the content would put each
     value wherever its own label happened to end. 46px fits "Mobile:" at 9px
     Arial with room to spare; a longer label wraps its value rather than
     shunting the column. */
  .seller .ids { margin-top: 4px; }
  .seller .idrow { display: flex; line-height: 1.6; }
  .seller .idrow .ik { width: 46px; flex-shrink: 0; font-weight: 700; }
  .seller .idrow .iv { flex: 1; min-width: 0; word-break: break-word; }

  .meta { display: flex; flex-wrap: wrap; height: 100%; }
  .mcell { flex: 1 1 33%; min-width: 33%; padding: 7px 8px; text-align: center; border-right: 1px solid #000; border-bottom: 1px solid #000; }
  .mcell:last-child { border-right: none; }
  .mk { font-weight: 700; margin-bottom: 3px; }

  .lbl { font-weight: 700; margin-bottom: 3px; }
  .pname { font-weight: 700; text-transform: uppercase; }
  .prow { line-height: 1.6; }

  /* Two stacked tables, not one table stretched with percentage heights.
     ────────────────────────────────────────────────────────────────────────
     Earlier attempts hung the empty space off a height:100% table plus a
     height:100% filler row. That chain — row % of table, table % of a
     flex-sized band — kept collapsing to zero, so the table ended at its last
     item and the leftover space fell OUTSIDE the table, unruled, with TOTAL
     stranded up under the items. Percentage heights through a table are the
     fragile part.

     Now the band is a flex column holding three plain blocks:
       .items-grid   the item rows          (natural height)
       .items-fill   flex:1 spacer          (takes ALL the slack)
       .items-total  the TOTAL row          (natural height, sits at the foot)
     flex-grow on a block is unconditional — nothing to resolve, nothing to
     collapse. The spacer draws the column rules itself, so the grid continues
     through the empty area. */
  .items-band { flex: 1; border-bottom: 1px solid #000; display: flex; flex-direction: column; }
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.items th { border-bottom: 1px solid #000; border-right: 1px solid #000; padding: 6px; font-size: 8.5px; font-weight: 700; text-align: left; text-transform: uppercase; background: #f2f2f2; }
  table.items th:last-child, table.items td:last-child { border-right: none; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items td { border-right: 1px solid #000; padding: 6px; vertical-align: top; }
  /* The ruled empty area. flex:1 gives the table a definite USED height (not a
     percentage — that's what kept collapsing), and a table hands surplus
     height to its rows, so the single empty row fills the gap and carries the
     column rules down. */
  table.items-fill { flex: 1; }
  table.items-fill td { border-right: 1px solid #000; border-bottom: none; padding: 0; }
  table.items-fill td:last-child { border-right: none; }
  /* TOTAL band — shaded like the header so it reads as a summary row. */
  /* The TOTAL row lives in <tbody>, not <tfoot>. A table-footer-group repeats
     at the bottom of EVERY page in paged media, so a three-page invoice would
     print "TOTAL" on pages 1 and 2 as well. As an ordinary last row it appears
     once, where it belongs. */
  table.items tr.totrow td { border-top: 1px solid #000; padding: 6px; background: #f2f2f2; }
  /* Its own table so it can sit below the spacer. Shares the colgroup with the
     item grid, so the columns stay aligned across the gap. */
  table.items-total { flex-shrink: 0; }
  .b { font-weight: 700; }

  .recv { display: flex; justify-content: space-between; padding: 6px 9px; border-bottom: 1px solid #000; font-weight: 700; }

  table.hsn { width: 100%; border-collapse: collapse; }
  table.hsn th, table.hsn td { border-right: 1px solid #000; border-bottom: 1px solid #000; padding: 5px 6px; font-size: 8.5px; }
  table.hsn th { font-weight: 700; text-align: center; background: #f2f2f2; }
  table.hsn td { text-align: right; }
  table.hsn td.c { text-align: center; }
  /* .lastcol, NOT :last-child.
     :last-child means "last cell in its ROW", which is only the same thing as
     "last column" in a plain grid. This header has two rows and uses rowspan:
       row 1   HSN/SAC | Taxable Value | CGST(x2) | SGST(x2) | Total Tax Amount
       row 2                             Rate|Amt | Rate|Amt
     so in row 2 the last cell is SGST's Amount — and stripping ITS right
     border removed the very line separating it from Total Tax Amount, leaving
     the rule broken partway down the header. The class is put only on cells
     genuinely in the final column. */
  table.hsn th.lastcol, table.hsn td.lastcol { border-right: none; }
  /* Same reasoning for the foot: the enclosing band draws the bottom edge. */
  table.hsn tr.tot td { border-bottom: none; }
  table.hsn tr.tot td { font-weight: 700; }

  .words { padding: 7px 9px; }
  .words .h { font-weight: 700; margin-bottom: 2px; }

  .halfL { flex: 1; min-width: 0; padding: 7px 9px; border-right: 1px solid #000; }
  .halfR { width: 47%; flex-shrink: 0; padding: 7px 9px; }
  .kv { display: flex; line-height: 1.7; }
  .kv .k { width: 78px; flex-shrink: 0; }
  .kv .v { flex: 1; }
  .terms { line-height: 1.65; }

  .sign { text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
  .sign .space { height: 44px; }
  .sign .who { line-height: 1.45; }
  .sign-img { max-height: 52px; max-width: 130px; object-fit: contain; margin-bottom: 3px; }

  .tail { margin-top: 5px; text-align: center; color: #555; font-size: 7.5px; line-height: 1.5; }

  .ln-desc { font-size: 8px; color: #666; margin-top: 1px; line-height: 1.35; }
  .ln-hist { font-size: 7.5px; color: #888; margin-top: 1px; font-style: italic; }
  .ln-sub  { display: block; font-size: 7.5px; color: #666; }
  .ln-free { font-weight: 700; color: ${accent}; }
  /* .mcell--qr is gone — the QR moved into the seller cell above. */
  .qr-cap { font-size: 5.5px; color: #666; margin-top: 2px; }
</style></head>
<body>
<div class="sheet">

  ${/* Logo sits between two equal-growth spacers so it lands on the PAGE
        centre, independent of how wide the title and copy badge are. */''}
  <div class="titlebar">
    <span class="t">${esc(doc.title)}</span>
    ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : '<span></span>'}
    <span></span>
  </div>

  <div class="box">

    <div class="band">
      <div class="cellL">
        <div class="seller">
          ${/* No logo here — it's in the title bar above, which is what lets
                this block sit on one clean left edge. */''}
          <div class="info">
            <div class="name">${esc(doc.seller.name)}</div>
            <div class="addr">${sellerAddressHtml(doc)}</div>
            ${/* One row per id, each a label/value pair on its own line, so the
                  labels share a left edge and the values share a second one.
                  GSTIN and Mobile used to sit on one line separated by spaces,
                  which left the values wherever the label happened to end. */''}
            <div class="ids">
              ${doc.seller.gstin ? `<div class="idrow"><span class="ik">GSTIN:</span><span class="iv">${esc(doc.seller.gstin)}</span></div>` : ''}
              ${doc.seller.phone ? `<div class="idrow"><span class="ik">Mobile:</span><span class="iv">${esc(doc.seller.phone)}</span></div>` : ''}
              ${doc.seller.email ? `<div class="idrow"><span class="ik">Email:</span><span class="iv">${esc(doc.seller.email)}</span></div>` : ''}
            </div>
          </div>
          ${blocks.qrDataUri ? `
          <div class="sqr">
            <img src="${blocks.qrDataUri}" alt="" />
            <div class="qr-cap">${QR_CAPTION}</div>
          </div>` : ''}
        </div>
      </div>
      <div class="cellR"><div class="meta">${metaCells}</div></div>
    </div>

    <div class="band">
      <div class="cellL">
        <div class="lbl">${doc.docType === 'purchase_invoice' ? 'BILL TO (HUB)' : 'BILL TO'}</div>
        <div class="pname">${esc(doc.buyer.name)}</div>
        <div class="prow">
          ${buyerRows.map(r => `<div><span class="k">${r.label}:</span> ${r.value}</div>`).join('')}
        </div>
      </div>
      <div class="cellR" style="padding:7px 9px">
        ${doc.notes ? `<div class="lbl">Notes</div><div class="prow">${esc(doc.notes)}</div>` : ''}
      </div>
    </div>

    ${/* Three stacked blocks, not one stretched table — see .items-band. The
          spacer sits BETWEEN the items and TOTAL, so the blank area is above
          the total and TOTAL lands flush on RECEIVED AMOUNT. */''}
    <div class="items-band">
      <table class="items">
        ${colgroup}
        <thead><tr>${thead}</tr></thead>
        <tbody>
          ${rows || `<tr><td colspan="${columns.length}" class="c" style="padding:20px">No items</td></tr>`}
        </tbody>
      </table>

      ${/* The spacer is a TABLE, sharing the colgroup and the collapsed border
            model with the grid above. It was plain divs first, and the rules
            didn't line up: a collapsed table border straddles the column
            boundary, while a border-box div draws it inside its own right
            edge — about a pixel apart, and pixel rounding made some boundaries
            worse than others. Same element type = same geometry = straight
            lines. Height still comes from flex-grow, not a percentage. */''}
      <table class="items items-fill">
        ${colgroup}
        <tbody><tr>${colWidths.map(() => '<td></td>').join('')}</tr></tbody>
      </table>

      ${items.length ? `
      <table class="items items-total">
        ${colgroup}
        <tbody><tr class="totrow">${totalRow}</tr></tbody>
      </table>` : ''}
    </div>

    ${paid ? `<div class="recv"><span>RECEIVED AMOUNT</span><span>₹ ${paid.value}</span></div>` : ''}

    ${hsn ? `
    <div class="band" style="display:block">
      <table class="hsn">
        <thead>
          <tr>
            <th rowspan="2">HSN/SAC</th>
            <th rowspan="2">Taxable Value</th>
            ${hsn.components.map(c => `<th colspan="2">${c}</th>`).join('')}
            <th rowspan="2" class="lastcol">Total Tax Amount</th>
          </tr>
          ${/* No .lastcol here: the final cell of THIS row is SGST's Amount,
                which sits mid-table and must keep its right border. */''}
          <tr>${hsn.components.map(() => '<th>Rate</th><th>Amount</th>').join('')}</tr>
        </thead>
        <tbody>
          ${hsn.rows.map(r => `<tr>
            <td class="c">${r.hsn}</td>
            <td>${r.taxable}</td>
            ${r.parts.map(p => `<td class="c">${p.rate}%</td><td>${p.amount}</td>`).join('')}
            <td class="lastcol">₹ ${r.totalTax}</td>
          </tr>`).join('')}
          <tr class="tot">
            <td class="c">TOTAL</td>
            <td>${hsn.totals.taxable}</td>
            ${hsn.components.map(() => '<td></td><td></td>').join('')}
            <td class="lastcol">₹ ${hsn.totals.totalTax}</td>
          </tr>
        </tbody>
      </table>
    </div>` : ''}

    ${/* Words and Payments share one band, side by side — two short blocks
          stacked full-width wasted a lot of vertical space on a form that's
          already tight. Either one alone falls back to full width rather than
          leaving a stray vertical rule and an empty half. */''}
    ${(wordsInner && paymentsInner) ? `
    <div class="band">
      <div class="halfL">${wordsInner}</div>
      <div class="halfR">${paymentsInner}</div>
    </div>` : (wordsInner || paymentsInner) ? `
    <div class="band" style="display:block">
      <div class="words">${wordsInner || paymentsInner}</div>
    </div>` : ''}

    ${coverage.length ? `
    <div class="band" style="display:block">
      <div class="words">
        <div class="h">Warranty &amp; Guarantee</div>
        ${coverage.map(c => `<div class="kv"><span class="k">${c.type}</span><span class="v">${c.item} — ${c.coverage}</span></div>`).join('')}
      </div>
    </div>` : ''}
    ${(blocks.terms || blocks.bankRows.length || blocks.signature) ? `
    <div class="band">
      <div class="halfL">
        ${blocks.terms ? `<div class="lbl">Terms and Conditions</div><div class="terms">${blocks.terms}</div>` : ''}
      </div>
      <div class="halfR">
        ${blocks.bankRows.length ? `
        <div class="lbl">Bank Details</div>
        ${blocks.bankRows.map(r => `<div class="kv"><span class="k">${r.label}:</span><span class="v">${r.value}</span></div>`).join('')}` : ''}
        ${blocks.signature ? `
        <div class="sign" style="margin-top:${blocks.bankRows.length ? '8px' : '0'}">
          ${blocks.signatureUrl ? `<img class="sign-img" src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
          <div class="who">${blocks.signature} For<br/><b>${esc(doc.seller.name)}</b></div>
        </div>` : ''}
      </div>
    </div>` : ''}

  </div>

  ${(blocks.footerNote || blocks.footerDisclaimer || contact) ? `
  <div class="tail">
    ${blocks.footerNote ? `${blocks.footerNote} ` : ''}${blocks.footerDisclaimer || ''}
    ${contact ? `<br/>${contact}` : ''}
  </div>` : ''}

</div>
</body></html>`;
}

module.exports = { render };
