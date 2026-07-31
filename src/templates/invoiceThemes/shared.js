/**
 * shared.js — helpers used by every invoice theme template.
 *
 * A theme template is a plain function `render({ invoice, company })` that
 * returns a fully self-contained HTML string (inline <style>, no external
 * requests) — see ./registry.js for the theme list and pdf.js for how the
 * HTML is turned into a PDF buffer.
 *
 * `invoice` is exactly the shape returned by
 * customer_invoices.controller.js's getCustomerInvoicePdf (CI_SELECT row +
 * .items[] + .payments[]).
 * `company` is exactly the shape returned by GET /api/settings/company.
 */

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(v) {
  const n = Number(v || 0);
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A plain 'YYYY-MM-DD' — which is what invoice_date is (migration 099 selects
// it ::text so pg-types can't turn it into a local-midnight Date) — is read by
// `new Date()` as UTC midnight. Rendered in any timezone behind UTC that prints
// the PREVIOUS day. On a tax invoice that is a compliance defect, so build
// date-only values from their parts as a local date instead.
function toLocalDate(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.slice(0, 10)) && d.length <= 10) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day);
  }
  return new Date(d);
}

function formatDate(d, opts = {}) {
  if (!d) return '';
  const dt = toLocalDate(d);
  if (isNaN(dt)) return '';
  const date = dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // withTime is driven by invoice_config.flags.show_time. Kept as an option on
  // the existing helper rather than a second function so every theme picks it
  // up by passing the flag through, with no change when it's off.
  if (!opts.withTime) return date;
  const time = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

// Short date for batch/expiry/manufacture columns — no time, ever.
function formatShortDate(d) {
  if (!d) return '';
  const dt = toLocalDate(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

/**
 * Reduces invoice.items[] into the numbers every theme needs to print:
 * per-item amounts already come inc-GST from the DB (total_inc_gst), so this
 * just sums what's already computed rather than recomputing GST/discount
 * math — the source of truth for those calculations is the controller that
 * created the invoice, not the print template.
 */
function summarize(invoice) {
  const items = invoice.items || [];
  const totalQty = items.reduce((s, it) => s + Number(it.quantity || 0), 0);
  const totalDiscount = items.reduce((s, it) => s + Number(it.discount_amount || 0), 0);
  const totalGst = Number(invoice.total_gst || 0);
  const subtotalExGst = Number(invoice.subtotal_ex_gst || 0);
  const grandTotal = Number(invoice.grand_total || 0);
  const amountPaid = Number(invoice.amount_paid || 0);
  const balance = Number(invoice.balance ?? (grandTotal - amountPaid));

  // Split GST into CGST/SGST (intra-state) vs IGST (inter-state) purely for
  // display — same-state assumption mirrors how the on-screen print view
  // in CustomerInvoicesPage.jsx already labels it via hub state vs
  // customer's place of supply; kept simple here as a single IGST-style
  // line plus per-rate breakdown, since the underlying schema doesn't
  // separately store a CGST/SGST split column.
  const gstByRate = {};
  for (const it of items) {
    const rate = Number(it.gst_percent || 0);
    gstByRate[rate] = (gstByRate[rate] || 0) + Number(it.gst_amount || 0);
  }

  return { totalQty, totalDiscount, totalGst, subtotalExGst, grandTotal, amountPaid, balance, gstByRate };
}

function vehicleLine(invoice) {
  const parts = [invoice.make_name, invoice.model_name].filter(Boolean);
  return parts.join(' ');
}

// ═════════════════════════════════════════════════════════════════════════════
// Config-driven builders
//
// These exist so the ~20 toggles in company_settings.invoice_config are
// interpreted in exactly ONE place. Themes call these to learn WHAT to print;
// they retain full control of HOW it looks (markup, classes, styling). Without
// this, every toggle would need hand-threading through 7 template files —
// 7x the code and 7x the places to get it wrong.
//
// Every builder takes an already-resolved config (utils/invoiceConfig.js's
// resolveInvoiceConfig), so no null-checking of individual flags is needed.
// ═════════════════════════════════════════════════════════════════════════════

// Fallback for any caller that hasn't resolved a config — makes these builders
// safe to call with `undefined` and reproduce pre-config behaviour exactly.
const FALLBACK_CONFIG = {
  flags: {
    show_party_balance: false, free_item_qty: false, show_item_description: false,
    show_phone: true, show_time: false, price_history: false, auto_share_theme: null,
  },
  header_fields: { po_number: false, eway_bill: false, vehicle_number: true },
  item_columns:  { price: true, qty: true, batch_no: false, exp_date: false, mfg_date: false },
  custom_fields: [], custom_columns: [],
};

function cfg(config) {
  if (!config) return FALLBACK_CONFIG;
  return {
    flags:          { ...FALLBACK_CONFIG.flags,         ...(config.flags || {}) },
    header_fields:  { ...FALLBACK_CONFIG.header_fields, ...(config.header_fields || {}) },
    item_columns:   { ...FALLBACK_CONFIG.item_columns,  ...(config.item_columns || {}) },
    custom_fields:  Array.isArray(config.custom_fields)  ? config.custom_fields  : [],
    custom_columns: Array.isArray(config.custom_columns) ? config.custom_columns : [],
  };
}

/**
 * Optional invoice-header rows, in canonical order, already escaped.
 *
 * Returns [{ key, label, value }]. Only rows that are BOTH enabled in config
 * AND have a non-empty value are included — an enabled-but-empty field would
 * otherwise print a stray "PO Number :" with nothing after it on invoices
 * created before the field was turned on.
 *
 * Invoice No. and Date are NOT included: they're mandatory on a tax invoice
 * and every theme positions them distinctively, so they stay hard-coded.
 */
function buildHeaderFields(invoice, config) {
  const c = cfg(config);
  const out = [];
  const add = (key, label, value) => {
    const v = (value === null || value === undefined) ? '' : String(value).trim();
    if (v) out.push({ key, label, value: esc(v) });
  };

  if (c.header_fields.vehicle_number) {
    const veh = [invoice.vehicle_number, vehicleLine(invoice)].filter(Boolean).join(' · ');
    add('vehicle_number', 'Vehicle', veh);
  }
  if (c.header_fields.po_number) add('po_number', 'PO Number',      invoice.po_number);
  if (c.header_fields.eway_bill) add('eway_bill', 'E-way Bill No.', invoice.eway_bill_number);

  // User-defined fields last, in the order the user arranged them. Labels are
  // user-authored text going straight into HTML, so they're escaped too.
  const values = invoice.custom_fields || {};
  for (const def of c.custom_fields) {
    if (def && def.enabled !== false) add(`custom:${def.id}`, esc(def.label), values[def.id]);
  }
  return out;
}

/**
 * Item-table column descriptors, in canonical order.
 *
 * Returns [{ key, label, align, get(item, index) }] where align is 'l'|'c'|'r'
 * and get() returns an ALREADY-ESCAPED HTML fragment. Each theme maps `align`
 * to its own CSS classes and renders its own <th>/<td> markup — this only
 * decides which columns exist and what goes in each cell.
 *
 * Non-toggleable columns (#, item name, HSN/SAC, discount, GST, amount) are
 * always present: they're either structural or legally required on a GST tax
 * invoice, so exposing them as toggles would let a user produce an invalid
 * invoice.
 */
function buildColumns(config) {
  const c = cfg(config);
  const cols = [];

  cols.push({ key: 'sr', label: '#', align: 'c', get: (_it, i) => String(i + 1) });

  cols.push({
    key: 'item', label: 'Item', align: 'l',
    get: (it) => {
      let html = `<span class="ln-name">${esc(it.description)}</span>`;
      // Second detail line, only when enabled and actually populated.
      if (c.flags.show_item_description && it.item_description) {
        html += `<div class="ln-desc">${esc(it.item_description)}</div>`;
      }
      // Prior prices this customer paid for this item. Attached to the item by
      // the controller (attachPriceHistory) — templates stay synchronous, so
      // if it isn't there the row simply omits it.
      if (c.flags.price_history && Array.isArray(it.price_history) && it.price_history.length) {
        const hist = it.price_history
          .map(h => `${formatShortDate(h.date)}: ₹${money(h.rate)}`)
          .join(' · ');
        html += `<div class="ln-hist">Previously — ${esc(hist)}</div>`;
      }
      return html;
    },
  });

  cols.push({ key: 'hsn', label: 'HSN/SAC', align: 'c', get: (it) => esc(it.hsn_sac || '') });

  if (c.item_columns.batch_no) cols.push({ key: 'batch_no', label: 'Batch No.', align: 'c', get: (it) => esc(it.batch_no || '-') });
  if (c.item_columns.mfg_date) cols.push({ key: 'mfg_date', label: 'Mfg Date',  align: 'c', get: (it) => esc(formatShortDate(it.mfg_date) || '-') });
  if (c.item_columns.exp_date) cols.push({ key: 'exp_date', label: 'Exp. Date', align: 'c', get: (it) => esc(formatShortDate(it.exp_date) || '-') });

  for (const def of c.custom_columns) {
    if (!def || def.enabled === false) continue;
    cols.push({
      key: `custom:${def.id}`, label: esc(def.label), align: 'l',
      get: (it) => esc((it.custom_values || {})[def.id] || '-'),
    });
  }

  if (c.item_columns.qty) {
    cols.push({ key: 'qty', label: 'Qty', align: 'r', get: (it) => String(Number(it.quantity || 0)) });
  }
  if (c.item_columns.price) {
    // A free line shows FREE in place of the rate rather than ₹0.00 — the
    // stored amounts are untouched, this is display only (see isFreeLine).
    cols.push({
      key: 'rate', label: 'Rate', align: 'r',
      get: (it) => (isFreeLine(it, config) ? '<span class="ln-free">FREE</span>' : money(it.customer_rate)),
    });
  }

  cols.push({ key: 'disc', label: 'Disc.', align: 'r', get: (it) => (it.discount_amount ? money(it.discount_amount) : '-') });
  cols.push({
    key: 'gst', label: 'GST', align: 'r',
    get: (it) => `${money(it.gst_amount)}<span class="ln-sub"> (${Number(it.gst_percent || 0)}%)</span>`,
  });
  cols.push({
    key: 'amount', label: 'Amount', align: 'r', bold: true,
    get: (it) => (isFreeLine(it, config) ? '<span class="ln-free">FREE</span>' : money(it.total_inc_gst)),
  });

  return cols;
}

/**
 * Whether a line should print as "FREE".
 *
 * Display-only, deliberately. The stored totals (subtotal_ex_gst / total_gst /
 * grand_total) are computed by the controller when the invoice is generated
 * and are the single source of truth — recomputing them here would let the
 * printed invoice disagree with the invoice record and with what the customer
 * was charged. A genuinely free line is already ₹0 in those totals; this flag
 * only changes "₹0.00" into "FREE".
 */
function isFreeLine(item, config) {
  return !!(cfg(config).flags.free_item_qty && item && item.is_free);
}

/**
 * Totals rows, in print order: [{ key, label, value, kind }].
 * kind: 'normal' | 'grand' | 'strong' — themes style each differently.
 *
 * Optional rows (discount, party balance) are omitted rather than shown as
 * zero, matching what the templates did before this existed.
 */
function buildTotals(invoice, config) {
  const c = cfg(config);
  const s = summarize(invoice);
  const rows = [];
  rows.push({ key: 'subtotal', label: 'Subtotal', value: money(s.subtotalExGst), kind: 'normal' });
  if (s.totalDiscount) rows.push({ key: 'discount', label: 'Discount', value: `- ${money(s.totalDiscount)}`, kind: 'normal' });
  rows.push({ key: 'gst',     label: 'Total GST',   value: money(s.totalGst),    kind: 'normal' });
  rows.push({ key: 'grand',   label: 'Grand Total', value: money(s.grandTotal),  kind: 'grand'  });
  rows.push({ key: 'paid',    label: 'Received',    value: money(s.amountPaid),  kind: 'normal' });
  rows.push({ key: 'balance', label: 'Balance Due', value: money(s.balance),     kind: 'strong' });

  // Total outstanding across ALL of this customer's invoices — distinct from
  // this invoice's own balance above. Supplied by the controller
  // (attachPartyBalance); omitted when unavailable so the row never prints a
  // misleading zero.
  if (c.flags.show_party_balance && invoice.party_balance !== null && invoice.party_balance !== undefined) {
    rows.push({ key: 'party_balance', label: 'Total Outstanding', value: money(invoice.party_balance), kind: 'strong' });
  }
  return rows;
}

/** Company contact line for the header, honouring the show_phone flag. */
function companyContact(company, config) {
  const c = cfg(config);
  const bits = [];
  if (c.flags.show_phone && company?.phone) bits.push(`Ph: ${esc(company.phone)}`);
  if (company?.email) bits.push(esc(company.email));
  return bits.join(' · ');
}

/** Shared CSS for the class names buildColumns() emits, so every theme
 *  renders the optional bits consistently without duplicating rules. */
const SHARED_LINE_CSS = `
  .ln-name { font-weight: 600; }
  .ln-desc { font-size: 9px; color: #666; margin-top: 2px; line-height: 1.4; }
  .ln-hist { font-size: 8.5px; color: #999; margin-top: 2px; font-style: italic; }
  .ln-sub  { font-size: 9px; color: #888; }
  .ln-free { font-weight: 700; letter-spacing: .5px; }
`;

module.exports = {
  esc, money, formatDate, formatShortDate, summarize, vehicleLine,
  buildHeaderFields, buildColumns, buildTotals, isFreeLine, companyContact,
  SHARED_LINE_CSS,
};
