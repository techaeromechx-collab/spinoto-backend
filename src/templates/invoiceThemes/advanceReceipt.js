/**
 * The advance receipt / refund voucher — ONE renderer, not eight themes.
 *
 * ── Why this is not a theme ─────────────────────────────────────────────────
 * The other eight files each lay out the same thing: a party block, an item
 * table, a totals column. They differ in how that looks, and offering a choice
 * is reasonable.
 *
 * This document has no item table. It is one amount and the tax inside it, and
 * every honest layout of that is nearly the same layout. Eight variants would
 * be eight places for the tax split to drift, in exchange for a choice nobody
 * needs. So: one renderer, which takes the company's accent colour, logo,
 * terms, bank block, signature and footer from the same config every other
 * document uses — it just doesn't take their theme.
 *
 * ── The one thing this document must not do ─────────────────────────────────
 * It must not look like a bill. A customer who files a receipt voucher as the
 * invoice will believe the job is paid for. Three things prevent that, and all
 * three are deliberate:
 *
 *   • the title says RECEIPT VOUCHER, not INVOICE;
 *   • the amount panel is labelled "Advance received", not "Amount due";
 *   • when the job total is known, the balance still to pay is printed under
 *     it, in words a customer reads without help.
 *
 * render({ doc, cfg, pageSize }) — same contract as every theme. doc.kind is
 * 'receipt' or 'refund'; the sign of the money is the only thing that flips.
 */
const { esc, money } = require('./shared');
const {
  buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS, QR_CAPTION,
} = require('./docShared');

/** dd Mon yyyy — short, unambiguous, and not the ISO string. */
function shortDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const METHOD_LABELS = {
  cash: 'Cash', upi: 'UPI', card: 'Card', netbanking: 'Net Banking',
  bank_transfer: 'Bank Transfer', cheque: 'Cheque', link: 'Payment Link',
  wallet: 'Wallet', emi: 'EMI', other: 'Other',
};
const methodLabel = m => METHOD_LABELS[String(m || '').toLowerCase()] || (m || '—');

function render({ doc, cfg, pageSize }) {
  const pageScale = pageScaleCss(pageSize);
  const pageMargin = pageMarginCss(pageSize, 7.4, 8.5);
  const accent = doc.accent || '#4f46e5';
  const isRefund = doc.kind === 'refund';
  const onAccount = !!doc.onAccount;

  const header = buildHeaderFields(doc, cfg);
  const totals = buildTotals(doc);
  const gstLines = buildGstLines(doc);
  const blocks = buildBlocks(doc);
  const buyerRows = buildBuyerRows(doc);
  const contact = buildFooterContact(doc);
  const rec = doc.received || {};
  const job = doc.job || {};

  // The headline figure, taken from the totals rather than re-derived — the
  // panel and the tax block must never be able to disagree.
  const grand = totals.find(t => t.key === 'grand');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ${pageMargin}
  ${PRINT_BREAK_CSS}
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; ${pageScale} }
  .row { display: flex; justify-content: space-between; align-items: flex-start; }
  .company-name { font-size: 16px; font-weight: 700; }
  .muted { color: #555; line-height: 1.5; }
  .title { text-align: right; }
  .title h1 { font-size: 16px; letter-spacing: 1px; color: ${accent}; }
  .title .sub { font-size: 9px; letter-spacing: .6px; text-transform: uppercase; color: #888; margin-top: 2px; }
  .meta { margin-top: 8px; font-size: 11px; }
  .meta .m { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 2px; line-height: 1.5; }
  .meta .k { width: 100px; flex-shrink: 0; text-align: right; font-weight: 700; }
  .meta .v { width: 128px; text-align: right; word-break: break-word; }
  .logo { height: 48px; width: auto; max-width: 160px; object-fit: contain; margin-bottom: 6px; }
  hr { border: none; border-top: 2px solid ${accent}; margin: 14px 0; }
  .bill-to .label { font-weight: 700; font-size: 10px; letter-spacing: .5px; color: #666; margin-bottom: 3px; }
  .b { font-weight: 700; }

  /* The amount panel. This is the document — it is sized so that the figure is
     the first thing read, and captioned so it cannot be mistaken for a bill. */
  .amount-panel {
    margin-top: 18px; border: 1.5px solid ${accent}; border-radius: 6px;
    padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;
    background: #fafafa;
  }
  .amount-panel .cap { font-size: 10px; letter-spacing: .6px; text-transform: uppercase; color: #666; }
  .amount-panel .fig { font-size: 24px; font-weight: 700; color: ${accent}; line-height: 1.15; }
  .amount-panel .right { text-align: right; font-size: 10.5px; color: #555; line-height: 1.7; }
  .amount-panel .right b { color: #1a1a1a; }

  .split { display: flex; gap: 20px; align-items: stretch; margin-top: 16px; }
  .split > div { flex: 1 1 50%; min-width: 0; }
  .card { border: 1px solid #e5e5e5; border-radius: 5px; padding: 10px 12px; }
  .card .h { font-weight: 700; font-size: 9.5px; letter-spacing: .5px; color: #666; margin-bottom: 6px; text-transform: uppercase; }
  .kv { display: flex; justify-content: space-between; padding: 2.5px 0; font-size: 10.5px; }
  .kv .k { color: #666; }
  .kv .v { font-weight: 600; text-align: right; }
  .kv.grand { border-top: 1px solid #333; margin-top: 5px; padding-top: 5px; font-size: 12px; font-weight: 700; }
  .kv.gst-line { color: #888; font-size: 9.5px; }

  .words { margin-top: 14px; font-size: 10px; font-style: italic; color: #444; border-left: 3px solid ${accent}; padding: 6px 10px; background: #fafafa; }
  .note { margin-top: 14px; font-size: 10px; color: #555; line-height: 1.6; }
  .note .h { font-weight: 700; font-size: 9.5px; letter-spacing: .5px; color: #666; margin-bottom: 3px; text-transform: uppercase; }
  .blocks { margin-top: 18px; display: flex; justify-content: space-between; gap: 24px; }
  .blocks .bk { font-size: 9.5px; color: #555; line-height: 1.6; max-width: 55%; }
  .blocks .bk .h { font-weight: 700; color: #333; margin-bottom: 3px; }
  .sign { text-align: right; font-size: 9.5px; color: #555; min-width: 170px; }
  .sign .space { height: 42px; }
  .sign .rule { border-top: 1px solid #999; padding-top: 3px; }
  .sign-img { max-height: 58px; max-width: 150px; object-fit: contain; display: block; margin-left: auto; }
  .footer { margin-top: 26px; padding-top: 8px; border-top: 1px solid #ddd; text-align: center; font-size: 9.5px; color: #555; line-height: 1.6; }
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
      ${/* Says in one line what the document is for. A receipt voucher is an
            unfamiliar object to most customers, and the title alone does not
            explain it. */''}
      ${/* Three different documents share this renderer, and the line under the
             title is where they say which one they are. "Advance received" with
             no job named would read as a receipt whose job failed to print. */''}
      <div class="sub">${isRefund
        ? 'Refund of advance received'
        : doc.onAccount
          ? 'Advance received on account'
          : 'Advance received against a job'}</div>
      <div class="meta">
        ${header.map(f => `<div class="m"><div class="k">${f.label}</div><div class="v">${f.value}</div></div>`).join('')}
      </div>
      ${blocks.qrDataUri ? `<div class="qr-blk"><img src="${blocks.qrDataUri}" alt="" /><div class="qr-cap">${QR_CAPTION}</div></div>` : ''}
    </div>
  </div>

  <hr/>

  <div class="bill-to">
    <div class="label">${isRefund ? 'REFUNDED TO' : 'RECEIVED FROM'}</div>
    <div class="b">${esc(doc.buyer.name)}</div>
    <div class="muted">
      ${buyerRows.map(r => `${r.label}: ${r.value}`).join('<br/>')}
    </div>
  </div>

  <div class="amount-panel">
    <div>
      <div class="cap">${isRefund ? 'Amount refunded' : 'Advance received'}</div>
      <div class="fig">₹ ${grand ? grand.value : money(0)}</div>
    </div>
    <div class="right">
      <div>${isRefund ? 'Refunded via' : 'Received via'} <b>${esc(methodLabel(rec.method))}</b></div>
      ${rec.reference ? `<div>Ref: <b>${esc(rec.reference)}</b></div>` : ''}
      <div>${esc(shortDate(rec.on))}</div>
    </div>
  </div>

  <div class="split">
    <div class="card">
      <div class="h">Tax Breakdown</div>
      ${totals.map(t => {
        const cl = t.kind === 'grand' ? 'grand' : '';
        const gst = t.key === 'gst' && gstLines.length
          ? gstLines.map(g => `<div class="kv gst-line"><span class="k">${g.label}</span><span class="v">₹ ${g.value}</span></div>`).join('')
          : '';
        return `<div class="kv ${cl}"><span class="k">${t.label}</span><span class="v">₹ ${t.value}</span></div>${gst}`;
      }).join('')}
    </div>

    ${/* The job block. Omitted entirely when the total isn't known rather than
          printed as zero — a receipt claiming "₹0.00 still to pay" on a job that
          has not been invoiced is worse than saying nothing about it. */''}
    ${job.total ? `
    <div class="card">
      <div class="h">Against This Job</div>
      <div class="kv"><span class="k">Job total (incl. GST)</span><span class="v">₹ ${money(job.total)}</span></div>
      ${job.advanced ? `<div class="kv"><span class="k">Advance received to date</span><span class="v">₹ ${money(job.advanced)}</span></div>` : ''}
      ${job.balanceAfter !== null && job.balanceAfter !== undefined ? `
      <div class="kv grand"><span class="k">Still to pay</span><span class="v">₹ ${money(job.balanceAfter)}</span></div>
      <div style="font-size:9.5px;color:#666;margin-top:6px;line-height:1.5">
        This is not an invoice. Your tax invoice will be issued when the work is
        complete, and this advance will be adjusted against it.
      </div>` : ''}
    </div>` : ''}
  </div>

  ${/* With no job there is no "still to pay" line, so this is the only place
         the document says what happens to the money next. Without it an
         on-account receipt states an amount and nothing about its purpose. */''}
  ${onAccount ? `
  <div class="note" style="margin-top:16px">
    <div class="h">About this payment</div>
    <div>
      This amount is held to your account. It will be adjusted against your
      invoice when the work is billed, and any unused balance can be returned
      to you on request.
    </div>
  </div>` : ''}

  ${blocks.amountInWords ? `<div class="words">${esc(amountInWords(Number(doc.totals?.find(t => t.key === 'grand')?.value || 0)))}</div>` : ''}

  ${doc.notes ? `<div class="note"><div class="h">Notes</div><div>${esc(doc.notes)}</div></div>` : ''}

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
