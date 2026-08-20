/**
 * Phase 5 — the advance line on the customer invoice.
 *
 * ── The one bug this file exists to prevent ─────────────────────────────────
 * An advance that has been applied is ALREADY inside amount_paid and ALREADY
 * listed in the Payments block. Add an "Advance Applied" row on top of it and
 * the same money is counted twice:
 *
 *     Grand Total       ₹8,000
 *     Advance Applied   ₹2,000
 *     Paid              ₹8,000     ← still the full figure
 *     Balance Due           ₹0     ← does not follow from the rows above it
 *
 * The customer is holding that. So the Paid row is SPLIT, never added to, and
 * the guard is arithmetic: advance + payments === amount_paid, on every
 * document, in every theme. That assertion is the point of this file; the rest
 * is the wiring that has to be right for it to reach the page.
 *
 * ── And the failure that is silent ──────────────────────────────────────────
 * Seven themes loop the totals array and pick up a new row for free.
 * advanced_gst does not — it builds its own money block — so a new row is
 * invisible there and on advanced_gst_a5, which shares the file. Nothing
 * errors. Every theme is therefore RENDERED here and the output inspected,
 * rather than reasoned about.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const be = p => strip(fs.readFileSync(path.join(BE, p), 'utf8'));

const { buildDocument } = require(path.join(BE, 'src/templates/documentAdapter'));
const { resolveDocumentConfig } = require(path.join(BE, 'src/utils/documentConfig'));
const { THEMES } = require(path.join(BE, 'src/templates/invoiceThemes/registry'));

const COMPANY = { company_name: 'Spinoto', gstin: '24AABCS1429B1ZP', state: 'Gujarat' };
const CFG = resolveDocumentConfig({}, 'customer_invoice', 'admin');

const INVOICE = {
  id: 109, invoice_date: '2026-08-14', created_at: '2026-08-14', status: 'paid',
  customer_name: 'Raj Patel', mobile: '9876543210', vehicle_number: 'GJ01AS1222',
  subtotal_ex_gst: 6779.66, total_gst: 1220.34, grand_total: 8000,
  amount_paid: 8000, balance: 0,
  items: [{ id: 1, item_type: 'service', description: 'Full Service', hsn_sac: '998714',
            quantity: 1, customer_rate: 6779.66, total_inc_gst: 8000,
            gst_percent: 18, gst_amount: 1220.34 }],
  payments: [
    { paid_at: '2026-08-01', method: 'cash', reference_no: 'ADV-2026-27-000042', amount: 2000 },
    { paid_at: '2026-08-14', method: 'upi', reference_no: 'pay_QxA12', amount: 6000 },
  ],
};

const build = extra => buildDocument('customer_invoice', { ...INVOICE, ...extra }, COMPANY, CFG);
const row = (doc, key) => doc.totals.find(t => t.key === key);

// ── THE GUARD ───────────────────────────────────────────────────────────────
// Across every split that can occur, including the awkward ones.
for (const [label, extra] of [
  ['a part advance',          { advance_applied: 2000 }],
  ['the whole job in advance', { advance_applied: 8000 }],
  ['paise',                   { advance_applied: 1333.33 }],
  ['a partly-paid invoice',   { advance_applied: 1500, amount_paid: 4000, balance: 4000 }],
  ['one rupee',               { advance_applied: 1 }],
]) {
  const doc = build(extra);
  const adv = row(doc, 'advance');
  const paid = row(doc, 'paid');
  const total = (adv ? adv.value : 0) + paid.value;
  const expected = extra.amount_paid ?? INVOICE.amount_paid;
  assert.ok(Math.abs(total - expected) < 0.005,
    `DOUBLE COUNT with ${label}: advance ${adv && adv.value} + payments ${paid.value} != paid ${expected}`); n++;
}

// The cap. If the two figures ever disagreed — a bad backfill, a hand-edited
// row — the invoice must not print a negative "Payments Received".
for (const paidAmt of [8000, 4000, 0.5]) {
  const doc = build({ advance_applied: 99999, amount_paid: paidAmt, balance: 0 });
  assert.strictEqual(row(doc, 'advance').value, paidAmt,
    `an advance larger than the ${paidAmt} paid is printed as-is`); n++;
  assert.ok(row(doc, 'paid').value >= 0,
    `the payments row went negative with ${paidAmt} paid`); n++;
  assert.ok(Math.abs(row(doc, 'advance').value + row(doc, 'paid').value - paidAmt) < 0.005,
    `the capped split no longer adds up with ${paidAmt} paid`); n++;
}

// ── Nothing changes for an invoice with no advance ──────────────────────────
// The unchanged-output contract: every invoice printed before this existed must
// print identically after it.
{
  const doc = build({});
  assert.strictEqual(row(doc, 'advance'), undefined,
    'an invoice with no advance grew an advance row'); n++;
  assert.strictEqual(row(doc, 'paid').label, 'Paid',
    'the Paid row was relabelled on an invoice that has no advance'); n++;
  assert.strictEqual(row(doc, 'paid').value, 8000,
    'the Paid row no longer shows what was paid'); n++;

  const zero = build({ advance_applied: 0 });
  assert.strictEqual(row(zero, 'advance'), undefined,
    'a zero advance prints a row saying ₹0.00 was applied'); n++;
}

// ── The toggle ──────────────────────────────────────────────────────────────
{
  const off = resolveDocumentConfig(
    { documents: { customer_invoice: { flags: { show_advance_line: false } } } },
    'customer_invoice', 'admin');
  const doc = buildDocument('customer_invoice', { ...INVOICE, advance_applied: 2000 }, COMPANY, off);
  assert.strictEqual(row(doc, 'advance'), undefined, 'the toggle does not turn the row off'); n++;
  assert.strictEqual(row(doc, 'paid').value, 8000,
    'with the row off, Paid does not show the whole amount — money has gone missing from the page'); n++;
  assert.strictEqual(row(doc, 'paid').label, 'Paid',
    'with the row off, the Paid row is still relabelled'); n++;
}

// ── The sign ────────────────────────────────────────────────────────────────
// POSITIVE. docShared.buildTotals renders a negative as "- 1,234.00", but
// luxury.js moves the minus ahead of the ₹ and no other theme does — so one
// number would print two ways across the eight. The label carries the meaning.
{
  const doc = build({ advance_applied: 2000 });
  assert.ok(row(doc, 'advance').value > 0, 'the advance is passed as a negative'); n++;
  assert.ok(/Advance Applied/.test(row(doc, 'advance').label),
    'the label does not say what the number means'); n++;
}

// ── The voucher number is ON the line ───────────────────────────────────────
// Otherwise the receipt voucher and the invoice describe the same money with
// nothing linking them, and reconciling the two is a manual job.
{
  assert.strictEqual(
    build({ advance_applied: 2000, advance_vouchers: 'ADV-2026-27-000042' }).totals
      .find(t => t.key === 'advance').label,
    'Advance Applied (ADV-2026-27-000042)',
    'one advance does not name its receipt'); n++;
  assert.strictEqual(
    build({ advance_applied: 2000, advance_vouchers: 'ADV-1, ADV-2' }).totals
      .find(t => t.key === 'advance').label,
    'Advance Applied (ADV-1, ADV-2)',
    'two advances do not name both receipts'); n++;
  // Four numbers would wrap a one-line totals row into three.
  assert.strictEqual(
    build({ advance_applied: 2000, advance_vouchers: 'A, B, C, D' }).totals
      .find(t => t.key === 'advance').label,
    'Advance Applied (4 receipts)',
    'many advances print every number and wrap the row'); n++;
  // An older cached response has no voucher list. Unqualified beats wrong.
  assert.strictEqual(
    build({ advance_applied: 2000 }).totals.find(t => t.key === 'advance').label,
    'Advance Applied',
    'a missing voucher list produces a broken label rather than a plain one'); n++;
}

// ── EVERY THEME RENDERS IT ──────────────────────────────────────────────────
{
  const doc = build({ advance_applied: 2000, advance_vouchers: 'ADV-2026-27-000042' });
  const keys = Object.keys(THEMES);
  assert.strictEqual(keys.length, 8, `expected 8 themes, found ${keys.length}`); n++;

  for (const key of keys) {
    const theme = THEMES[key];
    const html = theme.render({ doc, cfg: CFG, pageSize: theme.fixedPageSize || 'A4' });

    // advanced_gst builds its own money block and would silently drop the row.
    assert.ok(/Advance Applied \(ADV-2026-27-000042\)/i.test(html),
      `${key}: the advance line does not reach the page`); n++;
    assert.ok(/2,000\.00/.test(html), `${key}: the advance amount does not reach the page`); n++;
    assert.ok(/6,000\.00/.test(html), `${key}: the remaining payments do not reach the page`); n++;

    // And the double count, as it would actually be read off the paper: the
    // full 8,000 must NOT appear as a "paid"/"received" figure beside the
    // advance — it is the grand total, and nothing else.
    assert.ok(!/RECEIVED AMOUNT<\/span><span>₹ 8,000\.00/.test(html),
      `${key}: the received-amount strip still shows the full total beside the advance`); n++;
  }

  // With no advance, no theme mentions one.
  const plain = build({});
  for (const key of keys) {
    const theme = THEMES[key];
    const html = theme.render({ doc: plain, cfg: CFG, pageSize: theme.fixedPageSize || 'A4' });
    assert.ok(!/Advance Applied/i.test(html),
      `${key}: an invoice with no advance still prints an advance line`); n++;
  }
}

// ── advanced_gst, specifically ──────────────────────────────────────────────
// It is the only theme that needed a hand edit, and the only one where the
// failure would have been silent.
{
  const src = be('src/templates/invoiceThemes/advanced_gst.js');
  assert.ok(/totals\.find\(t => t\.key === 'advance'\)/.test(src),
    'advanced_gst does not pick the advance out of the totals array'); n++;
  assert.ok(/recv-adv/.test(src),
    'advanced_gst has no strip to print the advance in'); n++;
  // The strip below it must be relabelled too, or the page reads
  // "ADVANCE APPLIED ₹2,000 / RECEIVED AMOUNT ₹6,000" — which says the ₹2,000
  // was not received.
  assert.ok(/advance \? paid\.label\.toUpperCase\(\) : 'RECEIVED AMOUNT'/.test(src),
    'advanced_gst still calls the remainder RECEIVED AMOUNT, which reads as excluding the advance'); n++;
}

// ── Both selects supply it ──────────────────────────────────────────────────
// The public one is the one that gets forgotten, and the failure is invisible:
// a missing column arrives as undefined, coerces to 0, and the copy the
// customer opens from WhatsApp tells a different story from the one printed at
// the counter.
for (const [file, who] of [
  ['src/controllers/customer_invoices.controller.js', 'the staff invoice'],
  ['src/controllers/public.documents.controller.js', "the customer's own copy"],
]) {
  const src = be(file);

  // The alias is matched with its terminator. `/AS advance_applied/` alone also
  // matches `AS advance_applied_unused`, so a column renamed out of existence
  // would pass — the adapter reads row.advance_applied and would silently get
  // undefined.
  assert.ok(/\) AS advance_applied,/.test(src),
    `${who} does not select advance_applied`); n++;
  assert.ok(/\) AS advance_vouchers,/.test(src),
    `${who} does not select the voucher numbers`); n++;

  // Each subquery is checked on its own. Both contain the same payment_type
  // filter, so testing the file as a whole would let either one lose it.
  const sums = src.slice(0, src.indexOf(') AS advance_applied,'));
  const sub = sums.slice(sums.lastIndexOf('(SELECT'));
  // From the ALLOCATIONS, not the payment total: a ₹2,000 advance split
  // ₹1,500 here contributed ₹1,500 to this invoice, not ₹2,000.
  assert.ok(/SUM\(a\.amount\)/.test(sub) && /FROM payment_allocations a/.test(sub),
    `${who} sums the payment rather than what was allocated to this invoice`); n++;
  assert.ok(/p\.payment_type = 'advance'/.test(sub),
    `${who} counts every payment on the invoice as an advance`); n++;

  const vouchers = src.slice(0, src.indexOf(') AS advance_vouchers,'));
  const vsub = vouchers.slice(vouchers.lastIndexOf('(SELECT'));
  assert.ok(/string_agg\(DISTINCT p\.voucher_no/.test(vsub),
    `${who} does not list the receipt numbers behind the figure`); n++;
  assert.ok(/p\.payment_type = 'advance'/.test(vsub),
    `${who} lists voucher numbers from payments that are not advances`); n++;
}

// ── The toggle is wired end to end ──────────────────────────────────────────
{
  const cfgSrc = be('src/utils/documentConfig.js');
  assert.ok(/show_advance_line: true/.test(cfgSrc), 'the flag has no default'); n++;
  // .partial() drops unknown keys silently — omit this and the toggle looks
  // like it works and never saves.
  assert.ok(/show_advance_line:\s+z\.boolean\(\)/.test(cfgSrc),
    'the flag is not in the schema, so switching it off would never persist'); n++;

  const ui = strip(fs.readFileSync(path.join(FE, 'components/settings/InvoiceThemeSettings.jsx'), 'utf8'));
  assert.ok(/key: 'show_advance_line'/.test(ui), 'the toggle is not exposed in settings'); n++;
  assert.ok(/show_advance_line'[\s\S]{0,120}docs: \['customer_invoice'\]/.test(ui),
    'the toggle is offered on documents that cannot consume an advance'); n++;

  // Without a sample advance the theme picker shows the toggle doing nothing
  // while somebody is deciding whether to turn it on.
  const settings = be('src/controllers/settings.controller.js');
  assert.ok(/advance_applied: 400/.test(settings),
    'the theme preview has no advance, so the toggle appears to do nothing'); n++;
  assert.ok(/advance_vouchers: 'ADV-/.test(settings),
    'the theme preview shows an advance with no receipt number'); n++;
  // The sample must itself be a SPLIT, not an addition — the preview is the
  // first place anyone would see a double count.
  assert.ok(/amount_paid: 1000[\s\S]{0,200}advance_applied: 400/.test(settings),
    'the sample advance is not part of the sample amount_paid'); n++;
}

console.log(`advance line on the invoice (phase 5): ${n} checks passed`);
