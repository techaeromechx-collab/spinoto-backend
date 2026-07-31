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

const { resolvePlaceOfSupply, isInterState, splitGst } = require('../utils/gstStates');
const { qrEnabled } = require('../utils/documentConfig');
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
    footerNote: cfg.global.footer_note || '',
    footerDisclaimer: cfg.global.footer_disclaimer || '',
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
  const cityLine = [row.pickup_city, row.pickup_pincode].filter(Boolean).join(', ');
  return [row.pickup_address_line1, row.pickup_address_line2, cityLine]
    .map(v => (v === null || v === undefined ? '' : String(v).trim()))
    .filter(Boolean);
}

/** B2B billing rows, shared by estimate + customer invoice. */
function b2bMeta(row) {
  if (!row.is_b2b) return [];
  const out = [];
  if (row.b2b_company_name) out.push({ key: 'b2b_company', label: 'Company Name', value: row.b2b_company_name });
  if (row.b2b_gst_number)   out.push({ key: 'b2b_gstin',   label: 'GSTIN',        value: row.b2b_gst_number });
  if (row.b2b_address)      out.push({ key: 'b2b_address', label: 'Address',      value: row.b2b_address });
  return out;
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
      name: row.customer_name || '',
      phone: row.mobile || '',
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
      name: row.customer_name || '',
      phone: row.mobile || '',
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
      { key: 'paid',    label: 'Paid',        value: paid,     kind: 'normal' },
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

  const pos = resolvePlaceOfSupply(row, company);
  const interState = isInterState(company, pos.code);
  const isHubView = cfg.viewerRole === 'hub';

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

  // Unlike the other two documents, the PI now gets a real bill-to party: the
  // hub. Previously the hub was a single row inside a generic info grid under
  // a full company letterhead, with no counterparty block at all.
  // PI_SELECT exposes only the raw hubs.hub_name, so there is no separate
  // legal/branch pair to choose between here.
  const hubName = hubLabel(cfg, { legalName: row.hub_full_name, branchName: row.hub_name });

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
    title: cfg.title,
    number: formatNumber(cfg, row.id),
    date: row.created_at,
    seller: sellerFrom(company, cfg),
    buyer: {
      name: hubName || '',
      phone: '',
      gstin: cfg.global.show_hub_gstin ? (row.hub_gst || '') : '',
      meta: [],
    },
    meta,
    items,
    totals: totalsFrom([
      { key: 'subtotal', label: isHubView ? 'Subtotal (ex-GST)' : 'Subtotal (hub ex-GST)', value: subtotal, kind: 'normal' },
      { key: 'gst',   label: 'Total GST', value: totalGst, kind: 'normal' },
      { key: 'grand', label: isHubView ? 'Grand Total Receivable' : 'Grand Total Payable to Hub', value: grand, kind: 'grand' },
      { key: 'paid',    label: isHubView ? 'Paid to You' : 'Paid to Hub', value: paid, kind: 'normal' },
      { key: 'balance', label: 'Balance Due', value: grand - paid, kind: 'strong' },
    ]),
    gstBreakup: gstBreakupFrom(items, interState),
    placeOfSupply: pos,
    payments: (row.hub_payments || []).map(p => ({
      date: p.paid_at, method: p.method, reference: p.reference_no, amount: num(p.amount), notes: p.notes,
    })),
    notes: row.notes || '',
    blocks: blocksFrom(cfg, company),
    // Consumed by buildColumns to decide whether the reference/margin columns
    // render. buildColumns ALSO re-checks viewerRole itself — belt and braces,
    // because a config edit must never be able to expose margin to a hub.
    rateMode: row.rate_mode || null,
    showMargin: cfg.margin_columns && cfg.viewerRole === 'admin',
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const ADAPTERS = {
  estimate: fromEstimate,
  customer_invoice: fromCustomerInvoice,
  purchase_invoice: fromPurchaseInvoice,
};

/**
 * @param {'estimate'|'customer_invoice'|'purchase_invoice'} docType
 * @param {object} row      source row + .items[] (+ .payments/.hub_payments)
 * @param {object} company  company_settings row
 * @param {object} cfg      resolveDocumentConfig(raw, docType, viewerRole)
 */
function buildDocument(docType, row, company, cfg) {
  const adapter = ADAPTERS[docType];
  if (!adapter) throw new Error(`Unknown document type: ${docType}`);
  return adapter(row || {}, company || {}, cfg);
}

module.exports = { buildDocument, fromEstimate, fromCustomerInvoice, fromPurchaseInvoice };
