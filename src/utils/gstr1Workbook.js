/**
 * The whole GSTR-1 return as one workbook.
 *
 * ── WHY A WORKBOOK AND NOT EIGHT CSVs ──────────────────────────────────────
 *
 * The CSVs exist to be uploaded; this exists to be READ. Eight files in a
 * downloads folder cannot be checked against each other without opening eight
 * windows, and the question people actually have — "does this add up, and is
 * anything going to file wrong" — is answered by looking at the tables side by
 * side. So: one file, one sheet per table, and a Dashboard in front of them
 * that states the totals and whether the return reconciles.
 *
 * ── WHY exceljs AND NOT THE xlsx ALREADY INSTALLED ─────────────────────────
 *
 * SheetJS's community build writes values, merges and column widths but not
 * cell styles — bold, colour, borders and fills are a paid feature. The header
 * block on the Dashboard is a bordered box with a red report name, matched to
 * the layout the accountant already reads in TallyPrime, so styles are the
 * point rather than decoration.
 *
 * ── THESE SHEETS ARE NOT THE UPLOAD FORMAT ─────────────────────────────────
 *
 * They carry the widened columns the screen shows — Month, and the CGST / SGST
 * / IGST split — which the government's offline utility does not accept. The
 * per-table CSVs on the page remain the thing you upload. This is the thing
 * you check before you do.
 */

/* Required lazily, inside the builder, NOT at module load.
   A top-level require of a package that has not been installed yet throws
   while the app is starting, which takes down every route in reports.routes —
   the whole GST page, the dashboard, everything — over one download button.
   Loaded on first use instead, so a missing package is one endpoint returning
   a sentence a person can act on. */
let ExcelJS = null;
function excel() {
  if (ExcelJS) return ExcelJS;
  try { ExcelJS = require('exceljs'); }
  catch {
    const e = new Error('The Excel workbook needs the "exceljs" package. '
      + 'Run: npm install exceljs@^4.4.0 in the backend folder, then restart.');
    e.status = 503;
    throw e;
  }
  return ExcelJS;
}

/* Indian digit grouping: 12,34,567.89 rather than 1,234,567.89. Written as a
   number format rather than a pre-formatted string so the cells stay numeric
   and can still be summed by whoever opens the file. */
const MONEY = '#,##,##0.00';
const QTY   = '#,##0.###';

const INK    = 'FF1A2433';
const MUTED  = 'FF64748B';
const BRAND  = 'FF16B994';
const RED    = 'FFC00000';
const SOFT   = 'FFF1F5F9';
const LINE   = 'FFBFC9D4';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
/* Belt and braces. The controller now sends every date as 'YYYY-MM-DD', but a
   Date object still reads correctly here rather than silently producing a
   blank cell — which is exactly how the Month and Invoice date columns came
   out empty the first time. String(aDate) is
   "Thu Jul 09 2026 00:00:00 GMT+0530", which the pattern below never matched. */
const parts = v => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const pad = n => String(n).padStart(2, '0');
    return { y: String(v.getFullYear()), m: pad(v.getMonth() + 1), d: pad(v.getDate()) };
  }
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: m[1], m: m[2], d: m[3] } : null;
};
const dmy = v => { const p = parts(v); return p ? `${p.d}-${p.m}-${p.y}` : ''; };
/* Read off the string, never through `new Date('YYYY-MM-DD')` — that parses as
   UTC, so an invoice dated the 1st reads as the previous month in India. */
const monthName = v => { const p = parts(v); return p ? (MONTHS[Number(p.m) - 1] || '') : ''; };
const periodMonths = pd => {
  const a = monthName(pd.from), b = monthName(pd.to);
  return a === b ? a : `${a}–${b}`;
};
const num = v => Number(v || 0);
/* Sums of paisa-level figures drift — 360209.27999999997 — and although the
   number format hides it, the formula bar does not, and neither does anyone
   who copies the cell somewhere else. Every computed figure is rounded; the
   ones that come straight from the API are already rounded there. */
const r2 = v => Math.round(num(v) * 100) / 100;

const thin = { style: 'thin', color: { argb: LINE } };
const box  = { top: thin, left: thin, bottom: thin, right: thin };

// ───────────────────────────────────────────────────────────────────────────
// Dashboard
// ───────────────────────────────────────────────────────────────────────────
function dashboard(wb, d) {
  const ws = wb.addWorksheet('Dashboard', {
    views: [{ showGridLines: false }],
    /* It gets printed and handed to whoever files the return, so it is set up
       to come out on one page wide rather than sliced down the middle. */
    pageSetup: {
      paperSize: 9, orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  ws.columns = [
    { width: 3 }, { width: 26 }, { width: 20 }, { width: 18 },
    { width: 18 }, { width: 18 }, { width: 16 }, { width: 14 },
  ];

  /* ── The identity block ────────────────────────────────────────────────
     Deliberately the same shape as the one at the top of every TallyPrime
     GST report — label in its own bordered cell, value merged across the
     three beside it, report name in red. Somebody who reads both files every
     month should not have to work out which is which. */
  const ident = [
    ['Trade Name::', d.company.name || '—'],
    ['GSTIN::',      d.company.gstin || '—'],
    ['Period::',     d.period.label],
    ['Report Name',  'GSTR-1 SUMMARY', true],
  ];
  let r = 2;
  for (const [label, value, isName] of ident) {
    ws.mergeCells(r, 3, r, 5);
    const l = ws.getCell(r, 2), v = ws.getCell(r, 3);
    l.value = label; v.value = value;
    l.font = { bold: true, size: 11, color: { argb: INK } };
    v.font = isName
      ? { bold: true, size: 11, color: { argb: RED } }
      : { size: 11, color: { argb: INK } };
    l.alignment = { vertical: 'middle' };
    v.alignment = { vertical: 'middle', horizontal: isName ? 'left' : 'center' };
    for (let c = 2; c <= 5; c++) ws.getCell(r, c).border = box;
    ws.getRow(r).height = 20;
    r++;
  }
  r++;

  const band = (title) => {
    ws.mergeCells(r, 2, r, 8);
    const c = ws.getCell(r, 2);
    c.value = title;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    c.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(r).height = 18;
    r += 1;
  };
  const pair = (label, value, fmt) => {
    const l = ws.getCell(r, 2), v = ws.getCell(r, 3);
    l.value = label; l.font = { size: 10, color: { argb: MUTED } };
    v.value = value;
    v.font = { bold: true, size: 10, color: { argb: INK } };
    if (fmt) v.numFmt = fmt;
    r++;
  };
  const table = (head, rows, fmts) => {
    head.forEach((h, i) => {
      const c = ws.getCell(r, 2 + i);
      c.value = h;
      c.font = { bold: true, size: 9, color: { argb: MUTED } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SOFT } };
      c.border = { bottom: thin };
      c.alignment = { horizontal: i ? 'right' : 'left' };
    });
    r++;
    for (const row of rows) {
      row.forEach((val, i) => {
        const c = ws.getCell(r, 2 + i);
        c.value = val;
        c.font = { size: 10, color: { argb: INK } };
        if (i && fmts?.[i]) c.numFmt = fmts[i];
        c.alignment = { horizontal: i ? 'right' : 'left' };
      });
      r++;
    }
    r++;
  };

  const t = d.totals;
  band('HEADLINE');
  pair('Invoices in the period', t.invoices);
  pair('Invoice value',          num(t.invoice_value), MONEY);
  pair('Taxable value',          num(t.taxable),       MONEY);
  pair('Nil rated / non-GST',    num(t.nil_rated),     MONEY);
  pair('CGST',                   num(t.cgst),          MONEY);
  pair('SGST',                   num(t.sgst),          MONEY);
  pair('IGST',                   num(t.igst),          MONEY);
  pair('Total tax',              num(t.total_tax),     MONEY);
  r++;

  /* Every table's taxable value, so the reader can see them add to the
     headline rather than being told they do. */
  const sum = (rows, f = x => num(x.taxable)) => r2(rows.reduce((s, x) => s + f(x), 0));
  const tax = rows => r2(rows.reduce((s, x) => s + num(x.cgst) + num(x.sgst) + num(x.igst), 0));
  band('BY TABLE');
  table(['Table', 'Rows', 'Taxable value', 'Tax'], [
    ['4A  B2B',                     d.b2b.length,       sum(d.b2b),       tax(d.b2b)],
    ['5   B2C Large',               (d.b2cl || []).length, sum(d.b2cl || []), tax(d.b2cl || [])],
    ['7   B2C Small',               d.b2cs.length,      sum(d.b2cs),      tax(d.b2cs)],
    ['8   Nil / exempt / non-GST',  (d.nil_rated || []).length,
      sum(d.nil_rated || [], x => num(x.amount)), 0],
    ['9B  Credit notes',            (d.cdnr || []).length,
      -sum(d.cdnr || []), -tax(d.cdnr || [])],
  ], [null, '#,##0', MONEY, MONEY]);

  /* Taken from the HSN summary, which is the one place every supplied line
     lands exactly once — including nil-rated lines, which never reach Table
     4A. So B2B here sits a little above 4A above, and the note says why
     rather than leaving somebody to find the gap and distrust the sheet. */
  band('WHO WE SOLD TO');
  table(['', 'Invoices', 'Supply value'], [
    ['B2B — registered buyers', t.b2b_invoices, sum(d.hsn.filter(h => h.scope === 'b2b'))],
    ['B2C — everyone else',     t.b2c_invoices, sum(d.hsn.filter(h => h.scope === 'b2c'))],
  ], [null, '#,##0', MONEY]);
  r--;
  const basis = ws.getCell(r, 2);
  ws.mergeCells(r, 2, r, 6);
  basis.value = 'From the HSN summary, so nil-rated lines are counted here but not in Table 4A.';
  basis.font = { italic: true, size: 9, color: { argb: MUTED } };
  r += 2;

  /* Rate-wise, from the HSN summary rather than from the rate tables: the HSN
     summary is the one place every supplied line lands exactly once. */
  const byRate = new Map();
  for (const h of d.hsn) {
    const k = num(h.rate);
    if (!byRate.has(k)) byRate.set(k, { taxable: 0, tax: 0 });
    const b = byRate.get(k);
    b.taxable += num(h.taxable);
    b.tax += num(h.cgst) + num(h.sgst) + num(h.igst);
  }
  for (const b of byRate.values()) { b.taxable = r2(b.taxable); b.tax = r2(b.tax); }
  band('BY RATE');
  table(['Rate', 'Taxable value', 'Tax'],
    [...byRate.entries()].sort((a, b) => b[0] - a[0])
      .map(([rate, b]) => [`${rate}%`, b.taxable, b.tax]),
    [null, MONEY, MONEY]);

  if (t.credit_notes) {
    band('CREDIT NOTES');
    pair('Notes netted off', t.credit_notes);
    pair('Value',            num(t.credit_note_value), MONEY);
    r++;
  }

  /* ── The line that matters ────────────────────────────────────────────
     Everything above can look right while an invoice has quietly been left
     out of the return. This compares the return against the invoice ledger
     it was built from and says so in a word. */
  const rec = d.reconciliation;
  band('DOES IT RECONCILE');
  table(['', 'Ledger', 'Return', 'Difference'], [
    ['Taxable value', num(rec.ledger_taxable), num(rec.return_taxable), num(rec.taxable_diff)],
    ['Tax',           num(rec.ledger_gst),     num(rec.return_tax),     num(rec.tax_diff)],
  ], [null, MONEY, MONEY, MONEY]);
  r--;
  const verdict = ws.getCell(r, 2);
  ws.mergeCells(r, 2, r, 5);
  verdict.value = rec.material
    ? 'CHECK — the return does not match the invoice ledger. Something has been left out.'
    : 'MATCHES — every invoice in the period is in the return.';
  verdict.font = { bold: true, size: 10, color: { argb: rec.material ? RED : 'FF15803D' } };
  r += 3;

  band('BEFORE YOU FILE');
  if (!d.warnings.length) {
    pair('', 'Nothing flagged.');
  } else {
    for (const w of d.warnings) {
      const l = ws.getCell(r, 2), v = ws.getCell(r, 3);
      ws.mergeCells(r, 3, r, 8);
      l.value = String(w.severity || '').toUpperCase();
      l.font = { bold: true, size: 9, color: { argb: w.severity === 'blocker' ? RED : 'FFB45309' } };
      l.alignment = { vertical: 'top' };
      v.value = w.message;
      v.font = { size: 10, color: { argb: INK } };
      v.alignment = { wrapText: true, vertical: 'top' };
      /* The merged width is about 100 characters. Excel does not grow a merged
         row to fit wrapped text — that is a known gap, not a setting — so the
         height is worked out here, generously, because a clipped warning is a
         warning nobody acts on. */
      ws.getRow(r).height = Math.max(30,
        Math.min(96, 15 * Math.ceil(String(w.message).length / 95)));
      r++;
    }
  }
  return ws;
}

// ───────────────────────────────────────────────────────────────────────────
// A data sheet
// ───────────────────────────────────────────────────────────────────────────
function sheet(wb, name, headers, rows, widths, fmts) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h, i) => ({ width: widths?.[i] || Math.max(11, h.length + 2) }));
  const head = ws.getRow(1);
  headers.forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    c.alignment = { vertical: 'middle', wrapText: true, horizontal: fmts?.[i] ? 'right' : 'left' };
    c.border = box;
  });
  head.height = 28;
  rows.forEach(row => {
    const rr = ws.addRow(row);
    row.forEach((_, i) => {
      const c = rr.getCell(i + 1);
      c.font = { size: 10, color: { argb: INK } };
      c.border = box;
      if (fmts?.[i]) { c.numFmt = fmts[i]; c.alignment = { horizontal: 'right' }; }
    });
  });
  /* An empty table still gets its sheet and its headers. A missing sheet
     reads as "the export broke"; an empty one reads as "nothing here". */
  if (!rows.length) {
    const rr = ws.addRow([`No rows in this table for ${name}.`]);
    rr.getCell(1).font = { italic: true, size: 10, color: { argb: MUTED } };
    ws.mergeCells(2, 1, 2, headers.length);
  }
  ws.autoFilter = rows.length
    ? { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }
    : undefined;
  return ws;
}

// ───────────────────────────────────────────────────────────────────────────
async function buildGstr1Workbook(d) {
  const wb = new (excel().Workbook)();
  wb.creator = 'Spinoto';
  wb.created = new Date();

  dashboard(wb, d);

  const pos = r => `${r.pos_code}-${r.pos_name}`;

  sheet(wb, 'b2b',
    ['Month', 'GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date',
      'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate',
      'Invoice Type', 'Rate', 'CGST', 'SGST', 'IGST', 'Taxable Value', 'Cess Amount'],
    d.b2b.map(r => [monthName(r.invoice_date), r.gstin, r.receiver_name, r.invoice_no,
      dmy(r.invoice_date), num(r.invoice_value), pos(r), r.reverse_charge, '',
      r.invoice_type, num(r.rate), num(r.cgst), num(r.sgst), num(r.igst), num(r.taxable),
      num(r.cess)]),
    [12, 20, 26, 14, 12, 14, 18, 9, 11, 14, 8, 12, 12, 12, 14, 11],
    [null, null, null, null, null, MONEY, null, null, null, null, '0.00',
      MONEY, MONEY, MONEY, MONEY, MONEY]);

  sheet(wb, 'b2cl',
    ['Month', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply',
      'Applicable % of Tax Rate', 'Rate', 'CGST', 'SGST', 'IGST', 'Taxable Value',
      'Cess Amount', 'E-Commerce GSTIN'],
    (d.b2cl || []).map(r => [monthName(r.invoice_date), r.invoice_no, dmy(r.invoice_date),
      num(r.invoice_value), pos(r), '', num(r.rate), num(r.cgst), num(r.sgst), num(r.igst),
      num(r.taxable), num(r.cess), '']),
    [12, 14, 12, 14, 18, 11, 8, 12, 12, 12, 14, 11, 18],
    [null, null, null, MONEY, null, null, '0.00', MONEY, MONEY, MONEY, MONEY, MONEY, null]);

  sheet(wb, 'b2cs',
    ['Month', 'Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate',
      'CGST', 'SGST', 'IGST', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    d.b2cs.map(r => [periodMonths(d.period), r.type, pos(r), '', num(r.rate),
      num(r.cgst), num(r.sgst), num(r.igst), num(r.taxable), num(r.cess), '']),
    [14, 8, 18, 11, 8, 12, 12, 12, 14, 11, 18],
    [null, null, null, null, '0.00', MONEY, MONEY, MONEY, MONEY, MONEY, null]);

  sheet(wb, 'cdnr',
    ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type',
      'Place Of Supply', 'Note Value', 'Rate', 'CGST', 'SGST', 'IGST', 'Taxable Value',
      'Cess Amount'],
    (d.cdnr || []).map(r => [r.gstin, r.receiver_name, r.note_no, dmy(r.note_date),
      r.note_type, pos(r), num(r.note_value), num(r.rate), num(r.cgst), num(r.sgst),
      num(r.igst), num(r.taxable), num(r.cess)]),
    [20, 26, 14, 12, 12, 18, 13, 8, 12, 12, 12, 14, 11],
    [null, null, null, null, null, null, MONEY, '0.00', MONEY, MONEY, MONEY, MONEY, MONEY]);

  /* Two sheets, named as the portal workbook names them. The split is made in
     the controller, on the invoice's own B2B flag. */
  const HSN_HEAD = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate',
    'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount',
    'Cess Amount'];
  const HSN_W = [12, 30, 14, 13, 14, 8, 14, 15, 15, 15, 11];
  const HSN_F = [null, null, null, QTY, MONEY, '0.00', MONEY, MONEY, MONEY, MONEY, MONEY];
  const hsnRow = r => [r.code, r.description, r.uqc, num(r.quantity),
    num(r.taxable) + num(r.cgst) + num(r.sgst) + num(r.igst), num(r.rate), num(r.taxable),
    num(r.igst), num(r.cgst), num(r.sgst), num(r.cess)];
  sheet(wb, 'hsn(b2b)', HSN_HEAD, d.hsn.filter(r => r.scope === 'b2b').map(hsnRow), HSN_W, HSN_F);
  sheet(wb, 'hsn(b2c)', HSN_HEAD, d.hsn.filter(r => r.scope === 'b2c').map(hsnRow), HSN_W, HSN_F);

  sheet(wb, 'exemp',
    ['Description', 'Nil Rated Supplies', 'Exempted', 'Non-GST supplies',
      'UNCLASSIFIED — choose a column before filing'],
    (d.nil_rated || []).map(r => [r.label, 0, 0, 0, num(r.amount)]),
    [40, 17, 15, 17, 38],
    [null, MONEY, MONEY, MONEY, MONEY]);

  sheet(wb, 'docs',
    ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    d.docs.map(r => [r.nature, r.from_no, r.to_no, r.total, r.cancelled]),
    [30, 16, 16, 14, 12],
    [null, null, null, '#,##0', '#,##0']);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildGstr1Workbook };
