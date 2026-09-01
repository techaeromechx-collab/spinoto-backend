/**
 * "Modern" theme — a clean, dense GST invoice modelled on the standard Indian
 * billing-software layout:
 *
 *   ┌ logo + company block          │  TITLE + [ORIGINAL FOR RECIPIENT] ┐
 *   │                               │  colon-aligned meta rows          │
 *   ├ [BILL TO] chip                                                    │
 *   │ party name / mobile / GSTIN / place of supply                     │
 *   ├ items table — grey header, per-line disc% and tax% sub-labels     │
 *   ├ grey SUBTOTAL strip with column totals                            │
 *   ├ notes / terms / bank rows      │  taxable + per-rate tax + total   │
 *   │                                │  amount in words                  │
 *   └                                │  signature image + signatory line ┘
 *
 * Structurally a two-column footer: what the customer READS on the left,
 * what they CHECK on the right.
 *
 * Contract: render({ doc, cfg }) — see simple.js. This theme decides layout
 * only; which columns/fields/blocks exist comes from docShared.js.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

// Columns carrying a total in the SUBTOTAL strip. Everything else gets an
// empty cell, so the strip stays aligned however many columns are switched on.
const SUBTOTAL_COLS = { qty: 'qty', disc: 'disc', gst: 'gst', amount: 'amount' };

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 6.9, 7.9);
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
    gst: a.gst + Number(it.gstAmount || 0),
    amount: a.amount + Number(it.total || 0),
  }), { qty: 0, disc: 0, gst: 0, amount: 0 });

  const thead = columns.map(c => `<th class="${cls(c.align)}">${c.label}</th>`).join('');

  const rows = items.map((it, i) =>
    `<tr>${columns.map(c =>
      `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${c.get(it, i)}</td>`
    ).join('')}</tr>`
  ).join('');

  // Mirrors the header's column order so numbers sit under the right headings
  // — driven by `columns`, never a fixed cell list.
  const subtotalRow = columns.map((c, i) => {
    if (i === 0) return '<td class="sub-label">SUBTOTAL</td>';
    const key = SUBTOTAL_COLS[c.key];
    if (!key) return '<td></td>';
    if (key === 'qty') return `<td class="${cls(c.align)}">${sums.qty}</td>`;
    return `<td class="${cls(c.align)} b">₹ ${money(sums[key])}</td>`;
  }).join('');

  // The per-rate tax breakup replaces the single GST line; the grand total
  // gets the boxed emphasis; anything else (paid, balance) follows it.
  const taxable = totals.find(t => t.key === 'subtotal');
  const grand   = totals.find(t => t.key === 'grand');
  /* round_off is pulled out of `rest` deliberately. `rest` renders BELOW the
     grand total, which is right for what it holds — discount, advance, paid,
     balance all qualify a total that has already been stated. A round-off does
     the opposite: it is one of the figures the grand total is made OF, so it
     has to appear above it or the column does not add up. */
  const roundOff = totals.find(t => t.key === 'round_off');
  const rest    = totals.filter(t => !['subtotal', 'gst', 'grand', 'round_off'].includes(t.key));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #1a1a1a; ${pageScale} }

  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .head-left { display: flex; gap: 12px; align-items: flex-start; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .logo { height: 46px; width: auto; max-width: 96px; object-fit: contain; flex-shrink: 0; }
  .co-name { font-size: 12.5px; font-weight: 700; line-height: 1.35; text-transform: uppercase; max-width: 250px; }
  .co-addr { color: #444; line-height: 1.6; margin-top: 3px; max-width: 250px; }
  .co-addr b { color: #1a1a1a; }
  .head-right { min-width: 250px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .title { font-size: 13px; font-weight: 700; letter-spacing: .3px; }
  .badge { border: 1px solid #bbb; color: #555; font-size: 8px; letter-spacing: .4px; padding: 3px 7px; text-transform: uppercase; white-space: nowrap; }
  .meta-row { display: flex; margin-bottom: 3px; line-height: 1.5; }
  .meta-row .k { width: 92px; color: #444; flex-shrink: 0; }
  .meta-row .sep { width: 12px; color: #999; flex-shrink: 0; }
  .meta-row .v { font-weight: 700; text-align: right; flex: 1; }

  .billto { margin-top: 18px; }
  .chip { display: inline-block; background: #eceff3; color: #333; font-size: 8.5px; font-weight: 700; letter-spacing: .5px; padding: 3px 12px; }
  .party-name { font-weight: 700; font-size: 11px; margin-top: 7px; }
  .party-rows { color: #333; line-height: 1.7; margin-top: 2px; }
  .party-rows .k { color: #555; }

  table.items { width: 100%; border-collapse: collapse; margin-top: 16px; }
  table.items thead th { background: #eceff3; text-align: left; font-size: 8.5px; font-weight: 700; letter-spacing: .3px; padding: 6px 7px; text-transform: uppercase; color: #333; }
  table.items thead th.c { text-align: center; }
  table.items thead th.r { text-align: right; }
  table.items tbody td { padding: 7px; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
  /* In <tbody>, not <tfoot>: a table-footer-group repeats on every page in
     paged media, which would print the subtotal on each page of a long invoice. */
  table.items tr.totrow td { background: #eceff3; padding: 7px; font-weight: 700; font-size: 9.5px; border-bottom: none; }
  .sub-label { letter-spacing: .4px; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }

  .foot { display: flex; justify-content: space-between; gap: 28px; margin-top: 26px; }
  .foot-left { flex: 1; min-width: 0; }
  .foot-right { width: 250px; flex-shrink: 0; }
  .blk { margin-bottom: 14px; }
  .blk .h { font-size: 8.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #333; margin-bottom: 4px; }
  .blk .body { color: #444; line-height: 1.65; }
  .kv { display: flex; line-height: 1.75; }
  .kv .k { width: 84px; color: #555; flex-shrink: 0; }
  .kv .v { flex: 1; }

  .tot-row { display: flex; justify-content: space-between; padding: 3px 0; line-height: 1.5; }
  .tot-row .k { color: #444; }
  .tot-grand { display: flex; justify-content: space-between; padding: 6px 0; margin-top: 4px; border-top: 1px solid #ccc; border-bottom: 1px solid #ccc; font-weight: 700; font-size: 11px; }
  .words { margin-top: 12px; text-align: right; line-height: 1.55; }
  .words .h { font-weight: 700; }
  .words .v { color: #333; }

  .sign { margin-top: 22px; text-align: right; }
  .sign img { max-height: 62px; max-width: 150px; object-fit: contain; }
  .sign .space { height: 46px; }
  .sign .who { margin-top: 4px; line-height: 1.5; }
  .sign .who b { display: block; text-transform: uppercase; }

  .tail { margin-top: 22px; padding-top: 7px; border-top: 1px solid #e5e5e5; text-align: center; color: #666; font-size: 8.5px; line-height: 1.6; }

  .ln-name { font-weight: 600; }
  .ln-desc { font-size: 8.5px; color: #888; margin-top: 2px; line-height: 1.4; }
  .ln-hist { font-size: 8px; color: #aaa; margin-top: 2px; font-style: italic; }
  .ln-sub  { display: block; font-size: 8px; color: #999; font-weight: 400; }
  .ln-free { font-weight: 700; letter-spacing: .5px; color: ${accent}; }
  .qr-blk { margin-top: 8px; text-align: right; }
  .qr-blk img { width: 66px; height: 66px; image-rendering: pixelated; }
  .qr-cap { font-size: 7px; color: #999; margin-top: 2px; }
</style></head>
<body>

  <div class="head">
    <div class="head-left">
      ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
      <div>
        <div class="co-name">${esc(doc.seller.name)}</div>
        <div class="co-addr">
          ${sellerAddressHtml(doc)}
          ${doc.seller.gstin ? `<div><b>GSTIN :</b> ${esc(doc.seller.gstin)}</div>` : ''}
          ${doc.seller.phone ? `<div><b>Mobile :</b> ${esc(doc.seller.phone)}</div>` : ''}
          ${doc.seller.email ? `<div><b>Email :</b> ${esc(doc.seller.email)}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="head-right">
      <div class="title-row">
        <span class="title">${esc(doc.title)}</span>
        <span class="badge">Original for Recipient</span>
      </div>
      ${header.map(f => `
      <div class="meta-row"><span class="k">${f.label}</span><span class="sep">:</span><span class="v">${f.value}</span></div>`).join('')}
    </div>
      ${blocks.qrDataUri ? `<div class="qr-blk"><img src="${blocks.qrDataUri}" alt="" /><div class="qr-cap">${QR_CAPTION}</div></div>` : ''}
  </div>

  <div class="billto">
    <span class="chip">BILL TO</span>
    <div class="party-name">${esc(doc.buyer.name)}</div>
    <div class="party-rows">
      ${buyerRows.map(r => `<div><span class="k">${r.label} :</span> ${r.value}</div>`).join('')}
    </div>
  </div>

  <table class="items">
    <thead><tr>${thead}</tr></thead>
    <tbody>
      ${rows || `<tr><td colspan="${columns.length}" class="c" style="color:#999;padding:18px">No items</td></tr>`}
      ${items.length ? `<tr class="totrow">${subtotalRow}</tr>` : ''}
    </tbody>
  </table>

  <div class="foot">
    <div class="foot-left">
      ${coverage.length ? `
      <div class="blk">
        <div class="h">Warranty &amp; Guarantee</div>
        <div class="body">
          ${coverage.map(c => `<div class="kv"><span class="k">${c.type}</span><span class="v">${c.item} — ${c.coverage}</span></div>`).join('')}
        </div>
      </div>` : ''}

      ${doc.notes ? `<div class="blk"><div class="h">Notes</div><div class="body">${esc(doc.notes)}</div></div>` : ''}

      ${blocks.terms ? `<div class="blk"><div class="h">Terms and Conditions</div><div class="body">${blocks.terms}</div></div>` : ''}

      ${blocks.bankRows.length ? `
      <div class="blk">
        <div class="h">Bank Details</div>
        <div class="body">
          ${blocks.bankRows.map(r => `<div class="kv"><span class="k">${r.label}:</span><span class="v">${r.value}</span></div>`).join('')}
        </div>
      </div>` : ''}

      ${(doc.payments || []).length ? `
      <div class="blk">
        <div class="h">Payments</div>
        <div class="body">
          ${doc.payments.map(p => `<div class="kv">
            <span class="k">${esc(String(p.date || '').slice(0, 10))}</span>
            <span class="v">${esc(p.method || '')}${p.reference ? ` · ${esc(p.reference)}` : ''} — ₹ ${money(p.amount)}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="foot-right">
      ${taxable ? `<div class="tot-row"><span class="k">Taxable Amount</span><span>₹ ${taxable.value}</span></div>` : ''}
      ${gstLines.map(g => `<div class="tot-row"><span class="k">${g.label}</span><span>₹ ${g.value}</span></div>`).join('')}
      ${roundOff ? `<div class="tot-row"><span class="k">${roundOff.label}</span><span>₹ ${roundOff.value}</span></div>` : ''}
      ${grand ? `<div class="tot-grand"><span>Total Amount</span><span>₹ ${grand.value}</span></div>` : ''}
      ${rest.map(t => `<div class="tot-row"><span class="k">${t.label}</span><span>₹ ${t.value}</span></div>`).join('')}

      ${blocks.amountInWords ? `
      <div class="words">
        <div class="h">Total Amount (in words)</div>
        <div class="v">${esc(amountInWords(grandTotalOf(doc)))}</div>
      </div>` : ''}

      ${blocks.signature ? `
      <div class="sign">
        ${blocks.signatureUrl ? `<img src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
        <div class="who">${blocks.signature} for <b>${esc(doc.seller.name)}</b></div>
      </div>` : ''}
    </div>
  </div>

  ${(blocks.footerNote || blocks.footerDisclaimer) ? `
  <div class="tail">
    ${blocks.footerNote ? `${blocks.footerNote}<br/>` : ''}
    ${blocks.footerDisclaimer || ''}
    ${contact ? `<br/>${contact}` : ''}
  </div>` : ''}

</body></html>`;
}

module.exports = { render };
