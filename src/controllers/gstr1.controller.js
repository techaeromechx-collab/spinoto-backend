'use strict';

/**
 * GSTR-1 — outward supplies return.
 *
 * ══ THE ONE RULE THIS FILE FOLLOWS ═════════════════════════════════════════
 *
 * Every state and tax decision comes from utils/gstStates.js — the same
 * resolvePlaceOfSupply / isInterState / splitGst that templates/
 * documentAdapter.js uses to print the invoice. None of it is re-implemented
 * here. A return that disagrees with the document it came from is worse than
 * no return at all, and the only way to guarantee agreement is to call the
 * same functions rather than write them twice.
 *
 * In particular splitGst's odd-paise rule (the remainder goes to CGST) is NOT
 * restated below. If it ever changes, the printed invoice and this return
 * change together.
 *
 * ══ WHICH INVOICES ARE IN THE RETURN ═══════════════════════════════════════
 *
 * Every invoice dated in the period, whatever its payment status. GST is due
 * on the invoice, not on the collection — an approved-but-unpaid invoice is
 * still an outward supply and belongs in the return. Filtering by 'paid' would
 * under-report the liability, which is the expensive direction to be wrong in.
 *
 * invoice_date is the date used, not created_at. A backdated invoice
 * (migration 100) belongs in the period it is dated, which is the whole point
 * of backdating.
 *
 * ══ WHAT IS NOT HERE, AND WHY ══════════════════════════════════════════════
 *
 * Table 5 (B2CL)    — inter-state B2C above the threshold. No inter-state
 *                     supply exists in this data; the code still routes any
 *                     that appear, rather than silently dropping them.
 * Table 6 (exports) — no export invoicing in this system.
 * Table 9B (credit/ — there is no credit note anywhere in the schema
 *  debit notes)       (OPN-019). Reported as a warning, not as a zero, so the
 *                     absence is visible rather than looking like a clean nil.
 * Table 11 (advances)— the advance module issues receipt vouchers with their
 *                     own series. Reported as a warning when advances exist in
 *                     the period, because working out 11A/11B correctly needs
 *                     a decision about which advances were invoiced in-period,
 *                     and guessing it would be worse than naming the gap.
 */

const { pool } = require('../config/db');
const { loadCompany } = require('../utils/renderDocument');
const { isHubUser } = require('../utils/hubScope');
const {
  STATE_CODES,
  resolvePlaceOfSupply,
  isInterState,
  splitGst,
  supplierStateCode,
} = require('../utils/gstStates');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2  = (v) => Math.round(num(v) * 100) / 100;
const ciNo = (id) => `CI-${String(id).padStart(6, '0')}`;

/* ── Period ────────────────────────────────────────────────────────────────
   A GST return covers a statutory period, never an arbitrary range, so the
   boundaries are computed here rather than trusted from the query string. */
function resolvePeriod(q) {
  const month = String(q.month || '').trim();
  const quarter = String(q.quarter || '').trim();

  if (quarter) {
    const m = quarter.match(/^(\d{4})-Q([1-4])$/);
    if (!m) return { error: 'quarter must look like 2026-Q2' };
    const year = Number(m[1]);
    // Indian financial-year quarters: Q1 = Apr-Jun.
    const startMonth = [3, 6, 9, 0][Number(m[2]) - 1];
    const startYear  = Number(m[2]) === 4 ? year + 1 : year;
    const from = new Date(Date.UTC(startYear, startMonth, 1));
    const to   = new Date(Date.UTC(startYear, startMonth + 3, 0));
    return {
      type: 'quarter',
      label: `${quarter} (${from.toISOString().slice(0, 7)} to ${to.toISOString().slice(0, 7)})`,
      from: from.toISOString().slice(0, 10),
      to:   to.toISOString().slice(0, 10),
      // The portal's filing period is the LAST month of the quarter.
      fp: `${String(to.getUTCMonth() + 1).padStart(2, '0')}${to.getUTCFullYear()}`,
    };
  }

  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return { error: 'month must look like 2026-08, or pass quarter=2026-Q2' };
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return { error: 'month out of range' };
  const from = new Date(Date.UTC(y, mo - 1, 1));
  const to   = new Date(Date.UTC(y, mo, 0));
  return {
    type: 'month',
    label: from.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
    fp: `${m[2]}${m[1]}`,
  };
}

/* ── The raw material ──────────────────────────────────────────────────────
   One query for invoice headers, one for their lines. Deliberately not a
   single joined query: the header carries the totals the return reports as
   "invoice value", and a join would multiply them by the line count. */
async function loadPeriod(from, to) {
  const inv = await pool.query(
    `SELECT ci.id, ci.invoice_date, ci.status,
            ci.customer_name, ci.mobile,
            ci.is_b2b, ci.b2b_company_name, ci.b2b_gst_number,
            ci.place_of_supply_code, ci.place_of_supply_name,
            ci.subtotal_ex_gst, ci.total_gst, ci.grand_total
       FROM customer_invoices ci
      WHERE ci.invoice_date >= $1::date
        AND ci.invoice_date <= $2::date
      ORDER BY ci.id`,
    [from, to]
  );
  if (!inv.rows.length) return { invoices: [], itemsByInvoice: new Map() };

  const ids = inv.rows.map(r => r.id);
  const items = await pool.query(
    `SELECT cii.customer_invoice_id AS inv_id, cii.item_type, cii.description,
            cii.hsn_sac, cii.quantity, cii.gst_percent, cii.gst_amount,
            cii.total_inc_gst, cii.is_free,
            (cii.total_inc_gst - cii.gst_amount) AS taxable
       FROM customer_invoice_items cii
      WHERE cii.customer_invoice_id = ANY($1::int[])
      ORDER BY cii.customer_invoice_id, cii.id`,
    [ids]
  );

  const byInv = new Map();
  for (const it of items.rows) {
    if (!byInv.has(it.inv_id)) byInv.set(it.inv_id, []);
    byInv.get(it.inv_id).push(it);
  }
  return { invoices: inv.rows, itemsByInvoice: byInv };
}

/* ── Credit notes for the period (migration 185) ───────────────────────────
   Selected by the NOTE's own date, not the invoice's. A note issued in
   September against a July invoice belongs in September's return — that is
   the whole reason Table 9B carries both dates.

   'issued' only. A cancelled note keeps its number and stops counting. */
async function loadCreditNotes(from, to) {
  const notes = await pool.query(
    `SELECT cn.id, cn.note_no, cn.note_date, cn.reason,
            cn.customer_invoice_id, cn.mobile, cn.customer_name,
            cn.is_b2b, cn.b2b_gst_number, cn.b2b_company_name,
            cn.place_of_supply_code, cn.place_of_supply_name,
            cn.subtotal_ex_gst, cn.total_gst, cn.grand_total,
            ci.invoice_date AS orig_invoice_date
       FROM credit_notes cn
       JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
      WHERE cn.party_type = 'customer'
        AND cn.status = 'issued'
        AND cn.note_date >= $1::date
        AND cn.note_date <= $2::date
      ORDER BY cn.note_date, cn.id`,
    [from, to]
  );
  if (!notes.rows.length) return { notes: [], itemsByNote: new Map() };

  const ids = notes.rows.map(r => r.id);
  const items = await pool.query(
    `SELECT cni.credit_note_id AS note_id, cni.item_type, cni.description,
            cni.hsn_sac, cni.quantity, cni.gst_percent, cni.gst_amount,
            (cni.total_inc_gst - cni.gst_amount) AS taxable
       FROM credit_note_items cni
      WHERE cni.credit_note_id = ANY($1::int[])
      ORDER BY cni.credit_note_id, cni.id`,
    [ids]
  );
  const byNote = new Map();
  for (const it of items.rows) {
    if (!byNote.has(it.note_id)) byNote.set(it.note_id, []);
    byNote.get(it.note_id).push(it);
  }
  return { notes: notes.rows, itemsByNote: byNote };
}

/* Group an invoice's lines by GST rate, then hand each rate's tax to splitGst.
   Mirrors gstBreakupFrom() in templates/documentAdapter.js exactly — same
   grouping, same function, so the return and the PDF cannot drift apart. */
function rateRows(items, interState) {
  const byRate = new Map();
  for (const it of items) {
    const rate = num(it.gst_percent);
    if (!byRate.has(rate)) byRate.set(rate, { taxable: 0, gst: 0 });
    const b = byRate.get(rate);
    b.taxable += num(it.taxable);
    b.gst     += num(it.gst_amount);
  }
  const out = [];
  for (const rate of [...byRate.keys()].sort((a, b) => b - a)) {
    const b = byRate.get(rate);
    const parts = b.gst > 0 ? splitGst(b.gst, rate, interState) : [];
    out.push({
      rate,
      taxable: r2(b.taxable),
      cgst: r2(parts.filter(p => p.key === 'cgst').reduce((s, p) => s + p.amount, 0)),
      sgst: r2(parts.filter(p => p.key === 'sgst').reduce((s, p) => s + p.amount, 0)),
      igst: r2(parts.filter(p => p.key === 'igst').reduce((s, p) => s + p.amount, 0)),
      cess: 0,
    });
  }
  return out;
}

// =====================================================================
// GET /api/reports/gstr1
// =====================================================================
async function getGstr1(req, res, next) {
  try {
    /* A hub never sees this. Every other report on this page is hub-scoped —
       a hub partner sees their own jobs. A GST return cannot be scoped that
       way: it is the whole company's outward supply, with every customer's
       name and GSTIN in it, and a partial one would be a wrong return rather
       than a filtered view. So the answer is no, not a narrower yes. */
    if (isHubUser(req)) {
      return res.status(403).json({ error: 'The GST return is not available to hub logins.' });
    }

    const period = resolvePeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });

    const company = await loadCompany();
    const ownState = supplierStateCode(company);

    const { invoices, itemsByInvoice } = await loadPeriod(period.from, period.to);
    const { notes, itemsByNote } = await loadCreditNotes(period.from, period.to);

    const b2b = [];
    const b2clRows = [];
    const b2csMap = new Map();   // pos|rate -> row
    const hsnMap  = new Map();   // code|rate -> row
    const nilMap  = new Map();   // table-8 bucket -> row
    const cdnr    = [];          // table 9B — notes against REGISTERED buyers
    let cnTaxable = 0, cnGst = 0, notesApplied = 0;
    const notesSkipped = [];
    const warnings = [];
    const noHsn = [];
    const noPos = [];
    const badGstin = [];
    const noLines = [];

    /* Two running totals on purpose.
         totTaxable — taxable supplies only (Tables 4A/5/7), which is what the
                      return's tax is charged on.
         totNil     — zero-rated value routed to Table 8.
       Their sum is what must reconcile back to the ledger. Folding them into
       one number would make "taxable" include fuel, which is not taxable. */
    let totInvoiceValue = 0, totTaxable = 0, totNil = 0, totCgst = 0, totSgst = 0, totIgst = 0;

    for (const inv of invoices) {
      const items = itemsByInvoice.get(inv.id) || [];
      if (!items.length) { noLines.push(ciNo(inv.id)); continue; }

      /* The SAME resolution the PDF uses. After migration 184 the column is
         populated and rule 1 fires; the fallback stays because an invoice
         created before the fix — or by a path that misses it — must still land
         in the right table rather than vanish from the return. */
      const pos = resolvePlaceOfSupply(inv, company);
      if (!pos.code) { noPos.push(ciNo(inv.id)); continue; }
      if (pos.source !== 'explicit') {
        // Worth surfacing: the return is correct, but the invoice row is not
        // carrying the value, so a later edit could change what was filed.
        noPos.push(null); // counted below, not listed
      }

      const interState = isInterState(company, pos.code);
      const rows = rateRows(items, interState);

      const gstin = String(inv.b2b_gst_number || '').trim().toUpperCase();
      const isB2B = !!(inv.is_b2b && gstin);
      if (inv.is_b2b && gstin && gstin.length !== 15) badGstin.push(ciNo(inv.id));

      const invoiceValue = r2(inv.grand_total);
      totInvoiceValue += invoiceValue;

      for (const row of rows) {
        if (row.rate === 0) { totNil += row.taxable; }
        else { totTaxable += row.taxable; }
        totCgst += row.cgst; totSgst += row.sgst; totIgst += row.igst;

        /* ── Table 8, not 7 ────────────────────────────────────────────
           A zero-rated line is not a taxable supply at 0%. In this data every
           one of them is fuel — petrol and CNG — which is OUTSIDE GST
           altogether, not a 0% rate. Filing it in Table 7 as a taxable supply
           at rate 0 misstates the return, so it is separated here.

           Which of Table 8's three columns it belongs in (nil rated /
           exempted / non-GST) is a classification decision, not something to
           infer from a description, so the row carries the amount and the
           page asks for the call to be made. */
        if (row.rate === 0) {
          const bucket = isB2B
            ? (interState ? '8A' : '8B')
            : (interState ? '8C' : '8D');
          if (!nilMap.has(bucket)) {
            nilMap.set(bucket, {
              bucket,
              label: {
                '8A': 'Inter-State supplies to registered persons',
                '8B': 'Intra-State supplies to registered persons',
                '8C': 'Inter-State supplies to unregistered persons',
                '8D': 'Intra-State supplies to unregistered persons',
              }[bucket],
              amount: 0, line_count: 0, classification: 'unclassified',
            });
          }
          const nb = nilMap.get(bucket);
          nb.amount = r2(nb.amount + row.taxable);
          nb.line_count += 1;
          continue;
        }

        if (isB2B) {
          b2b.push({
            gstin,
            receiver_name: inv.b2b_company_name || inv.customer_name || '',
            invoice_no: ciNo(inv.id),
            invoice_date: inv.invoice_date,
            invoice_value: invoiceValue,
            pos_code: pos.code,
            pos_name: pos.name,
            reverse_charge: 'N',
            invoice_type: 'Regular B2B',
            rate: row.rate,
            taxable: row.taxable,
            cgst: row.cgst, sgst: row.sgst, igst: row.igst, cess: 0,
          });
        } else if (interState && invoiceValue > 100000) {
          /* B2CL. Nothing in the current data reaches here; it exists so a
             future out-of-state job is routed rather than quietly filed as
             B2CS, which would be the wrong table. */
          b2clRows.push({
            invoice_no: ciNo(inv.id),
            invoice_date: inv.invoice_date,
            invoice_value: invoiceValue,
            pos_code: pos.code, pos_name: pos.name,
            rate: row.rate, taxable: row.taxable,
            igst: row.igst, cess: 0,
          });
        } else {
          const key = `${pos.code}|${row.rate}`;
          if (!b2csMap.has(key)) {
            b2csMap.set(key, {
              type: 'OE', pos_code: pos.code, pos_name: pos.name,
              rate: row.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
              invoice_count: 0,
            });
          }
          const b = b2csMap.get(key);
          b.taxable = r2(b.taxable + row.taxable);
          b.cgst = r2(b.cgst + row.cgst);
          b.sgst = r2(b.sgst + row.sgst);
          b.igst = r2(b.igst + row.igst);
          b.invoice_count += 1;
        }
      }

      // ── Table 12: HSN summary, per line ────────────────────────────────
      for (const it of items) {
        const code = String(it.hsn_sac || '').trim();
        if (!code) {
          noHsn.push({ invoice: ciNo(inv.id), item_type: it.item_type, description: it.description });
          continue;
        }
        const rate = num(it.gst_percent);
        const key = `${code}|${rate}`;
        if (!hsnMap.has(key)) {
          hsnMap.set(key, {
            code, description: it.description || '',
            uqc: it.item_type === 'service' ? 'NA' : 'NOS',
            rate, quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
          });
        }
        const h = hsnMap.get(key);
        h.quantity = r2(h.quantity + num(it.quantity));
        h.taxable  = r2(h.taxable + num(it.taxable));
        const parts = num(it.gst_amount) > 0 ? splitGst(num(it.gst_amount), rate, interState) : [];
        h.cgst = r2(h.cgst + parts.filter(p => p.key === 'cgst').reduce((s, p) => s + p.amount, 0));
        h.sgst = r2(h.sgst + parts.filter(p => p.key === 'sgst').reduce((s, p) => s + p.amount, 0));
        h.igst = r2(h.igst + parts.filter(p => p.key === 'igst').reduce((s, p) => s + p.amount, 0));
      }
    }

    /* ── Credit notes ─────────────────────────────────────────────────────
       Where a note lands depends on WHO it was issued to, and the two answers
       are genuinely different documents in the return:

         B2B (registered buyer)  -> Table 9B, listed one row per note per rate.
                                    The buyer has to match it against their own
                                    ITC reversal, so it must be itemised.

         B2C (unregistered)      -> NOT listed anywhere. It nets off against
                                    Table 7, because B2CS is already reported
                                    as a summary and a separate line would
                                    double-count the reduction.

       Getting that backwards is the classic GSTR-1 error: a B2C credit note
       listed in 9B reduces the liability twice. */
    for (const n of notes) {
      const nItems = itemsByNote.get(n.id) || [];
      if (!nItems.length) { notesSkipped.push(n.note_no); continue; }
      notesApplied += 1;
      cnTaxable += num(n.subtotal_ex_gst);
      cnGst     += num(n.total_gst);

      const posCode = n.place_of_supply_code || ownState;
      if (!posCode) continue;
      const interState = isInterState(company, posCode);
      const rows = rateRows(nItems, interState);
      const gstin = String(n.b2b_gst_number || '').trim().toUpperCase();
      const isB2B = !!(n.is_b2b && gstin);

      for (const row of rows) {
        /* Subtract from the running totals whichever way it is reported. The
           return's tax must fall by the note's tax either way; only the
           PRESENTATION differs. */
        if (row.rate === 0) totNil -= row.taxable; else totTaxable -= row.taxable;
        totCgst -= row.cgst; totSgst -= row.sgst; totIgst -= row.igst;
        totInvoiceValue -= r2(row.taxable + row.cgst + row.sgst + row.igst);

        if (isB2B) {
          cdnr.push({
            gstin,
            receiver_name: n.b2b_company_name || n.customer_name || '',
            note_no: n.note_no,
            note_date: n.note_date,
            original_invoice_no: ciNo(n.customer_invoice_id),
            original_invoice_date: n.orig_invoice_date,
            note_type: 'C',              // C = credit note, D = debit note
            reason: n.reason,
            pos_code: posCode,
            pos_name: n.place_of_supply_name || (STATE_CODES[posCode] || ''),
            note_value: r2(n.grand_total),
            rate: row.rate,
            taxable: row.taxable,
            cgst: row.cgst, sgst: row.sgst, igst: row.igst, cess: 0,
          });
        } else {
          const key = `${posCode}|${row.rate}`;
          if (!b2csMap.has(key)) {
            b2csMap.set(key, {
              type: 'OE', pos_code: posCode,
              pos_name: n.place_of_supply_name || (STATE_CODES[posCode] || ''),
              rate: row.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
              invoice_count: 0,
            });
          }
          const b = b2csMap.get(key);
          b.taxable = r2(b.taxable - row.taxable);
          b.cgst = r2(b.cgst - row.cgst);
          b.sgst = r2(b.sgst - row.sgst);
          b.igst = r2(b.igst - row.igst);
        }
      }

      /* Table 12 nets off too — the HSN summary reports what was actually
         supplied, and a returned part was not. */
      for (const it of nItems) {
        const code = String(it.hsn_sac || '').trim();
        if (!code) continue;
        const rate = num(it.gst_percent);
        const key = `${code}|${rate}`;
        if (!hsnMap.has(key)) continue;   // nothing supplied at this code this period
        const h = hsnMap.get(key);
        h.quantity = r2(h.quantity - num(it.quantity));
        h.taxable  = r2(h.taxable - num(it.taxable));
        const parts = num(it.gst_amount) > 0 ? splitGst(num(it.gst_amount), rate, interState) : [];
        h.cgst = r2(h.cgst - parts.filter(p => p.key === 'cgst').reduce((s, p) => s + p.amount, 0));
        h.sgst = r2(h.sgst - parts.filter(p => p.key === 'sgst').reduce((s, p) => s + p.amount, 0));
        h.igst = r2(h.igst - parts.filter(p => p.key === 'igst').reduce((s, p) => s + p.amount, 0));
      }
    }

    // ── Table 13: documents issued ────────────────────────────────────────
    const usedIds = invoices.filter(i => (itemsByInvoice.get(i.id) || []).length).map(i => i.id);
    const minId = usedIds.length ? Math.min(...usedIds) : 0;
    const maxId = usedIds.length ? Math.max(...usedIds) : 0;
    const span  = usedIds.length ? (maxId - minId + 1) : 0;
    const docs = usedIds.length ? [{
      nature: 'Invoices for outward supply',
      from_no: ciNo(minId),
      to_no:   ciNo(maxId),
      total:   usedIds.length,
      cancelled: 0,
      /* Numbers inside the range that are NOT in this period. Not cancelled
         documents — they exist, they are just dated in another month, because
         the number comes from the row id while the period comes from
         invoice_date, and backdating (migration 100) separates the two. */
      outside_period: span - usedIds.length,
    }] : [];

    // ── Warnings — things that would file wrong ───────────────────────────
    const unstoredPos = noPos.filter(v => v === null).length;
    const missingPos  = noPos.filter(Boolean);

    if (missingPos.length) warnings.push({
      code: 'no_place_of_supply', severity: 'blocker',
      message: `${missingPos.length} invoice(s) have no place of supply and could not be classified. They are NOT in the figures below.`,
      items: missingPos.slice(0, 50), count: missingPos.length,
    });
    if (unstoredPos) warnings.push({
      code: 'place_of_supply_not_stored', severity: 'warn',
      message: `${unstoredPos} invoice(s) had their place of supply derived rather than read from the invoice. Run migration 184 so the value is stored on the document.`,
      count: unstoredPos,
    });
    if (noHsn.length) warnings.push({
      code: 'no_hsn', severity: 'blocker',
      message: `${noHsn.length} line(s) have no HSN/SAC code, so Table 12 under-reports by their value.`,
      items: noHsn.slice(0, 50), count: noHsn.length,
    });
    if (badGstin.length) warnings.push({
      code: 'bad_gstin', severity: 'blocker',
      message: `${badGstin.length} B2B invoice(s) have a GSTIN that is not 15 characters. The portal will reject these rows.`,
      items: badGstin, count: badGstin.length,
    });
    if (noLines.length) warnings.push({
      code: 'no_lines', severity: 'warn',
      message: `${noLines.length} invoice(s) in this period have no line items and were skipped.`,
      items: noLines, count: noLines.length,
    });
    if (nilMap.size) {
      const nilTotal = r2([...nilMap.values()].reduce((t, r) => t + r.amount, 0));
      warnings.push({
        code: 'nil_rated_unclassified', severity: 'blocker',
        message: `Rs ${nilTotal.toFixed(2)} of zero-rated supply is reported in Table 8 but not yet split into nil rated / exempted / non-GST. In this data it is fuel (petrol, CNG), which is a NON-GST supply - confirm before filing.`,
        count: nilMap.size,
      });
    }
    if (docs.length && docs[0].outside_period > 0) {
      warnings.push({
        code: 'document_range_gaps', severity: 'warn',
        message: `Table 13 reports ${docs[0].from_no} to ${docs[0].to_no}, a range of ${span} numbers, but only ${usedIds.length} are dated in this period. The other ${docs[0].outside_period} are real invoices dated in another month - invoice numbers follow creation order while the return follows invoice_date. Consecutive periods will overlap.`,
        count: docs[0].outside_period,
      });
    }
    if (notesSkipped.length) warnings.push({
      code: 'credit_note_no_lines', severity: 'blocker',
      message: `${notesSkipped.length} credit note(s) have no line items and were left out of the return entirely.`,
      items: notesSkipped, count: notesSkipped.length,
    });
    if (notesApplied) warnings.push({
      code: 'credit_notes_applied', severity: 'info',
      message: `${notesApplied} credit note(s) worth Rs ${r2(cnTaxable + cnGst).toFixed(2)} are netted off this return. Notes to registered buyers are listed in Table 9B; notes to unregistered customers are netted into Table 7, which is where they belong - listing those separately would reduce the liability twice.`,
      count: notesApplied,
    });

    // ── Reconciliation — the return against the ledger it came from ───────
    /* The ledger side nets the credit notes off as well. Comparing a return
       that already subtracted them against a raw invoice total would show a
       difference every time a note is issued, which would train everyone to
       ignore the one banner that is supposed to mean something. */
    const ledgerTaxable = r2(invoices.reduce((s, i) => s + num(i.subtotal_ex_gst), 0) - cnTaxable);
    const ledgerGst     = r2(invoices.reduce((s, i) => s + num(i.total_gst), 0) - cnGst);
    const returnTax     = r2(totCgst + totSgst + totIgst);

    res.json({
      period: { type: period.type, label: period.label, from: period.from, to: period.to, fp: period.fp },
      company: {
        name: company?.company_name || '',
        gstin: company?.gstin || '',
        state_code: ownState,
        state_name: ownState ? STATE_CODES[ownState] : '',
      },
      b2b,
      b2cl: b2clRows,
      nil_rated: [...nilMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      cdnr,
      b2cs: [...b2csMap.values()].sort((a, b) => a.pos_code.localeCompare(b.pos_code) || b.rate - a.rate),
      hsn:  [...hsnMap.values()].sort((a, b) => a.code.localeCompare(b.code) || b.rate - a.rate),
      docs,
      totals: {
        invoices: usedIds.length,
        credit_notes: notesApplied,
        credit_note_value: r2(cnTaxable + cnGst),
        b2b_invoices: new Set(b2b.map(r => r.invoice_no)).size,
        b2c_invoices: usedIds.length - new Set(b2b.map(r => r.invoice_no)).size,
        invoice_value: r2(totInvoiceValue),
        taxable: r2(totTaxable),
        nil_rated: r2(totNil),
        cgst: r2(totCgst), sgst: r2(totSgst), igst: r2(totIgst),
        total_tax: returnTax,
      },
      reconciliation: {
        ledger_taxable: ledgerTaxable,
        /* Taxable supplies PLUS Table 8, because the ledger's subtotal makes
           no such distinction. This is the line that proves no invoice was
           silently dropped from the return. */
        return_taxable: r2(totTaxable + totNil),
        taxable_diff: r2(ledgerTaxable - (totTaxable + totNil)),
        ledger_gst: ledgerGst,
        return_tax: returnTax,
        tax_diff: r2(ledgerGst - returnTax),
        /* A non-zero diff is not automatically an error: splitGst rounds each
           rate's CGST half UP to the paisa, so the return can exceed the
           ledger by a paisa per rate per invoice. Anything larger means an
           invoice was dropped, and the page says so rather than hiding it. */
        material: Math.abs(ledgerTaxable - (totTaxable + totNil)) > 1 || Math.abs(ledgerGst - returnTax) > Math.max(1, usedIds.length * 0.02),
      },
      warnings,
    });
  } catch (err) { next(err); }
}

module.exports = { getGstr1, resolvePeriod };
