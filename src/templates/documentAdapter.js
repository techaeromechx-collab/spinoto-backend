'use strict';

/**
 * documentAdapter — maps the three source row shapes (estimate, customer
 * invoice, purchase invoice) onto ONE canonical document object that every
 * theme template consumes.
 *
 * Why this exists: the three rows genuinely differ. An estimate has
 * customer_approved/work_status and no payments; a customer invoice has
 * amount_paid/balance/po_number; a purchase invoice's money column is
 * `hub_rate` (not `customer_rate`) and it carries commission and a derived
 * margin. Without this layer every template would need three code paths, and
 * 9 themes x 3 documents becomes 27 templates.
 *
 * Everything document-specific is resolved HERE, exactly once:
 *   - who the buyer is (customer vs hub)
 *   - which rate is the money column
 *   - hub naming policy (legal name vs "Spinoto <area>" vs hidden)
 *   - excluding rejected estimate lines
 *   - intra- vs inter-state tax split
 *   - margin visibility (hard-gated on viewerRole, never on config alone)
 *
 * Themes then branch only on cosmetics.
 */

const {
  resolvePlaceOfSupply, isInterState, splitGst,
  resolvePurchasePlaceOfSupply, isPurchaseInterState, hubSupplierStateCode,
} = require('../utils/gstStates');
const { maskMobile } = require('../utils/maskMobile');
const {
  qrEnabled, ADVANCE_REFUND_TITLE, ADVANCE_REFUND_FOOTER,
} = require('../utils/documentConfig');
const { staticLogoDataUri, inlineUploadUrl } = require('../utils/inlineImage');

const num = (v) => Number(v || 0);

// ─── Shared pieces ────────────────────────────────────────────────────────────

/**
 * The hub/branch label, per the global hub_name_mode setting.
 *
 * The three sources disagree on what "hub name" means, which is exactly why
 * this is centralised:
 *   - estimates/customer invoices select BOTH `hub_name` ('Spinoto ' || area,
 *     e.g. "Spinoto Gota") and `hub_full_name` (the registered legal entity)
 *   - purchase invoices select the raw hubs.hub_name column as `hub_name` —
 *     a third, different value
 * `legalName`/`branchName` are therefore passed in explicitly by each adapter
 * rather than guessed from field names.
 */
function hubLabel(cfg, { legalName, branchName }) {
  switch (cfg.global.hub_name_mode) {
    case 'hidden': return null;
    case 'legal':  return legalName || branchName || null;
    case 'branch':
    default:       return branchName || legalName || null;
  }
}

/**
 * Accent colour lives on the company row (invoice_accent_color), not in
 * document_config — it's deliberately global so a company can't end up with a
 * differently-branded estimate and invoice. Surfaced on the doc so themes
 * don't each have to reach into `company`.
 */
function accentFrom(company) {
  const c = company?.invoice_accent_color;
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : '#4f46e5';
}

function sellerFrom(company, cfg) {
  const address = [
    company?.address_line1,
    company?.address_line2,
    [company?.city, company?.state, company?.pincode].filter(Boolean).join(', '),
  ].filter(Boolean);

  // Both branches must yield something Chrome can load with NO base URL —
  // PDFs are rendered through page.setContent(), where a root-relative path
  // resolves to nothing and fails silently. See utils/inlineImage.js.
  let logoUrl = null;
  if (cfg.global.logo_source === 'uploaded') {
    // Absolute ImageKit URLs pass through; local /uploads paths get inlined.
    logoUrl = inlineUploadUrl(company?.logo_url) || null;
  } else if (cfg.global.logo_source === 'static') {
    logoUrl = staticLogoDataUri();
  }

  return {
    name: company?.company_name || '',
    address,
    gstin: company?.gstin || '',
    phone: cfg.flags.show_phone ? (company?.phone || '') : '',
    email: company?.email || '',
    logoUrl,
  };
}

function formatNumber(cfg, id) {
  const n = String(id ?? '');
  return `${cfg.number_prefix}${cfg.number_pad > 0 ? n.padStart(cfg.number_pad, '0') : n}`;
}

/**
 * Exchange the positions of two meta rows, in place.
 *
 * Used to put Hub / Branch where the registration number would otherwise sit.
 * A swap rather than a reordered array literal because either row can be
 * absent — no vehicle on a walk-in job, no hub on a direct sale — and with one
 * missing the swap is simply a no-op instead of leaving a hole.
 */
function swapMeta(meta, keyA, keyB) {
  const a = meta.findIndex(m => m.key === keyA);
  const b = meta.findIndex(m => m.key === keyB);
  if (a === -1 || b === -1) return meta;
  [meta[a], meta[b]] = [meta[b], meta[a]];
  return meta;
}

/** Vehicle rows are shared by all three documents. */
function vehicleMeta(row, cfg) {
  const meta = [];
  if (cfg.header_fields.vehicle_number && row.vehicle_number) {
    meta.push({ key: 'vehicle', label: 'Reg. No.', value: row.vehicle_number });
  }
  const makeModel = [row.make_name, row.model_name].filter(Boolean).join(' ');
  if (makeModel) meta.push({ key: 'make_model', label: 'Make / Model', value: makeModel });
  if (row.body_type_name) meta.push({ key: 'body_type', label: 'Body Type', value: row.body_type_name });
  if (row.cc_category_name) meta.push({ key: 'cc', label: 'CC Category', value: row.cc_category_name });
  return meta;
}

/** User-defined header fields, shared shape across documents. */
function customMeta(row, cfg) {
  const values = row.custom_fields || {};
  return (cfg.custom_fields || [])
    .filter(f => f.enabled !== false && f.label)
    .map(f => ({ key: `custom:${f.id}`, label: f.label, value: values[f.id] }))
    .filter(m => m.value);
}

/**
 * GST breakup, split intra- vs inter-state.
 *
 * Groups the per-item GST by rate (as the templates already did), then splits
 * each rate into either one IGST line or a CGST/SGST pair. Rates contributing
 * no tax are dropped so a 0% line never prints an empty row.
 */
function gstBreakupFrom(items, interState) {
  const byRate = new Map();
  for (const it of items) {
    const rate = num(it.gstPercent);
    const amt = num(it.gstAmount);
    if (rate <= 0 || amt <= 0) continue;
    byRate.set(rate, (byRate.get(rate) || 0) + amt);
  }
  const lines = [];
  for (const rate of [...byRate.keys()].sort((a, b) => b - a)) {
    lines.push(...splitGst(byRate.get(rate), rate, interState));
  }
  return { interState, lines };
}

function blocksFrom(cfg, company) {
  const b = cfg.bank_details || {};
  // Only labelled rows that actually have a value — an enabled-but-empty bank
  // block would otherwise print a heading with nothing under it.
  const bankRows = !cfg.show_bank ? [] : [
    ['Name',        b.account_name],
    ['Bank',        b.bank_name],
    ['Account No',  b.account_no],
    ['IFSC Code',   b.ifsc],
    ['Branch',      b.branch],
  ].filter(([, v]) => v && String(v).trim())
   .map(([label, value]) => ({ label, value: String(value).trim() }));

  return {
    terms: cfg.show_terms ? (cfg.terms || '') : '',
    signature: cfg.show_signature ? (cfg.signature_label || 'Authorised Signatory') : null,
    // The uploaded signature/stamp image, printed above the signatory line.
    signatureUrl: cfg.show_signature ? (company?.signature_url || null) : null,
    bankRows,
    // Flattened form kept for themes that render the bank block as free text
    // rather than a labelled table.
    bankDetails: bankRows.map(r => `${r.label}: ${r.value}`).join('\n'),
    // ?? not ||: the per-document value is authoritative whenever it is a
    // string, INCLUDING ''. Only null/undefined means "inherit the global".
    // An estimate uses this to keep "subject to change upon final inspection",
    // which would be wrong on an invoice.
    footerNote: cfg.footer_note ?? cfg.global.footer_note ?? '',
    footerDisclaimer: cfg.footer_disclaimer ?? cfg.global.footer_disclaimer ?? '',
    showContact: !!cfg.global.footer_contact,
    contactIcons: !!cfg.global.footer_contact_icons,
    // Master AND this document's own flag — see documentConfig.qrEnabled.
    showQr: qrEnabled(cfg),
    amountInWords: !!cfg.global.amount_in_words,
  };
}

/**
 * Pickup address lines, or [] when the job wasn't a pickup.
 *
 * Deliberately gated on `pickup_required` rather than on the address being
 * non-empty: a stale address can outlive the flag being switched off (the form
 * doesn't clear the fields), and printing a pickup address for a job the
 * customer drove in for is worse than printing nothing.
 *
 * Purchase invoices don't get this — they bill the HUB, so a customer's pickup
 * point has no place in that document's party block.
 */
function pickupAddress(row) {
  if (!row.pickup_required) return [];
  // On a B2B document the billed party is the company, and the address that
  // belongs on the invoice is the company's registered one (b2bMeta). The
  // pickup point is where the car was collected from — useful operationally,
  // but it is not the recipient's address, and printing both produced two rows
  // both labelled "Address" with different meanings.
  if (row.is_b2b && row.b2b_address) return [];
  const cityLine = [row.pickup_city, row.pickup_pincode].filter(Boolean).join(', ');
  return [row.pickup_address_line1, row.pickup_address_line2, cityLine]
    .map(v => (v === null || v === undefined ? '' : String(v).trim()))
    .filter(Boolean);
}

/**
 * B2B billing rows, shared by estimate + customer invoice.
 *
 * NO GSTIN ROW HERE — deliberately.
 *
 * `buyer.gstin` (below) is already set from the same `row.b2b_gst_number`, and
 * docShared's buildBuyerRows renders buyer.gstin AND every meta row. Emitting
 * it in both places printed the customer's GSTIN twice, identically, on every
 * B2B invoice in every theme.
 *
 * buyer.gstin is the one that stays, because a purchase invoice uses it for the
 * HUB's GSTIN and passes `meta: []` — dropping it there would remove the GSTIN
 * from purchase invoices entirely.
 *
 * Note this is display only. Place-of-supply and the IGST-vs-CGST/SGST split
 * read `row.b2b_gst_number` straight off the database row (utils/gstStates),
 * not either of these, so the tax calculation is untouched.
 */
function b2bMeta(row) {
  if (!row.is_b2b) return [];
  const out = [];
  // On a B2B document the COMPANY is the billed party and becomes the heading
  // (see buyerName), so the individual moves down here as a labelled row. That
  // is who a registered recipient actually is under GST — the business, not
  // the person who dropped the car off.
  //
  // Guarded on b2b_company_name for the same reason buyerName is: with no
  // company recorded the person stays as the heading, and repeating them here
  // would print the same name twice.
  if (row.b2b_company_name && row.customer_name) {
    out.push({ key: 'b2b_contact', label: 'Customer Name', value: row.customer_name });
  }
  if (row.b2b_address) out.push({ key: 'b2b_address', label: 'Address', value: row.b2b_address });
  return out;
}

/**
 * Who the document is billed to.
 *
 * B2B with a company on file → the company. Everything else → the individual,
 * which is also the fallback when is_b2b is set but no company name was
 * captured; an empty heading would be worse than a slightly informal one.
 */
function buyerName(row) {
  if (row.is_b2b && row.b2b_company_name) return row.b2b_company_name;
  return row.customer_name || '';
}

/**
 * Human-readable coverage label from the warranty/guarantee columns, e.g.
 * "6 Months / 5,000 KM (whichever is earlier)". Free text wins when present,
 * since it was entered deliberately.
 */
function coverageLabel(src, kind) {
  const p = kind === 'warranty'
    ? { text: src.warranty_text, months: src.warranty_months, days: src.warranty_days, km: src.warranty_km }
    : { text: src.guarantee_text, months: src.guarantee_months, days: src.guarantee_days, km: src.guarantee_km };
  if (p.text && String(p.text).trim()) return String(p.text).trim();
  const bits = [];
  if (p.months) bits.push(`${p.months} Month${p.months > 1 ? 's' : ''}`);
  if (p.days)   bits.push(`${p.days} Day${p.days > 1 ? 's' : ''}`);
  if (p.km)     bits.push(`${Number(p.km).toLocaleString('en-IN')} KM`);
  if (!bits.length) return '';
  return bits.join(' / ') + (bits.length > 1 ? ' (whichever is earlier)' : '');
}

/**
 * The customer-facing per-unit rate, INCLUDING GST and BEFORE discount.
 *
 * `customer_rate` is stored EX-GST, so printing it as "Rate" produced a column
 * identical to "Taxable" (both ended up as the taxable base) and one that
 * didn't reconcile with "Amount" — a customer reading Rate 422.88 next to
 * Amount 499.00 has a fair question. The screen has always derived this figure
 * instead; the templates now do the same, so the two agree by construction.
 *
 * Adding the discount back gives the LIST price, which is what makes the row
 * read coherently across Rate → Disc. → Amount:
 *
 *   rate x qty - discount = (total + discount) - discount = total  ✓
 *
 * Only meaningful for documents whose money column is the customer's price
 * (estimate, customer invoice). A purchase invoice's hub rate is genuinely
 * ex-GST and is passed through untouched — see fromPurchaseInvoice.
 */
function customerIncRate(src) {
  const qty = num(src.quantity);
  if (qty <= 0) return num(src.customer_rate);      // guard: never divide by 0
  return (num(src.total_inc_gst) + num(src.discount_amount)) / qty;
}

/** Normalise one line item. `rate` is whichever rate is this document's money column. */
function itemFrom(src, { rate, total }) {
  return {
    id: src.id,
    type: src.item_type,
    name: src.description || '',
    description: src.item_description || '',
    hsn: src.hsn_sac || '',
    qty: num(src.quantity),
    rate: num(rate),
    discount: num(src.discount_amount),
    discountType: src.discount_type || null,
    discountValue: num(src.discount_value),
    gstPercent: num(src.gst_percent),
    gstAmount: num(src.gst_amount),
    total: num(total),
    batchNo: src.batch_no || '',
    mfgDate: src.mfg_date || null,
    expDate: src.exp_date || null,
    isFree: !!src.is_free,
    customValues: src.custom_values || {},
    priceHistory: src.price_history || [],
    warranty: coverageLabel(src, 'warranty'),
    guarantee: coverageLabel(src, 'guarantee'),
    // Purchase-invoice-only reference values; undefined elsewhere.
    customerRate: src.customer_rate !== undefined ? num(src.customer_rate) : undefined,
    commissionPercent: src.commission_percent !== undefined ? num(src.commission_percent) : undefined,
  };
}

function totalsFrom(rows) {
  return rows.filter(Boolean);
}

// ─── Estimate ─────────────────────────────────────────────────────────────────

// The customer's number, masked on anything a hub receives. cfg.viewerRole is
// resolved server-side from the session (see purchase_invoices.routes.js), so a
// hub cannot request the admin view of its own document — the same hard gate
// the margin columns sit behind.
function buyerPhone(row, cfg) {
  return cfg.viewerRole === 'hub' ? maskMobile(row.mobile) : (row.mobile || '');
}

function fromEstimate(row, company, cfg) {
  // Rejected lines are excluded from the printed table, not just the totals.
  // The old layout printed them while omitting them from the sum, so the
  // visible rows didn't add up to the visible Grand Total — a real support
  // problem on a customer-facing document.
  const src = (row.items || []).filter(i => i.customer_approved !== false);
  // Inc-GST list price, matching what the estimate screen shows.
  const items = src.map(i => itemFrom(i, { rate: customerIncRate(i), total: i.total_inc_gst }));

  const pos = resolvePlaceOfSupply(row, company);
  const interState = isInterState(company, pos.code);

  const meta = [
    { key: 'number', label: 'Est. No.', value: formatNumber(cfg, row.id) },
    // The estimate's own date (migration 101) — when the work happened,
    // not when the row was keyed in. Falls back for any caller that
    // hasn't selected the column.
    { key: 'date',   label: 'Date',     value: row.estimate_date || row.created_at, isDate: true },
    ...(cfg.flags.show_status && row.status ? [{ key: 'status', label: 'Status', value: row.status }] : []),
    ...vehicleMeta(row, cfg),
    ...(cfg.header_fields.place_of_supply && pos.name
      ? [{ key: 'pos', label: 'Place of Supply', value: `${pos.code} — ${pos.name}` }] : []),
    ...customMeta(row, cfg),
  ];

  const hub = hubLabel(cfg, { legalName: row.hub_full_name, branchName: row.hub_name });
  if (hub) meta.push({ key: 'hub', label: 'Hub / Branch', value: hub });
  // Hub / Branch takes the registration number's slot; the reg. no. moves to
  // where the hub was, at the end.
  swapMeta(meta, 'hub', 'vehicle');

  const subtotal = num(row.subtotal_ex_gst);
  const totalGst = num(row.total_gst);
  const grand = num(row.grand_total);
  const discount = num(row.transaction_discount_amount) ||
    items.reduce((s, i) => s + i.discount, 0);

  return {
    docType: 'estimate',
    viewerRole: cfg.viewerRole,
    accent: accentFrom(company),
    publicToken: row.public_token || null,
    // Filled in asynchronously by the render pipeline (utils/renderDocument)
    // because QR generation can't happen inside a synchronous template.
    qrDataUri: null,
    title: cfg.title,
    number: formatNumber(cfg, row.id),
    date: row.created_at,
    seller: sellerFrom(company, cfg),
    buyer: {
      name: buyerName(row),
      phone: buyerPhone(row, cfg),
      gstin: row.is_b2b ? (row.b2b_gst_number || '') : '',
      meta: b2bMeta(row),
      // Empty array unless the job was a pickup — see pickupAddress().
      pickup: pickupAddress(row),
    },
    meta,
    items,
    totals: totalsFrom([
      { key: 'subtotal', label: 'Subtotal (ex-GST)', value: subtotal, kind: 'normal' },
      discount ? { key: 'discount', label: 'Total Discount', value: -discount, kind: 'normal' } : null,
      { key: 'gst',   label: 'Total GST',   value: totalGst, kind: 'normal' },
      { key: 'grand', label: 'Grand Total', value: grand,    kind: 'grand'  },
    ]),
    gstBreakup: gstBreakupFrom(items, interState),
    placeOfSupply: pos,
    payments: [],
    notes: row.notes || '',
    blocks: blocksFrom(cfg, company),
  };
}

// ─── Customer invoice ─────────────────────────────────────────────────────────

/**
 * "Advance Applied (ADV-2026-27-000042)".
 *
 * The voucher number belongs ON the line. Without it the receipt voucher and
 * the invoice describe the same ₹2,000 with no link between them, and matching
 * the two at year end becomes a manual job.
 *
 * Two numbers are printed in full; beyond that the count is stated instead,
 * because a totals row is one line and four voucher numbers would wrap it into
 * three. `advance_vouchers` is a comma-separated list from the select — absent
 * on an older response, in which case the label is simply unqualified rather
 * than wrong.
 */
function advanceLabel(row) {
  const list = String(row.advance_vouchers || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return 'Advance Applied';
  if (list.length <= 2) return `Advance Applied (${list.join(', ')})`;
  return `Advance Applied (${list.length} receipts)`;
}

function fromCustomerInvoice(row, company, cfg) {
  // Inc-GST list price, matching what the invoice screen shows.
  const items = (row.items || []).map(i => itemFrom(i, { rate: customerIncRate(i), total: i.total_inc_gst }));

  const pos = resolvePlaceOfSupply(row, company);
  const interState = isInterState(company, pos.code);

  const meta = [
    { key: 'number', label: 'Invoice No.', value: formatNumber(cfg, row.id) },
    // The date PRINTED on a tax invoice is the legal date, so it must be
    // invoice_date — not created_at, which is only when the row was keyed in.
    // Getting this wrong on a backdated invoice is a compliance defect, not a
    // cosmetic one. Falls back to created_at so a caller that hasn't selected
    // the column still prints something rather than a blank date.
    { key: 'date',   label: 'Date',        value: row.invoice_date || row.created_at, isDate: true },
    ...(cfg.flags.show_status && row.status ? [{ key: 'status', label: 'Status', value: row.status }] : []),
    ...vehicleMeta(row, cfg),
    ...(cfg.header_fields.po_number && row.po_number
      ? [{ key: 'po', label: 'PO Number', value: row.po_number }] : []),
    ...(cfg.header_fields.eway_bill && row.eway_bill_number
      ? [{ key: 'eway', label: 'E-way Bill No.', value: row.eway_bill_number }] : []),
    ...(cfg.header_fields.place_of_supply && pos.name
      ? [{ key: 'pos', label: 'Place of Supply', value: `${pos.code} — ${pos.name}` }] : []),
    ...customMeta(row, cfg),
  ];

  const hub = hubLabel(cfg, { legalName: row.hub_full_name, branchName: row.hub_name });
  if (hub) meta.push({ key: 'hub', label: 'Hub / Branch', value: hub });
  // Hub / Branch takes the registration number's slot; the reg. no. moves to
  // where the hub was, at the end.
  swapMeta(meta, 'hub', 'vehicle');
  if (cfg.global.show_hub_gstin && row.hub_gst) {
    meta.push({ key: 'hub_gstin', label: 'Hub GSTIN', value: row.hub_gst });
  }

  const subtotal = num(row.subtotal_ex_gst);
  const totalGst = num(row.total_gst);
  const grand = num(row.grand_total);
  const paid = num(row.amount_paid);
  const balance = row.balance !== undefined ? num(row.balance) : grand - paid;
  const discount = num(row.transaction_discount_amount) ||
    items.reduce((s, i) => s + i.discount, 0);

  // ── The advance line, and the trap it exists to avoid ─────────────────────
  //
  // An advance that has been applied to this invoice is ALREADY inside
  // amount_paid, and is ALREADY listed in the Payments block below. Adding an
  // "Advance Applied" row on top of that would count the same money twice:
  // ₹8,000 total, ₹2,000 advance, ₹8,000 paid, and a balance that does not add
  // up in front of the customer.
  //
  // So the Paid row is SPLIT, never added to:
  //
  //     Advance Applied (ADV-2026-27-000042)   ₹2,000.00
  //     Payments Received                      ₹6,000.00
  //     ──────────────────────────────────────────────
  //     Balance Due                                ₹0.00
  //
  // advance + payments === paid, always. The arithmetic is untouched; only the
  // presentation splits.
  //
  // POSITIVE, not negative. docShared.buildTotals renders a negative as
  // "- 1,234.00", but luxury.js additionally moves the minus ahead of the ₹, so
  // one number would print as "₹ - 2,000.00" in six themes and "- ₹2,000.00" in
  // the seventh. The label carries the meaning instead.
  //
  // The Math.min is the ONLY guard here, and it is doing real work: it is what
  // makes the subtraction below incapable of going negative. A bad backfill or
  // a hand-edited row could leave advance_applied above amount_paid, and
  // "Payments Received −₹1,999.00" on a customer's invoice is a worse answer
  // than showing the advance capped at what was actually received.
  //
  // A second Math.max(0, …) on the subtraction would be provably dead code, and
  // dead code that looks like a safety check is worse than none — it invites
  // the real guard to be removed as redundant.
  const advanceApplied = Math.min(num(row.advance_applied), paid);
  const showAdvance = cfg.flags.show_advance_line !== false && advanceApplied > 0.005;
  const paymentsReceived = Number((paid - advanceApplied).toFixed(2));

  return {
    docType: 'customer_invoice',
    viewerRole: cfg.viewerRole,
    accent: accentFrom(company),
    publicToken: row.public_token || null,
    // Filled in asynchronously by the render pipeline (utils/renderDocument)
    // because QR generation can't happen inside a synchronous template.
    qrDataUri: null,
    title: cfg.title,
    number: formatNumber(cfg, row.id),
    date: row.created_at,
    seller: sellerFrom(company, cfg),
    buyer: {
      name: buyerName(row),
      phone: buyerPhone(row, cfg),
      gstin: row.is_b2b ? (row.b2b_gst_number || '') : '',
      meta: b2bMeta(row),
      // Empty array unless the job was a pickup — see pickupAddress().
      pickup: pickupAddress(row),
    },
    meta,
    items,
    totals: totalsFrom([
      { key: 'subtotal', label: 'Subtotal (ex-GST)', value: subtotal, kind: 'normal' },
      discount ? { key: 'discount', label: 'Total Discount', value: -discount, kind: 'normal' } : null,
      { key: 'gst',     label: 'Total GST',   value: totalGst, kind: 'normal' },
      { key: 'grand',   label: 'Grand Total', value: grand,    kind: 'grand'  },
      // Present only when an advance was actually applied. With no advance the
      // rows below are byte-identical to what every invoice printed before this
      // existed — one row, labelled "Paid".
      showAdvance
        ? { key: 'advance', label: advanceLabel(row), value: advanceApplied, kind: 'normal' }
        : null,
      {
        key: 'paid',
        // Relabelled only when it has been split. Left as "Paid" otherwise,
        // because "Payments Received" on an invoice with no advance would be a
        // change of wording with no change of meaning.
        label: showAdvance ? 'Payments Received' : 'Paid',
        value: showAdvance ? paymentsReceived : paid,
        kind: 'normal',
      },
      { key: 'balance', label: 'Balance Due', value: balance,  kind: 'strong' },
      (cfg.flags.show_party_balance && row.party_balance !== undefined && row.party_balance !== null)
        ? { key: 'party_balance', label: 'Total Outstanding', value: num(row.party_balance), kind: 'strong' }
        : null,
    ]),
    gstBreakup: gstBreakupFrom(items, interState),
    placeOfSupply: pos,
    payments: (row.payments || []).map(p => ({
      date: p.paid_at, method: p.method, reference: p.reference_no, amount: num(p.amount), notes: p.notes,
    })),
    notes: row.notes || '',
    blocks: blocksFrom(cfg, company),
  };
}

// ─── Purchase invoice ─────────────────────────────────────────────────────────

function fromPurchaseInvoice(row, company, cfg) {
  // The money column here is hub_rate — what the company owes the hub.
  // customer_rate is carried through only as a reference for the admin copy.
  const items = (row.items || []).map(i => {
    const hubRate = num(i.hub_rate);
    const qty = num(i.quantity);
    const gst = num(i.gst_amount);
    const total = i.total_payable !== undefined && i.total_payable !== null
      ? num(i.total_payable)
      : hubRate * qty + gst;
    // hubRate is passed through as stored — deliberately NOT run through
    // customerIncRate. A purchase invoice's money column is the hub's ex-GST
    // rate, GST is added at the line level to reach total_payable, and the
    // Purchase Invoices screen shows hub_rate raw. Deriving an inc-GST figure
    // here would make print disagree with the screen in the other direction.
    return itemFrom(i, { rate: hubRate, total });
  });

  // ── Who is supplying whom ──────────────────────────────────────────────
  //
  // This document is the HUB's sales invoice: the hub supplies the work,
  // Spinoto buys it. So the supplier is the hub and the recipient is Spinoto —
  // the opposite of every other document this adapter builds.
  //
  // The purchase-invoice variants are used here deliberately. The generic
  // resolvePlaceOfSupply/isInterState put Spinoto's state on BOTH sides of the
  // comparison, which made every hub's invoice print CGST+SGST; a Maharashtra
  // hub billing a Gujarat company owes IGST. Right total, wrong heads, and it
  // carries into the hub's GSTR-1.
  const pos = resolvePurchasePlaceOfSupply(row, company);
  const interState = isPurchaseInterState(row, company);
  const isHubView = cfg.viewerRole === 'hub';

  // A hub that is not GST-registered cannot issue a tax invoice and cannot
  // charge tax. Its document is a Bill of Supply: no tax columns, no breakup,
  // no GSTIN, and a declaration saying why.
  //
  // Reads the SNAPSHOT (migration 120), never hubs.has_gst — a hub that
  // registers next March must not retroactively turn last year's bills of
  // supply into tax invoices. `!== false` so pre-migration rows, where the
  // snapshot is NULL, keep rendering exactly as they do today.
  const isTaxInvoice = row.hub_has_gst !== false;

  const meta = [
    { key: 'number', label: 'Invoice No.', value: formatNumber(cfg, row.id) },
    // Same rule as the customer invoice: the printed date is the legal date.
    { key: 'date',   label: 'Date',        value: row.invoice_date || row.created_at, isDate: true },
    ...(cfg.flags.show_status && row.status ? [{ key: 'status', label: 'Status', value: row.status }] : []),
    ...vehicleMeta(row, cfg),
    ...(cfg.header_fields.place_of_supply && pos.name
      ? [{ key: 'pos', label: 'Place of Supply', value: `${pos.code} — ${pos.name}` }] : []),
    ...customMeta(row, cfg),
  ];
  // The end customer is context for which job this covers, not a party.
  if (row.customer_name) meta.push({ key: 'job_customer', label: 'Job for', value: row.customer_name });

  // The hub is the SELLER on this document, not the bill-to. It used to be
  // rendered as the counterparty under a Spinoto letterhead, which reads as
  // "Spinoto is selling to the hub" — backwards, and invalid as the hub's own
  // tax invoice, where the supplier's name, address and GSTIN must head the
  // page.
  //
  // Prefers the snapshot taken at issue (migration 120) over the live join, so
  // a hub that moves premises or corrects its GSTIN does not rewrite invoices
  // it has already been given.
  //
  // NOT hubLabel(). That helper honours cfg.global.hub_name_mode, which
  // defaults to 'branch' — a sensible display preference on a customer-facing
  // document, where "Spinoto Satellite" reads better than the LLP name. On the
  // supplier line of a tax invoice it is wrong: the registered legal name is
  // what must appear, and a display setting must not be able to override a
  // legal requirement. Legal name first, always, with the trading name only as
  // a fallback for a hub that has not recorded one.
  const hubName = row.hub_legal_name || row.hub_full_name || row.hub_name || '';

  const subtotal = num(row.subtotal_ex_gst);
  const totalGst = num(row.total_gst);
  const grand = num(row.grand_total);
  const paid = num(row.amount_paid);

  return {
    docType: 'purchase_invoice',
    viewerRole: cfg.viewerRole,
    accent: accentFrom(company),
    publicToken: row.public_token || null,
    // Filled in asynchronously by the render pipeline (utils/renderDocument)
    // because QR generation can't happen inside a synchronous template.
    qrDataUri: null,
    // A Bill of Supply is not a tax invoice and must not be titled as one.
    title: isTaxInvoice ? cfg.title : 'BILL OF SUPPLY',
    // The hub's own number once assigned (migration 121), falling back to the
    // derived SI-/PI- form for invoices raised before the per-hub series
    // existed. Those numbers are already filed in hubs' returns, so they are
    // never regenerated.
    number: row.invoice_number || formatNumber(cfg, row.id),
    date: row.created_at,
    // Supplier = the hub. `address` is an array of lines, matching sellerFrom's
    // shape so the themes need no branch. hub_address is stored pre-joined
    // (migration 120) precisely so it does not have to be reassembled here.
    //
    // No `show_hub_gstin` gate on the GSTIN any more: that flag made sense
    // when the hub was an incidental counterparty. On the hub's own tax
    // invoice the supplier's GSTIN is mandatory, so it is not optional.
    // Missing values render as a visible gap rather than being dropped — an
    // invoice without a supplier address should look broken, because it is.
    seller: {
      ...sellerFrom(company, cfg),
      name: hubName || '',
      address: String(row.hub_address || '').split('\n').map(l => l.trim()).filter(Boolean),
      gstin: isTaxInvoice ? (row.hub_gstin || row.hub_gst || '') : '',
      phone: '',
      email: '',
      // The letterhead logo belongs to whoever heads the page. Spinoto's logo
      // above a hub's name and GSTIN would misrepresent who issued the invoice.
      logoUrl: null,
    },
    // Recipient = Spinoto.
    buyer: (() => {
      const c = sellerFrom(company, cfg);
      return { name: c.name, address: c.address, gstin: c.gstin, phone: '', meta: [] };
    })(),
    meta,
    items,
    totals: totalsFrom([
      { key: 'subtotal', label: isHubView ? (isTaxInvoice ? 'Subtotal (ex-GST)' : 'Subtotal') : 'Subtotal (hub ex-GST)', value: subtotal, kind: 'normal' },
      // Dropped entirely, not zeroed: a Bill of Supply showing "Total GST ₹0.00"
      // still reads as a document that considered charging tax.
      ...(isTaxInvoice ? [{ key: 'gst', label: 'Total GST', value: totalGst, kind: 'normal' }] : []),
      { key: 'grand', label: isHubView ? 'Grand Total Receivable' : 'Grand Total Payable to Hub', value: grand, kind: 'grand' },
      { key: 'paid',    label: isHubView ? 'Paid to You' : 'Paid to Hub', value: paid, kind: 'normal' },
      { key: 'balance', label: 'Balance Due', value: grand - paid, kind: 'strong' },
    ]),
    // Shape must stay { interState, lines } even when empty — themes destructure
    // it, and handing them a bare array would throw at render rather than
    // simply printing no tax rows.
    gstBreakup: isTaxInvoice ? gstBreakupFrom(items, interState) : { interState: false, lines: [] },
    placeOfSupply: pos,
    payments: (row.hub_payments || []).map(p => ({
      date: p.paid_at, method: p.method, reference: p.reference_no, amount: num(p.amount), notes: p.notes,
    })),
    notes: row.notes || '',
    blocks: {
      ...blocksFrom(cfg, company),
      // The signature block belongs to whoever issued the document. Spinoto's
      // uploaded signature image above a hub's letterhead would be a
      // misrepresentation, so it is dropped and the standard declaration is
      // used instead. A hub signature upload can replace this later.
      signatureUrl: null,
      signature: 'Computer generated invoice — no signature required',
      // Mandatory on every tax invoice, even when the answer is "No". Absent
      // until now.
      declarations: [
        ...(isTaxInvoice
          ? ['Tax payable on reverse charge: No']
          : ['Supplier is not registered under GST. This is a Bill of Supply — no tax is charged or collected.']),
        // Spinoto raises this document on the hub's behalf. An auditor asks
        // about that first, so it is stated on the face of the invoice; the
        // matching clause belongs in the hub agreement.
        `Self-billed by ${company?.company_name || 'the recipient'} on behalf of the supplier.`,
      ],
    },
    // Consumed by buildColumns to decide whether the reference/margin columns
    // render. buildColumns ALSO re-checks viewerRole itself — belt and braces,
    // because a config edit must never be able to expose margin to a hub.
    rateMode: row.rate_mode || null,
    showMargin: cfg.margin_columns && cfg.viewerRole === 'admin',
  };
}

// ─── Advance receipt / refund voucher ─────────────────────────────────────────

/**
 * The document for money taken (or returned) before the invoice exists.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER THREE
 * ──────────────────────────────────────────────
 * There are no items. A receipt voucher is not a bill for anything — it is an
 * acknowledgement of a sum, and of the tax inside that sum. Itemising it would
 * mean inventing lines the customer has not been charged for yet.
 *
 * So `items` is deliberately empty and `totals` carries the whole story:
 *
 *     Taxable Value     ₹1,694.92
 *     GST @18%            ₹305.08
 *     Advance Received  ₹2,000.00      ← what the customer actually handed over
 *
 * THE NUMBER IS NOT BUILT FROM THE ROW ID
 * ───────────────────────────────────────
 * Every other document composes its number from the id plus a configured prefix
 * and padding. This one cannot: a tax series must be consecutive with no gaps,
 * and ids are consumed by payment links nobody ever pays. The number was issued
 * at capture (advances.service.issueVoucherNumber) and stored; here it is
 * simply printed. formatNumber() is not called, and must not be.
 *
 * THE TAX IS SNAPSHOTTED, NOT RECOMPUTED
 * ──────────────────────────────────────
 * row.gst_amount and row.gst_rate were frozen when the money was taken, at the
 * proportion the estimate had at that moment. Recomputing them here would
 * silently reprint a different figure the day someone edits a line on that
 * estimate — while the customer is holding the old one.
 */
function fromAdvanceReceipt(row, company, cfg) {
  const isRefund = row.kind === 'refund';
  // Money on the customer's account, belonging to no job yet. The document has
  // to say so: a receipt that looks job-shaped but names no job reads as one
  // where the job failed to print.
  const onAccount = !isRefund && !row.estimate_id;

  const amount = num(row.amount);
  const gst = num(row.gst_amount);
  const taxable = Number((amount - gst).toFixed(2));
  const rate = num(row.gst_rate);

  const pos = resolvePlaceOfSupply(row, company);
  const interState = isInterState(company, pos.code);

  const jobTotal = num(row.job_total);
  const advanced = num(row.job_advanced);

  const meta = [
    // Just "Voucher No." on both — the title already says which kind, and
    // "Refund Voucher No." wraps onto two lines in the header column.
    { key: 'number', label: 'Voucher No.', value: row.voucher_no || '—' },
    { key: 'date', label: 'Date', value: row.paid_at || row.created_at, isDate: true },
    // A refund points at the receipt it reverses; a receipt points at the job.
    // Naming the job on a refund would leave the customer holding two documents
    // with no stated relationship between them.
    ...(isRefund && row.against_voucher_no
      ? [{ key: 'against', label: 'Against Receipt', value: row.against_voucher_no }]
      : row.estimate_id
        ? [{ key: 'against', label: 'Against', value: `EST-${String(row.estimate_id).padStart(6, '0')}` }]
        : []),
    ...vehicleMeta(row, cfg),
    ...(cfg.header_fields.place_of_supply && pos.name
      ? [{ key: 'pos', label: 'Place of Supply', value: `${pos.code} — ${pos.name}` }] : []),
    ...customMeta(row, cfg),
  ];

  const hub = hubLabel(cfg, { legalName: row.hub_full_name, branchName: row.hub_name });
  if (hub) meta.push({ key: 'hub', label: 'Hub / Branch', value: hub });
  if (cfg.global.show_hub_gstin && row.hub_gst) {
    meta.push({ key: 'hub_gstin', label: 'Hub GSTIN', value: row.hub_gst });
  }

  return {
    docType: 'advance_receipt',
    // The same document with the money going the other way. The renderer reads
    // this for the few sentences that have to differ, rather than the caller
    // choosing between two templates.
    kind: isRefund ? 'refund' : 'receipt',
    onAccount,
    viewerRole: cfg.viewerRole,
    accent: accentFrom(company),
    publicToken: row.public_token || null,
    qrDataUri: null,
    title: isRefund ? ADVANCE_REFUND_TITLE : cfg.title,
    number: row.voucher_no || '',
    date: row.paid_at || row.created_at,
    seller: sellerFrom(company, cfg),
    buyer: {
      name: buyerName(row),
      phone: buyerPhone(row, cfg),
      gstin: row.is_b2b ? (row.b2b_gst_number || '') : '',
      meta: b2bMeta(row),
      // A receipt voucher acknowledges money, not a collection. The pickup
      // address belongs on the document that describes the work.
      pickup: [],
    },
    meta,

    // No item table. See the header note — this absence is the document.
    items: [],

    totals: totalsFrom([
      { key: 'taxable', label: 'Taxable Value', value: taxable, kind: 'normal' },
      {
        key: 'gst',
        // The rate goes in the label because there is no per-line tax column to
        // carry it, and "GST ₹305.08" with no rate stated is not a tax document.
        label: rate ? `GST @${rate % 1 === 0 ? rate.toFixed(0) : rate.toFixed(2)}%` : 'GST',
        value: gst,
        kind: 'normal',
      },
      {
        key: 'grand',
        label: isRefund ? 'Amount Refunded' : 'Advance Received',
        value: amount,
        kind: 'grand',
      },
    ]),

    // { interState, lines } — the shape docShared.buildGstLines reads. A plain
    // array here parses without error and renders NOTHING, which is how a tax
    // document quietly ships without its CGST/SGST split.
    gstBreakup: { interState, lines: gst > 0 ? splitGst(gst, rate, interState) : [] },
    placeOfSupply: pos,

    // The job this money belongs to. Null rather than 0 when it isn't known, so
    // the renderer omits the block instead of printing a confident "₹0.00 left
    // to pay" on a job whose total it could not read.
    job: {
      // Omitted entirely on a refund. Without the "still to pay" line it
      // collapses to a single "Job total" row — a card with one number in it,
      // which reads as something that failed to render. The job is already
      // named on a refund by the receipt it reverses.
      total: (!isRefund && jobTotal) ? jobTotal : null,
      advanced: advanced || null,
      // Only meaningful on a receipt: a refund does not change what the job
      // costs, and printing a "remaining" figure on one would suggest it does.
      balanceAfter: (!isRefund && jobTotal) ? Number((jobTotal - advanced).toFixed(2)) : null,
    },

    // How the money moved. On a receipt this is the first thing the customer
    // checks against their own bank message.
    received: {
      method: row.method || '',
      reference: row.reference_no || row.txn_ref || '',
      on: row.paid_at || row.created_at,
    },

    payments: [],
    notes: row.notes || '',
    blocks: isRefund
      // See ADVANCE_REFUND_FOOTER: the receipt's footer promises the money will
      // be adjusted against the invoice, which is false once it has gone back.
      ? { ...blocksFrom(cfg, company), footerNote: ADVANCE_REFUND_FOOTER }
      : onAccount
        // The on-account block above says this, and says it better — it also
        // covers the refundable balance. Two sentences making the same promise
        // on a one-page document is noise, not emphasis.
        ? { ...blocksFrom(cfg, company), footerNote: '' }
        : blocksFrom(cfg, company),
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const ADAPTERS = {
  estimate: fromEstimate,
  customer_invoice: fromCustomerInvoice,
  purchase_invoice: fromPurchaseInvoice,
  advance_receipt: fromAdvanceReceipt,
};

/**
 * @param {'estimate'|'customer_invoice'|'purchase_invoice'|'advance_receipt'} docType
 * @param {object} row      source row + .items[] (+ .payments/.hub_payments)
 * @param {object} company  company_settings row
 * @param {object} cfg      resolveDocumentConfig(raw, docType, viewerRole)
 */
function buildDocument(docType, row, company, cfg) {
  const adapter = ADAPTERS[docType];
  if (!adapter) throw new Error(`Unknown document type: ${docType}`);
  return adapter(row || {}, company || {}, cfg);
}

// hubLabel is exported for the public pay page, which has to name the same hub
// on the same job as the invoice PDF does. Without sharing this function the
// two drift — the invoice says "Spinoto Gota" while the pay page says the
// partner workshop's own trading name, and a customer about to hand over money
// sees two different businesses for one service.
//
// It also honours hub_name_mode: 'hidden', a deliberate setting that a screen
// naming the hub from its own query would silently bypass.
module.exports = { buildDocument, fromEstimate, fromCustomerInvoice, fromPurchaseInvoice, fromAdvanceReceipt, hubLabel };
