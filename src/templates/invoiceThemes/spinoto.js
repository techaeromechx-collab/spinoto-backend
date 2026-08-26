/**
 * "Spinoto" theme — the in-house house style.
 *
 * A faithful port of the layout the app printed for years via the browser's
 * window.print():
 *
 *   logo + company (left)          ·          TITLE / number / date + QR (right)
 *   ───────────────────────────── teal rule ──────────────────────────────────
 *   ┌ BILL TO ─────────────┬ VEHICLE & INVOICE ─┐   two bordered info cards
 *   └──────────────────────┴────────────────────┘
 *   Line Items — teal header row
 *   ┌ Amount in Words (teal left rule)   │  Subtotal / Tax Breakdown / totals ┐
 *   ┌ Warranty & Guarantee               │  Payments                          ┐
 *   ───────────────────────── centred footer ─────────────────────────────────
 *
 * Ported so that layout survives the move to server-rendered PDFs — and it
 * gains everything the shared system provides (configurable columns, IGST,
 * terms, bank block, signature image, QR) that the hand-written print CSS
 * never had.
 *
 * The teal (#16b994) was hard-coded in three separate stylesheets before.
 * Here it's just the default accent, so the colour picker actually drives it.
 *
 * Contract: render({ doc, cfg }) — see simple.js. Layout only; which
 * columns/fields/blocks exist comes from docShared.js.
 */
const { esc, money } = require('./shared');
const {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

// The original Spinoto brand teal, used when the company hasn't chosen an
// accent of its own.
const HOUSE_TEAL = '#16b994';

const cls = (align) => (align === 'c' ? 'c' : align === 'r' ? 'r' : '');

function render({ doc, cfg, pageSize }) {
  // A4 renders exactly as before (empty string); A5 applies one proportional
  // zoom to this whole stylesheet. See docShared.pageScaleCss.
  const pageScale = pageScaleCss(pageSize);
  // Outer margin for BOTH media: an @page rule for the PDF plus a
  // screen-only body padding for the settings preview, which renders this
  // same HTML in an iframe where @page is inert. See
  // docShared.pageMarginCss — do not add `padding` to body here.
  const pageMargin = pageMarginCss(pageSize, 6.9, 7.9);
  // '#4f46e5' is the system-wide default accent; if the company never picked
  // one, fall back to the house teal rather than the generic indigo so the
  // house style still looks like the house style.
  const accent = (doc.accent && doc.accent !== '#4f46e5') ? doc.accent : HOUSE_TEAL;

  const columns = buildColumns(doc, cfg);
  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const coverage = buildCoverageRows(doc, cfg);
  const contact = buildFooterContact(doc);

  const items = doc.items || [];

  const thead = columns.map(c => `<th class="${cls(c.align)}">${c.label}</th>`).join('');

  // The item cell carries a Service/Part badge under the name, as the old
  // layout did. buildColumns owns the cell's content, so the badge is appended
  // here rather than baked into the shared builder — it's a house-style
  // flourish, not something every theme wants.
  const rows = items.map((it, i) =>
    `<tr>${columns.map(c => {
      const inner = c.get(it, i);
      const badge = (c.key === 'item' && it.type)
        ? `<div class="ln-badge ${it.type === 'service' ? 'svc' : 'part'}">${it.type === 'service' ? 'Service' : 'Part'}</div>`
        : '';
      return `<td class="${cls(c.align)}${c.bold ? ' b' : ''}">${inner}${badge}</td>`;
    }).join('')}</tr>`
  ).join('');

  const grand = totals.find(t => t.key === 'grand');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body {
    font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    ${pageScale}
  }

  /* ── header ── */
  .hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 14px; border-bottom: 2px solid ${accent}; }
  .hd-l { min-width: 0; }
  /* height is EXPLICIT, not just capped. max-* alone only limits a size, it
     doesn't give one — and an SVG carrying only a viewBox (no width/height
     attributes) has an intrinsic RATIO but no intrinsic SIZE. With max-* only,
     such a logo contributes zero width and vanishes. Fixing the height lets
     the viewBox ratio supply the width; max-width stays as a safety cap for
     an unusually wide logo. */
  .hd .logo { height: 46px; width: auto; max-width: 170px; object-fit: contain; margin-bottom: 8px; }
  .hd .co { font-size: 13px; font-weight: 700; letter-spacing: .2px; text-transform: uppercase; }
  .hd .addr { color: #4b5563; line-height: 1.6; margin-top: 3px; }
  .hd-r { text-align: right; flex-shrink: 0; }
  .doc-title { font-size: 15px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
  .doc-no { margin-top: 3px; font-size: 11px; color: #6b7280; }
  .doc-date { font-size: 11px; color: #6b7280; }
  .qr { margin-top: 10px; }
  .qr img { width: 72px; height: 72px; image-rendering: pixelated; }
  .qr .cap { font-size: 7.5px; color: #9ca3af; margin-top: 2px; }

  /* ── info cards ── */
  .grids { display: flex; gap: 0; margin-top: 16px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .grid { flex: 1; min-width: 0; padding: 12px 14px; }
  .grid + .grid { border-left: 1px solid #e5e7eb; }
  .grid .gh { font-size: 8.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
  .grid .gr { display: flex; padding: 2px 0; line-height: 1.6; }
  .grid .gk { width: 88px; flex-shrink: 0; color: #6b7280; }
  .grid .gv { flex: 1; font-weight: 700; word-break: break-word; }

  /* ── items ── */
  .sec-h { margin: 16px 0 5px; font-size: 9px; font-weight: 700; color: #111; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items thead th { background: ${accent}; color: #fff; text-align: left; font-size: 8px; font-weight: 700; letter-spacing: .3px; padding: 7px 6px; }
  table.items thead th.c { text-align: center; }
  table.items thead th.r { text-align: right; }
  table.items tbody td { padding: 7px 6px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }

  /* ── words + summary ── */
  .lower { display: flex; gap: 24px; margin-top: 18px; align-items: flex-start; }
  .lower-l { flex: 1; min-width: 0; }
  .lower-r { width: 268px; flex-shrink: 0; }

  .words { border-left: 3px solid ${accent}; padding: 4px 0 4px 12px; }
  .words .h { font-size: 8.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #9ca3af; margin-bottom: 3px; }
  .words .v { font-style: italic; color: #374151; line-height: 1.6; }

  .blk { margin-top: 14px; }
  .blk .h { font-size: 9px; font-weight: 700; color: #111; margin-bottom: 5px; }
  .blk .body { color: #4b5563; line-height: 1.65; }
  .kv { display: flex; line-height: 1.75; }
  .kv .k { width: 84px; flex-shrink: 0; color: #6b7280; }
  .kv .v { flex: 1; }

  table.mini { width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 6px; }
  table.mini th { text-align: left; font-size: 8.5px; font-weight: 700; color: #374151; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  table.mini td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; color: #4b5563; line-height: 1.5; }
  table.mini tr:last-child td { border-bottom: none; }
  .cov-note { margin-top: 5px; font-style: italic; color: #6b7280; font-size: 8.5px; }

  .sum .row { display: flex; justify-content: space-between; padding: 4px 0; line-height: 1.5; }
  .sum .row .k { color: #4b5563; }
  .sum .tax-h { margin-top: 6px; font-size: 8.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #9ca3af; }
  .sum .tax { display: flex; justify-content: space-between; padding: 2px 0; color: #6b7280; }
  .sum .grand { display: flex; justify-content: space-between; margin-top: 8px; padding: 8px 0; border-top: 1px solid #e5e7eb; font-weight: 700; font-size: 14px; color: ${accent}; }
  .sum .strong { display: flex; justify-content: space-between; padding: 5px 0; font-weight: 700; font-size: 12px; color: ${accent}; }

  .sign { margin-top: 20px; text-align: right; }
  .sign .space { height: 44px; }
  .sign .who { line-height: 1.5; color: #4b5563; }
  .sign .who b { display: block; color: #111; }
  .sign-img { max-height: 56px; max-width: 145px; object-fit: contain; display: block; margin-left: auto; margin-bottom: 3px; }

  .ft { margin-top: 24px; padding-top: 10px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 8.5px; line-height: 1.8; }
  .ft .strong { color: #374151; font-weight: 700; }

  .ln-name { font-weight: 600; }
  .ln-desc { font-size: 8.5px; color: #9ca3af; margin-top: 2px; line-height: 1.4; }
  .ln-hist { font-size: 8px; color: #b0b6be; margin-top: 2px; font-style: italic; }
  .ln-sub  { display: block; font-size: 8px; color: #9ca3af; font-weight: 400; }
  .ln-free { font-weight: 700; letter-spacing: .5px; color: ${accent}; }
  .ln-badge { display: inline-block; margin-top: 3px; font-size: 7.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
  .ln-badge.svc  { background: #dbeafe; color: #1e40af; }
  .ln-badge.part { background: #dcfce7; color: #166534; }
</style></head>
<body>

  <div class="hd">
    <div class="hd-l">
      ${doc.seller.logoUrl ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" />` : ''}
      <div class="co">${esc(doc.seller.name)}</div>
      <div class="addr">
        ${sellerAddressHtml(doc)}
        ${doc.seller.phone ? `<div>Phone : ${esc(doc.seller.phone)}</div>` : ''}
        ${doc.seller.gstin ? `<div>GSTIN : ${esc(doc.seller.gstin)}</div>` : ''}
      </div>
    </div>
    <div class="hd-r">
      <div class="doc-title">${esc(doc.title)}</div>
      <div class="doc-no">${esc(doc.number)}</div>
      ${header.find(f => f.key === 'date') ? `<div class="doc-date">${header.find(f => f.key === 'date').value}</div>` : ''}
      ${blocks.qrDataUri ? `
      <div class="qr">
        <img src="${blocks.qrDataUri}" alt="" />
        <div class="cap">${QR_CAPTION}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="grids">
    <div class="grid">
      <div class="gh">Bill To</div>
      <div class="gr"><span class="gk">${doc.docType === 'purchase_invoice' ? 'Name' : 'Customer'}</span><span class="gv">${esc(doc.buyer.name)}</span></div>
      ${buyerRows.map(r => `<div class="gr"><span class="gk">${r.label}</span><span class="gv">${r.value}</span></div>`).join('')}
    </div>
    <div class="grid">
      <div class="gh">${doc.docType === 'estimate' ? 'Vehicle &amp; Estimate' : 'Vehicle &amp; Invoice'}</div>
      ${header.map(f => `<div class="gr"><span class="gk">${f.label}</span><span class="gv">${f.value}</span></div>`).join('')}
    </div>
  </div>

  <div class="sec-h">Line Items</div>
  <table class="items">
    <thead><tr>${thead}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${columns.length}" class="c" style="padding:18px;color:#9ca3af">No items</td></tr>`}</tbody>
  </table>

  <div class="lower">
    <div class="lower-l">
      ${blocks.amountInWords && grand ? `
      <div class="words">
        <div class="h">Amount in Words</div>
        <div class="v">${esc(amountInWords(grandTotalOf(doc)))}</div>
      </div>` : ''}

      ${coverage.length ? `
      <div class="blk">
        <div class="h">Warranty &amp; Guarantee</div>
        <table class="mini">
          <thead><tr><th style="width:45%">Service / Package</th><th style="width:22%">Type</th><th style="width:33%">Coverage / Validity</th></tr></thead>
          <tbody>${coverage.map(c => `<tr><td>${c.item}</td><td>${c.type}</td><td>${c.coverage}</td></tr>`).join('')}</tbody>
        </table>
        <div class="cov-note">Warranty / guarantee is valid from the date of ${doc.docType === 'estimate' ? 'invoice' : 'invoice'}.</div>
      </div>` : ''}

      ${doc.notes ? `<div class="blk"><div class="h">Notes</div><div class="body">${esc(doc.notes)}</div></div>` : ''}

      ${blocks.terms ? `<div class="blk"><div class="h">Terms &amp; Conditions</div><div class="body">${blocks.terms}</div></div>` : ''}

      ${blocks.bankRows.length ? `
      <div class="blk">
        <div class="h">Bank Details</div>
        <div class="body">
          ${blocks.bankRows.map(r => `<div class="kv"><span class="k">${r.label}:</span><span class="v">${r.value}</span></div>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="lower-r">
      <div class="sum">
        ${totals.map(t => {
          if (t.key === 'grand')  return `<div class="grand"><span>${t.label}</span><span>₹ ${t.value}</span></div>`;
          if (t.kind === 'strong') return `<div class="strong"><span>${t.label}</span><span>₹ ${t.value}</span></div>`;
          const tax = t.key === 'gst' && gstLines.length
            ? `<div class="tax-h">Tax Breakdown</div>` +
              gstLines.map(g => `<div class="tax"><span>${g.label}</span><span>₹ ${g.value}</span></div>`).join('')
            : '';
          return `<div class="row"><span class="k">${t.label}</span><span>₹ ${t.value}</span></div>${tax}`;
        }).join('')}
      </div>

      ${(doc.payments || []).length ? `
      <div class="blk">
        <div class="h">Payments</div>
        <table class="mini">
          <thead><tr><th>Date</th><th>Method</th><th class="r">Amount</th></tr></thead>
          <tbody>${doc.payments.map(p => `<tr>
            <td>${esc(String(p.date || '').slice(0, 10))}</td>
            <td>${esc(p.method || '')}${p.reference ? `<div class="ln-sub">${esc(p.reference)}</div>` : ''}${p.notes ? `<div class="ln-sub">${esc(p.notes)}</div>` : ''}</td>
            <td class="r b">₹ ${money(p.amount)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      ${blocks.signature ? `
      <div class="sign">
        ${blocks.signatureUrl ? `<img class="sign-img" src="${blocks.signatureUrl}" alt="" />` : '<div class="space"></div>'}
        <div class="who">${blocks.signature} for<br/><b>${esc(doc.seller.name)}</b></div>
      </div>` : ''}
    </div>
  </div>

  ${(blocks.footerNote || blocks.footerDisclaimer || contact) ? `
  <div class="ft">
    ${blocks.footerNote ? `<div class="strong">${blocks.footerNote}</div>` : ''}
    ${blocks.footerDisclaimer || ''}
    ${contact ? `<div>${contact}</div>` : ''}
  </div>` : ''}

</body></html>`;
}

module.exports = { render };
