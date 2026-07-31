'use strict';

/**
 * Document display configuration — the authoritative definition of the blob
 * stored in company_settings.document_config (migration 097).
 *
 * Supersedes utils/invoiceConfig.js, which handled customer invoices only.
 * The shape is now two-level:
 *
 *   global    — settings that must be consistent across every document
 *               (logo, page size, hub naming, footer). Splitting these per
 *               document would let the same company print three different
 *               letterheads, which is a support problem, not a feature.
 *   documents — per document type: theme, title, numbering, terms, signature,
 *               bank block, display flags, header fields, item columns.
 *
 * ── The unchanged-output contract ───────────────────────────────────────────
 * Every default below reproduces what that document prints TODAY, quirks
 * included (e.g. the customer invoice's title is currently the non-standard
 * "CUSTOMER INVOICE"; the estimate hides its Approved?/Work Status columns on
 * paper). An empty config must therefore be a visual no-op on all three
 * documents. The single deliberate exception is documented at DEFAULT_TITLES.
 */

const { z } = require('zod');

const DOC_TYPES = ['estimate', 'customer_invoice', 'purchase_invoice'];

const VALID_THEMES = [
  'spinoto', 'simple', 'modern', 'luxury', 'stylish',
  'advanced_gst', 'advanced_gst_tally', 'advanced_gst_a5',
];

const INDUSTRY_TYPES = ['automobile', 'retail', 'pharma', 'manufacturing', 'services', 'other'];

// How the hub/branch is named on paper. The old behaviour was hard-coded
// 'branch' — an est-no-print/est-print-show span pair that showed the legal
// name on screen but printed "Spinoto Gota". That's now a choice.
const HUB_NAME_MODES = ['legal', 'branch', 'hidden'];
const LOGO_SOURCES   = ['uploaded', 'static', 'none'];
const PAGE_SIZES     = ['A4', 'A5'];

// A GST tax invoice should say "TAX INVOICE". The code currently prints
// "CUSTOMER INVOICE" — this is the ONE default deliberately changed rather
// than preserved, because the existing string is a compliance weakness, not a
// styling preference. It remains overridable per company.
const DEFAULT_TITLES = {
  estimate:         'ESTIMATE',
  customer_invoice: 'TAX INVOICE',
  purchase_invoice: 'PURCHASE INVOICE',
};

// Shown to a hub user viewing their own copy of a purchase invoice — the
// document is a sale from their side. Mirrors the existing isHubUser swap.
const HUB_VIEW_TITLES = { purchase_invoice: 'SELL INVOICE' };

const DEFAULT_PREFIXES = {
  estimate: 'EST-', customer_invoice: 'CI-', purchase_invoice: 'PI-',
};
const HUB_VIEW_PREFIXES = { purchase_invoice: 'SI-' };

const DEFAULT_GLOBAL = {
  hub_name_mode: 'branch',        // matches today's printed output
  show_hub_gstin: false,          // hub_gst is fetched today but printed nowhere
  logo_source: 'static',          // today every page hard-codes /logo.svg
  page_size: 'A4',
  amount_in_words: true,
  footer_note: 'Thank you for your business.',
  footer_disclaimer: 'This is a computer generated document and does not require a physical signature.',
  footer_contact: true,           // company phone/email in the footer
  footer_contact_icons: false,    // the 📞 ✉ emoji — off by default, they
                                  // depend on the print device having the font
  // Scannable link to the customer's own copy. On by default: the old print
  // layout always carried a QR, so leaving it off would be a regression for
  // anyone used to it.
  //
  // This is the MASTER switch. Each document also has flags.show_qr, so the QR
  // can be turned off for, say, purchase invoices alone. A document prints the
  // QR only when both are on — see qrEnabled().
  show_qr: true,
};

// Per-document display settings. Anything absent here is inherited from
// DEFAULT_DOC_BASE below.
const DEFAULT_DOC_BASE = {
  // The in-house layout the app printed before server-rendered PDFs.
  theme: 'spinoto',
  title: null,          // null → DEFAULT_TITLES[docType]
  number_prefix: null,  // null → DEFAULT_PREFIXES[docType]
  number_pad: 6,

  // Each optional block is gated by its own toggle so the settings UI can
  // reveal the fields only once the block is switched on — and so an
  // accidentally-blank field can't leave an empty heading on the document.
  show_terms: false,
  terms: '',
  show_bank: false,
  // Structured rather than one free-text blob: these are labelled rows on the
  // printed document ("IFSC Code: ...", "Account No: ..."), so themes can lay
  // them out as a proper table instead of guessing at line breaks.
  bank_details: { account_name: '', bank_name: '', account_no: '', ifsc: '', branch: '' },
  show_signature: false,
  signature_label: 'Authorised Signatory',

  flags: {
    show_party_balance: false,
    free_item_qty: false,
    show_item_description: false,
    show_phone: true,
    show_time: false,
    price_history: false,
    auto_share_theme: null,
    show_status: true,        // all three print a Status row today
    // Warranty/guarantee coverage table. See DEFAULT_DOCUMENTS: off for a
    // purchase invoice, since that promise is to the customer, not the hub.
    show_warranty: true,
    // Per-document half of the QR switch. TRUE by default on all three so
    // turning the master on behaves exactly as it did when the QR was a single
    // global toggle — nobody has to go and re-enable three checkboxes.
    show_qr: true,
  },

  header_fields: {
    vehicle_number: true,
    po_number: false,
    eway_bill: false,
    place_of_supply: false,   // required on a GST invoice once IGST is in play
  },

  item_columns: {
    price: true,
    qty: true,
    hsn: true,
    // Both ON because the in-house layout this system replaced carried them,
    // and the defaults' job is to reproduce that output.
    taxable: true,      // the pre-GST value of the line
    tax_split: true,    // per-line CGST %/SGST % (or IGST %) instead of one GST column
    // Not a boolean: 'auto' hides the column when nothing on the document is
    // discounted, which is what the old layout did.
    discount: 'auto',   // 'auto' | 'always' | 'never'
    batch_no: false,
    exp_date: false,
    mfg_date: false,
  },

  custom_fields: [],
  custom_columns: [],
};

// Per-document deviations from the base.
const DEFAULT_DOCUMENTS = {
  estimate: {
    // An estimate is not a tax document and has no HSN column today.
    item_columns: { ...DEFAULT_DOC_BASE.item_columns, hsn: true },
    flags: { ...DEFAULT_DOC_BASE.flags },
  },
  customer_invoice: {
    header_fields: { ...DEFAULT_DOC_BASE.header_fields },
    flags: { ...DEFAULT_DOC_BASE.flags },
  },
  purchase_invoice: {
    // The PI's money column is the hub rate; customer rate + commission +
    // margin are reference columns for the admin's own copy. Defaulting these
    // ON preserves today's table. They are HARD-GATED to admin viewers in
    // buildColumns() regardless of this setting — a hub must never see the
    // margin taken on their work.
    item_columns: { ...DEFAULT_DOC_BASE.item_columns, hsn: false },
    margin_columns: true,
    flags: { ...DEFAULT_DOC_BASE.flags, show_warranty: false },
  },
};

const MAX_CUSTOM = 10;

// ─── Validation ───────────────────────────────────────────────────────────────

const customEntrySchema = z.object({
  id:      z.string().trim().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Invalid custom field id'),
  label:   z.string().trim().min(1).max(40),
  enabled: z.boolean().default(true),
});

const docSchema = z.object({
  theme: z.enum(VALID_THEMES),
  title: z.string().trim().max(60).nullable(),
  number_prefix: z.string().trim().max(10).nullable(),
  number_pad: z.number().int().min(0).max(10),
  show_terms: z.boolean(),
  terms: z.string().trim().max(2000),
  show_bank: z.boolean(),
  bank_details: z.object({
    account_name: z.string().trim().max(120),
    bank_name:    z.string().trim().max(120),
    account_no:   z.string().trim().max(40),
    ifsc:         z.string().trim().max(20),
    branch:       z.string().trim().max(120),
  }).partial(),
  show_signature: z.boolean(),
  signature_label: z.string().trim().max(60),
  margin_columns: z.boolean(),
  flags: z.object({
    show_party_balance:    z.boolean(),
    free_item_qty:         z.boolean(),
    show_item_description: z.boolean(),
    show_phone:            z.boolean(),
    show_time:             z.boolean(),
    price_history:         z.boolean(),
    show_status:           z.boolean(),
    show_warranty:         z.boolean(),
    show_qr:               z.boolean(),
    auto_share_theme:      z.enum(VALID_THEMES).nullable(),
  }).partial(),
  header_fields: z.object({
    vehicle_number:  z.boolean(),
    po_number:       z.boolean(),
    eway_bill:       z.boolean(),
    place_of_supply: z.boolean(),
  }).partial(),
  item_columns: z.object({
    price: z.boolean(), qty: z.boolean(), hsn: z.boolean(), taxable: z.boolean(), tax_split: z.boolean(),
    discount: z.enum(['auto', 'always', 'never']),
    batch_no: z.boolean(), exp_date: z.boolean(), mfg_date: z.boolean(),
  }).partial(),
  custom_fields:  z.array(customEntrySchema).max(MAX_CUSTOM),
  custom_columns: z.array(customEntrySchema).max(MAX_CUSTOM),
}).partial();

const documentConfigSchema = z.object({
  industry_type: z.enum(INDUSTRY_TYPES),
  global: z.object({
    hub_name_mode:  z.enum(HUB_NAME_MODES),
    show_hub_gstin: z.boolean(),
    logo_source:    z.enum(LOGO_SOURCES),
    page_size:      z.enum(PAGE_SIZES),
    amount_in_words: z.boolean(),
    footer_note:       z.string().trim().max(300),
    footer_disclaimer: z.string().trim().max(300),
    footer_contact:       z.boolean(),
    footer_contact_icons: z.boolean(),
    show_qr: z.boolean(),
  }).partial(),
  documents: z.object({
    estimate:         docSchema,
    customer_invoice: docSchema,
    purchase_invoice: docSchema,
  }).partial(),
}).partial().optional();

// ─── Resolution ───────────────────────────────────────────────────────────────

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeFlat(base, override) {
  return { ...base, ...(isPlainObject(override) ? override : {}) };
}

function cleanList(list, fallback) {
  const src = Array.isArray(list) ? list : fallback;
  return (src || [])
    .filter(e => isPlainObject(e) && typeof e.id === 'string' && typeof e.label === 'string')
    .slice(0, MAX_CUSTOM)
    .map(e => ({ id: e.id, label: e.label, enabled: e.enabled !== false }));
}

/**
 * Resolve the full config for ONE document type and ONE viewer role.
 *
 * Templates receive a single flat object — they never reach into `global` vs
 * `documents` themselves, so adding a setting in either place is invisible to
 * them.
 *
 * viewerRole ('admin' | 'hub') affects the title/prefix on a purchase invoice,
 * which reads as a sale from the hub's side.
 */
function resolveDocumentConfig(raw, docType = 'customer_invoice', viewerRole = 'admin') {
  const type = DOC_TYPES.includes(docType) ? docType : 'customer_invoice';
  const src = isPlainObject(raw) ? raw : {};

  const global = mergeFlat(DEFAULT_GLOBAL, src.global);

  const docDefaults = { ...DEFAULT_DOC_BASE, ...(DEFAULT_DOCUMENTS[type] || {}) };
  const docSrc = isPlainObject(src.documents) && isPlainObject(src.documents[type])
    ? src.documents[type]
    : {};

  const isHubView = viewerRole === 'hub';
  const title = docSrc.title || docDefaults.title ||
    (isHubView && HUB_VIEW_TITLES[type]) || DEFAULT_TITLES[type];
  const prefix = docSrc.number_prefix || docDefaults.number_prefix ||
    (isHubView && HUB_VIEW_PREFIXES[type]) || DEFAULT_PREFIXES[type];

  return {
    docType: type,
    viewerRole: isHubView ? 'hub' : 'admin',
    industry_type: INDUSTRY_TYPES.includes(src.industry_type) ? src.industry_type : 'automobile',

    global,

    theme: VALID_THEMES.includes(docSrc.theme) ? docSrc.theme : docDefaults.theme,
    title,
    number_prefix: prefix,
    number_pad: Number.isInteger(docSrc.number_pad) ? docSrc.number_pad : docDefaults.number_pad,

    show_terms: typeof docSrc.show_terms === 'boolean' ? docSrc.show_terms : docDefaults.show_terms,
    terms: typeof docSrc.terms === 'string' ? docSrc.terms : docDefaults.terms,
    show_bank: typeof docSrc.show_bank === 'boolean' ? docSrc.show_bank : docDefaults.show_bank,
    bank_details: mergeFlat(docDefaults.bank_details, docSrc.bank_details),
    show_signature: typeof docSrc.show_signature === 'boolean' ? docSrc.show_signature : docDefaults.show_signature,
    signature_label: docSrc.signature_label || docDefaults.signature_label,

    // Only meaningful on a purchase invoice; harmless elsewhere.
    margin_columns: typeof docSrc.margin_columns === 'boolean'
      ? docSrc.margin_columns
      : (docDefaults.margin_columns ?? false),

    flags:         mergeFlat(docDefaults.flags,         docSrc.flags),
    header_fields: mergeFlat(docDefaults.header_fields, docSrc.header_fields),
    item_columns:  mergeFlat(docDefaults.item_columns,  docSrc.item_columns),

    custom_fields:  cleanList(docSrc.custom_fields,  docDefaults.custom_fields),
    custom_columns: cleanList(docSrc.custom_columns, docDefaults.custom_columns),
  };
}

/**
 * Does THIS document print a QR?
 *
 * Two switches, ANDed: the global master and the document's own flag. Kept in
 * one function because the answer is needed in three unrelated places — the
 * QR generator, the preview endpoint, and the adapter that hands blocks to the
 * themes — and combining them by hand in each would eventually drift.
 *
 * `!== false` rather than `=== true`: configs saved before the per-document
 * flag existed have no `flags.show_qr`, and those must keep their QR.
 *
 * Takes a config already resolved by resolveDocumentConfig (flat: global +
 * flags for one document).
 */
function qrEnabled(cfg) {
  return !!(cfg && cfg.global && cfg.global.show_qr) && cfg.flags?.show_qr !== false;
}

/**
 * The full stored shape, defaults filled in for all three documents — used by
 * GET /api/settings/company so the settings UI can bind directly.
 */
function resolveFullConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const documents = {};
  for (const t of DOC_TYPES) {
    const r = resolveDocumentConfig(src, t, 'admin');
    documents[t] = {
      theme: r.theme, title: r.title, number_prefix: r.number_prefix, number_pad: r.number_pad,
      show_terms: r.show_terms, terms: r.terms,
      show_bank: r.show_bank, bank_details: r.bank_details,
      show_signature: r.show_signature, signature_label: r.signature_label,
      margin_columns: r.margin_columns,
      flags: r.flags, header_fields: r.header_fields, item_columns: r.item_columns,
      custom_fields: r.custom_fields, custom_columns: r.custom_columns,
    };
  }
  return {
    industry_type: INDUSTRY_TYPES.includes(src.industry_type) ? src.industry_type : 'automobile',
    global: mergeFlat(DEFAULT_GLOBAL, src.global),
    documents,
  };
}

module.exports = {
  DOC_TYPES, VALID_THEMES, INDUSTRY_TYPES,
  HUB_NAME_MODES, LOGO_SOURCES, PAGE_SIZES,
  DEFAULT_TITLES, DEFAULT_PREFIXES, DEFAULT_GLOBAL,
  documentConfigSchema, resolveDocumentConfig, resolveFullConfig, qrEnabled,
  MAX_CUSTOM,
};
