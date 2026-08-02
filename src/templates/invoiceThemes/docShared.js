'use strict';

/**
 * docShared.js — the builder library for the THREE-DOCUMENT template system.
 *
 * Supersedes shared.js's buildColumns/buildHeaderFields/buildTotals, which
 * were customer-invoice-only and consumed a raw DB row. These builders consume
 * the canonical document object from templates/documentAdapter.js, so a theme
 * renders an estimate, a customer invoice or a purchase invoice through the
 * exact same code path.
 *
 * Contract for themes: these decide WHAT appears. The theme decides how it
 * LOOKS — markup, classes, fonts, colour. Anything a theme hard-codes that
 * belongs in this file will silently diverge across the other 8 themes.
 *
 * shared.js is kept alongside during the migration and retired once every
 * theme consumes this module.
 */

const { esc, money, formatDate, formatShortDate } = require('./shared');

/**
 * The caption printed under (or above) the QR code.
 *
 * One constant rather than a literal in each theme: the six themes had drifted
 * to three different wordings — "Scan to view", "Scan to download" and plain
 * "Scan" — precisely because each one owned its own copy. Changing the wording
 * meant finding all six.
 */
const QR_CAPTION = 'Track Your Order';

// ─── Page size ────────────────────────────────────────────────────────────────

/**
 * Every theme's stylesheet is authored against A4. A5 is not a second,
 * hand-tuned set of dimensions — it is the SAME layout rendered at A5's
 * proportion of A4 (148mm / 210mm = 0.7048), applied with one CSS zoom on
 * <body>.
 *
 * Why zoom rather than per-size metrics: Chromium — the only renderer involved
 * (Puppeteer for the PDF, an iframe for the settings preview) — scales every
 * computed length under zoom, mm and px alike. So advanced_gst's hard-coded
 * `min-height: 265mm` becomes 187mm and fits A5's 210mm page, and the px-based
 * themes shrink proportionally, all from a single number. Hand-maintaining a
 * second dimension set across seven stylesheets would drift on the first edit.
 *
 * This is what was broken: the A5 themes rendered the A4 stylesheet verbatim
 * and only told Puppeteer to use a smaller sheet, so 265mm of content was
 * pushed onto a 210mm page and spilled onto a phantom second page.
 */
const PAGE_DIMS = {
  A4: { wMm: 210, hMm: 297, px: [794, 1123] },  // px = 96dpi, for the preview
  A5: { wMm: 148, hMm: 210, px: [559, 794] },
};

function pageDims(pageSize) {
  return PAGE_DIMS[pageSize] || PAGE_DIMS.A4;
}

/** A5 → 0.7048, A4 → 1. */
function pageScale(pageSize) {
  return pageDims(pageSize).wMm / PAGE_DIMS.A4.wMm;
}

/**
 * CSS declaration for a theme's `body` rule. Empty string on A4, so the A4
 * path renders byte-identically to before this existed.
 */
function pageScaleCss(pageSize) {
  const s = pageScale(pageSize);
  return s === 1 ? '' : `zoom: ${s.toFixed(4)};`;
}

/**
 * The page frame — the SINGLE owner of a document's outer margin.
 *
 * Emits two rules, because print and screen need the margin expressed
 * differently and the same HTML has to serve both:
 *
 * 1. `@page { margin }` — for the PDF. Themes used to carry the margin as
 *    `body { padding }`, but body padding applies ONCE to the whole body box,
 *    not per page, so page 2 of a long invoice began hard against the paper
 *    edge. @page applies to every page.
 *
 *    The value is scaled BY HAND here because @page lives outside <body>, where
 *    the body zoom that handles A5 (pageScaleCss) cannot reach it. Scaling by
 *    the same factor keeps the printable area proportionally identical on both
 *    sheets: A4 gives 210 − 2×10 = 190mm of content width, A5 gives
 *    (148 − 2×7.05) ÷ 0.7048 = 190mm in the body's own zoomed space.
 *
 * 2. `@media screen { body { padding } }` — for the settings preview, which
 *    renders this HTML in an ordinary iframe. @page is a PAGED-MEDIA rule and
 *    is completely inert on screen, so after (1) the preview lost its margin
 *    entirely and the invoice sat flush against the iframe edge. This restores
 *    it for screen only.
 *
 *    NOT scaled, unlike @page: `zoom` DOES apply on screen, so it scales this
 *    padding for us. Pre-scaling it would shrink it twice.
 *
 *    Puppeteer's page.pdf() renders with the `print` media type, so this block
 *    is ignored during PDF generation — the two margins can never be applied
 *    together and double up.
 *
 * Themes must therefore NOT set `body { padding }` themselves; the `*` reset
 * already zeroes it, and this function supplies whichever value the current
 * medium needs.
 *
 * `size` is deliberately NOT declared: Puppeteer's `format` option owns the
 * sheet, and setting it in both places invites them to disagree.
 */
function pageMarginCss(pageSize, vMm = 12, hMm = 10) {
  const s = pageScale(pageSize);
  return `@page { margin: ${(vMm * s).toFixed(2)}mm ${(hMm * s).toFixed(2)}mm; }
  @media screen { body { padding: ${vMm}mm ${hMm}mm; } }`;
}

/**
 * Page-break rules every theme wants once a document runs past one page.
 *
 * - thead repeats the column headers on each page. Chromium does this by
 *   default for a table-header-group, but stating it means a later `display`
 *   tweak can't silently kill it.
 * - A row must never be split across the fold; half a line item at the bottom
 *   of page 1 is unreadable.
 * - Labelled blocks (bank details, terms, a totals stack, a signature) read as
 *   a unit and shouldn't be orphaned mid-way.
 *
 * Class names that a given theme doesn't use are simply inert.
 */
const PRINT_BREAK_CSS = `
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .blk, .kv, .trow, .sign, .words, .totals, .sum { break-inside: avoid; page-break-inside: avoid; }
  /* The spacer row that pushes the totals to the foot of a SHORT document is
     height:100%, i.e. most of a page tall. It must stay splittable: an
     unbreakable row that big would jump whole to the next page the moment a
     document overflows, emitting a blank page. It's empty, so splitting it
     costs nothing. */
  tr.filler { break-inside: auto; page-break-inside: auto; }
`;

// ─── Item table ───────────────────────────────────────────────────────────────

/**
 * Column descriptors for the item table, in canonical order.
 * Returns [{ key, label, align, bold, get(item, index) }] where get() returns
 * ALREADY-ESCAPED HTML and align is 'l' | 'c' | 'r'.
 *
 * Structural / legally-required columns (#, item name, GST, amount) are always
 * present — exposing them as toggles would let a user produce an invalid GST
 * invoice. The discount column is the one exception: it defaults to 'auto' and
 * appears only when something is actually discounted.
 */
function buildColumns(doc, cfg) {
  const ic = cfg.item_columns || {};
  const flags = cfg.flags || {};
  const cols = [];

  cols.push({ key: 'sr', label: '#', align: 'c', get: (_it, i) => String(i + 1) });

  cols.push({
    key: 'item', label: 'Item', align: 'l',
    get: (it) => {
      let html = `<span class="ln-name">${esc(it.name)}</span>`;
      if (flags.show_item_description && it.description) {
        html += `<div class="ln-desc">${esc(it.description)}</div>`;
      }
      if (flags.price_history && it.priceHistory?.length) {
        const hist = it.priceHistory.map(h => `${formatShortDate(h.date)}: ₹${money(h.rate)}`).join(' · ');
        html += `<div class="ln-hist">Previously — ${esc(hist)}</div>`;
      }
      return html;
    },
  });

  if (ic.hsn) cols.push({ key: 'hsn', label: 'HSN/SAC', align: 'c', get: (it) => esc(it.hsn || '—') });

  if (ic.batch_no) cols.push({ key: 'batch_no', label: 'Batch No.', align: 'c', get: (it) => esc(it.batchNo || '—') });
  if (ic.mfg_date) cols.push({ key: 'mfg_date', label: 'Mfg Date', align: 'c', get: (it) => esc(formatShortDate(it.mfgDate) || '—') });
  if (ic.exp_date) cols.push({ key: 'exp_date', label: 'Exp. Date', align: 'c', get: (it) => esc(formatShortDate(it.expDate) || '—') });

  for (const def of (cfg.custom_columns || [])) {
    if (!def || def.enabled === false || !def.label) continue;
    cols.push({
      key: `custom:${def.id}`, label: esc(def.label), align: 'l',
      get: (it) => esc((it.customValues || {})[def.id] || '—'),
    });
  }

  if (ic.qty) cols.push({ key: 'qty', label: 'Qty', align: 'r', get: (it) => String(it.qty) });

  // ── Purchase-invoice reference columns ──
  // DOUBLE-GATED: the adapter sets doc.showMargin only when the config allows
  // it AND the viewer is an admin; this re-checks viewerRole independently.
  // A hub must never see the margin taken on their own work, and one guard is
  // one edit away from being wrong.
  const showMargin = doc.docType === 'purchase_invoice'
    && doc.showMargin === true
    && doc.viewerRole === 'admin';

  if (showMargin) {
    cols.push({
      key: 'cust_rate', label: 'Cust. Rate', align: 'r',
      get: (it) => (it.customerRate === undefined ? '—' : money(it.customerRate)),
    });
    cols.push({
      key: 'commission',
      label: doc.rateMode === 'tech_rate' ? 'Take Rate %' : 'Commission %',
      align: 'r',
      get: (it) => (it.commissionPercent === undefined ? '—' : `${it.commissionPercent}%`),
    });
  }

  if (ic.price) {
    cols.push({
      key: 'rate',
      label: doc.docType === 'purchase_invoice' ? (doc.viewerRole === 'hub' ? 'Your Rate' : 'Hub Rate') : 'Rate',
      align: 'r',
      get: (it) => (isFree(it, flags) ? '<span class="ln-free">FREE</span>' : money(it.rate)),
    });
  }

  // Discount column.
  //
  // 'auto' (the default) only shows the column when at least one line is
  // actually discounted — a column of zeros on every undiscounted invoice is
  // noise, and this is what the old print layout did via its `hasDiscount`
  // check. 'always'/'never' are there for anyone who wants a fixed table
  // shape across every document.
  const anyDiscount = (doc.items || []).some(it => Number(it.discount || 0) > 0);
  const discMode = ic.discount === undefined ? 'auto' : ic.discount;
  const showDiscount = discMode === 'always' || (discMode !== 'never' && anyDiscount);

  if (showDiscount) {
    cols.push({
      key: 'disc', label: 'Disc.', align: 'r',
      get: (it) => {
        if (!it.discount) return '0';
        // Show the rate that produced the amount, the way every Indian billing
        // format does — "1,000" over "(10%)". A flat discount has no meaningful
        // percentage, so it's labelled as such instead of faking one.
        const sub = it.discountType === 'percent' && it.discountValue
          ? `(${it.discountValue}%)`
          : (it.discountType === 'flat' ? '(Flat)' : '');
        return `${money(it.discount)}${sub ? `<span class="ln-sub">${sub}</span>` : ''}`;
      },
    });
  }

  // Taxable value — the amount GST was charged ON, i.e. the line total minus
  // its own GST. Off by default; the Spinoto house layout shows it because a
  // workshop invoice is often checked against the taxable base rather than the
  // gross.
  if (ic.taxable) {
    cols.push({
      key: 'taxable', label: 'Taxable', align: 'r',
      get: (it) => money(Number(it.total || 0) - Number(it.gstAmount || 0)),
    });
  }

  // Per-line tax-rate columns. The old in-house layout carried CGST % and
  // SGST % as separate columns, so this reproduces them — and correctly
  // collapses to a single IGST % column on an inter-state supply rather than
  // printing two halves that don't apply.
  if (ic.tax_split) {
    const inter = !!doc.gstBreakup?.interState;
    const parts = inter ? ['IGST'] : ['CGST', 'SGST'];
    for (const label of parts) {
      cols.push({
        key: `rate_${label.toLowerCase()}`, label: `${label} %`, align: 'r',
        get: (it) => {
          const r = Number(it.gstPercent || 0);
          if (!r) return '—';
          return `${(inter ? r : r / 2).toFixed(1)}%`;
        },
      });
    }
    cols.push({
      key: 'tax_amount', label: 'Tax Amount', align: 'r',
      get: (it) => money(it.gstAmount),
    });
  } else {
    cols.push({
      key: 'gst', label: 'GST', align: 'r',
      get: (it) => `${money(it.gstAmount)}<span class="ln-sub"> (${it.gstPercent}%)</span>`,
    });
  }

  cols.push({
    key: 'amount', label: 'Amount', align: 'r', bold: true,
    get: (it) => (isFree(it, flags) ? '<span class="ln-free">FREE</span>' : money(it.total)),
  });

  return cols;
}

/**
 * Display-only. Stored totals are computed by the controller and remain the
 * single source of truth — a template that recomputed them could print an
 * amount the customer was never charged.
 */
function isFree(item, flags) {
  return !!(flags?.free_item_qty && item?.isFree);
}

// ─── Header / meta ────────────────────────────────────────────────────────────

/**
 * Document header rows, already escaped and date-formatted.
 * The adapter decides WHICH rows exist; this only formats them.
 */
function buildHeaderFields(doc, cfg) {
  const withTime = !!cfg.flags?.show_time;
  return (doc.meta || [])
    .filter(m => m && m.value !== null && m.value !== undefined && String(m.value).trim() !== '')
    .map(m => ({
      key: m.key,
      label: esc(m.label),
      value: m.isDate ? esc(formatDate(m.value, { withTime })) : esc(m.value),
    }));
}

// ─── Totals ───────────────────────────────────────────────────────────────────

/**
 * Totals rows: [{ key, label, value, kind }] with value pre-formatted.
 * kind is 'normal' | 'grand' | 'strong' — themes map these onto their own
 * styling. A negative value (discount) is rendered with a minus sign rather
 * than as a negative number.
 */
function buildTotals(doc) {
  return (doc.totals || []).map(t => ({
    key: t.key,
    label: esc(t.label),
    value: t.value < 0 ? `- ${money(Math.abs(t.value))}` : money(t.value),
    kind: t.kind || 'normal',
  }));
}

/**
 * GST breakup lines — either one IGST line or a CGST/SGST pair per rate,
 * decided by place of supply in the adapter. Returns
 * [{ key, label, value }] with the percent folded into the label, e.g.
 * "IGST (18%)" or "CGST (9%)".
 */
function buildGstLines(doc) {
  const bk = doc.gstBreakup || { lines: [] };
  return (bk.lines || []).map(l => ({
    key: `${l.key}_${l.percent}`,
    label: `${l.label} (${l.percent}%)`,
    value: money(l.amount),
  }));
}

/**
 * HSN/SAC-wise tax summary — the rate-wise table a GST tax invoice is required
 * to carry alongside the line items.
 *
 * Rows are grouped by (HSN, GST rate): the same HSN can legitimately appear at
 * two rates, and merging them would misstate the rate-wise breakup.
 *
 * `components` is ['IGST'] for an inter-state supply and ['CGST','SGST'] for
 * an intra-state one, so a theme can build its column headers from it without
 * knowing anything about place-of-supply rules. Each row's `parts` array lines
 * up with `components` index-for-index.
 *
 * Returns null when there's nothing to summarise (no taxable lines), so a
 * theme can skip the whole section rather than print an empty table.
 */
function buildHsnSummary(doc) {
  const interState = !!doc.gstBreakup?.interState;
  const groups = new Map();

  for (const it of (doc.items || [])) {
    const rate = Number(it.gstPercent || 0);
    const tax = Number(it.gstAmount || 0);
    if (rate <= 0 && tax <= 0) continue;           // exempt/zero-rated lines
    const hsn = (it.hsn || '').trim() || '—';
    const key = `${hsn}|${rate}`;
    const g = groups.get(key) || { hsn, rate, taxable: 0, tax: 0 };
    // Taxable value is the amount the tax was charged ON, i.e. the inc-GST
    // line total minus its own GST.
    g.taxable += Number(it.total || 0) - tax;
    g.tax += tax;
    groups.set(key, g);
  }

  if (!groups.size) return null;

  const components = interState ? ['IGST'] : ['CGST', 'SGST'];
  const rows = [...groups.values()]
    .sort((a, b) => (a.hsn === b.hsn ? a.rate - b.rate : a.hsn.localeCompare(b.hsn)))
    .map(g => {
      // Split the same way splitGst does, so this table always reconciles with
      // the totals block: the odd paise goes to the first component.
      let parts;
      if (interState) {
        parts = [{ rate: g.rate, amount: g.tax }];
      } else {
        const half = Math.ceil(g.tax * 100 / 2) / 100;
        parts = [
          { rate: g.rate / 2, amount: half },
          { rate: g.rate / 2, amount: Number((g.tax - half).toFixed(2)) },
        ];
      }
      return {
        hsn: esc(g.hsn),
        taxable: money(g.taxable),
        parts: parts.map(p => ({ rate: p.rate, amount: money(p.amount) })),
        totalTax: money(g.tax),
      };
    });

  const all = [...groups.values()];
  const totals = {
    taxable: money(all.reduce((s, g) => s + g.taxable, 0)),
    totalTax: money(all.reduce((s, g) => s + g.tax, 0)),
  };

  return { interState, components, rows, totals };
}

/**
 * Warranty / guarantee rows for the coverage table, de-duplicated by
 * (type, coverage) with the item names joined — the same promise across five
 * line items should print once, not five times.
 *
 * Returns [] when nothing is covered, so the theme can skip the section.
 */
function buildCoverageRows(doc, cfg) {
  // Gated per document: the warranty is a promise to the CUSTOMER, so it
  // belongs on an estimate and an invoice but not on a hub payout document.
  if (cfg && cfg.flags && cfg.flags.show_warranty === false) return [];
  const groups = new Map();
  for (const it of (doc.items || [])) {
    for (const kind of ['warranty', 'guarantee']) {
      const label = it[kind];
      if (!label) continue;
      const key = `${kind}|${label}`;
      const g = groups.get(key) || { type: kind === 'warranty' ? 'Warranty' : 'Guarantee', coverage: label, names: [] };
      g.names.push(it.name);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map(g => ({
    item: esc(g.names.join(', ')),
    type: esc(g.type),
    coverage: esc(g.coverage),
  }));
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

/**
 * Optional document blocks — terms, bank details, signature, footer.
 * Returns pre-escaped HTML fragments (or null when disabled) so a theme can
 * drop them straight in. Multi-line user text becomes <br/>-separated lines.
 */
function buildBlocks(doc) {
  const b = doc.blocks || {};
  const multiline = (s) => esc(s).replace(/\r?\n/g, '<br/>');

  return {
    terms: b.terms ? multiline(b.terms) : null,
    bankDetails: b.bankDetails ? multiline(b.bankDetails) : null,
    // Labelled rows, pre-escaped — themes that want a proper two-column bank
    // table use this; the flattened bankDetails above is the fallback.
    bankRows: (b.bankRows || []).map(r => ({ label: esc(r.label), value: esc(r.value) })),
    signature: b.signature ? esc(b.signature) : null,
    signatureUrl: b.signatureUrl ? esc(b.signatureUrl) : null,
    footerNote: b.footerNote ? esc(b.footerNote) : null,
    footerDisclaimer: b.footerDisclaimer ? esc(b.footerDisclaimer) : null,
    amountInWords: !!b.amountInWords,
    // Present only when enabled AND generation succeeded.
    //
    // esc() for the same reason signatureUrl gets it: every theme drops this
    // straight into an unquoted-by-convention src="..." attribute. Today the
    // value is always library-generated base64 or a data URI from
    // assetInline, so nothing hostile can reach it — but "the caller is
    // trusted" is exactly the assumption that rots. Escaping is free and
    // base64/data-URI characters are untouched by it.
    qrDataUri: (b.showQr && doc.qrDataUri) ? esc(doc.qrDataUri) : null,
  };
}

/** Footer contact line, honouring the icons toggle (emoji depend on the print device's fonts). */
function buildFooterContact(doc) {
  const b = doc.blocks || {};
  if (!b.showContact) return '';
  const s = doc.seller || {};
  const bits = [];
  if (s.phone) bits.push(b.contactIcons ? `📞 ${esc(s.phone)}` : `Ph: ${esc(s.phone)}`);
  if (s.email) bits.push(b.contactIcons ? `✉ ${esc(s.email)}` : esc(s.email));
  return bits.join('   ·   ');
}

/** Seller address block as escaped HTML lines. */
function sellerAddressHtml(doc) {
  return (doc.seller?.address || []).map(esc).join('<br/>');
}

/** Buyer block rows: name/phone/gstin plus any B2B rows, all escaped. */
function buildBuyerRows(doc) {
  const b = doc.buyer || {};
  const rows = [];
  if (b.phone) rows.push({ label: 'Mobile', value: esc(b.phone) });
  if (b.gstin) rows.push({ label: 'GSTIN', value: esc(b.gstin) });
  for (const m of (b.meta || [])) {
    if (m.value) rows.push({ label: esc(m.label), value: esc(m.value) });
  }
  // The pickup address, present only on a pickup job (see documentAdapter's
  // pickupAddress). Added here rather than in each theme so all 8 inherit it.
  //
  // Labelled just "Address" at the user's request. Worth knowing: this is the
  // COLLECTION point, not necessarily the customer's billing address, and the
  // shorter label loses that distinction.
  if ((b.pickup || []).length) {
    rows.push({
      label: 'Address',
      // Each line escaped separately, then joined with a <br/> the callers
      // insert as markup — same contract as every other value here.
      value: b.pickup.map(esc).join('<br/>'),
    });
  }
  return rows;
}

/** Amount in words — Indian numbering, INR. */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function inWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thou = Math.floor(n / 1000); n %= 1000;
  const hund = Math.floor(n / 100); n %= 100;
  if (crore) parts.push(twoDigits(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thou) parts.push(twoDigits(thou) + ' Thousand');
  if (hund) parts.push(ONES[hund] + ' Hundred');
  if (n) parts.push(twoDigits(n));
  return parts.join(' ');
}

function amountInWords(total) {
  const amt = Number(total || 0);
  const rupees = Math.floor(amt);
  const paise = Math.round((amt - rupees) * 100);
  let s = `${inWords(rupees)} Rupees`;
  if (paise > 0) s += ` and ${inWords(paise)} Paise`;
  return `${s} Only`;
}

/** Grand total value, for the amount-in-words line. */
function grandTotalOf(doc) {
  const g = (doc.totals || []).find(t => t.key === 'grand');
  return g ? g.value : 0;
}

module.exports = {
  buildColumns, buildHeaderFields, buildTotals, buildGstLines, buildBlocks,
  buildHsnSummary, buildCoverageRows, buildFooterContact, sellerAddressHtml, buildBuyerRows,
  amountInWords, grandTotalOf, isFree,
  PAGE_DIMS, pageDims, pageScale, pageScaleCss, pageMarginCss, PRINT_BREAK_CSS,
  QR_CAPTION,
};
