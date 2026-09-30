'use strict';

/**
 * Party ledger — a running statement for one customer or one hub.
 *
 * ══ IT WRITES NOTHING ══════════════════════════════════════════════════════
 *
 * Every row here is a document that already exists: an invoice, a payment, a
 * credit note, an opening balance. There is no such thing as a "ledger entry"
 * anybody can type.
 *
 * That is the whole design. The moment someone can hand-type a balance
 * adjustment straight into the statement, the statement and the invoices start
 * disagreeing and neither can be trusted. Corrections are credit notes
 * (migration 185); the starting figure is an opening balance (migration 186).
 * Both are real documents with numbers and history.
 *
 * ══ A CUSTOMER IS A MOBILE NUMBER ══════════════════════════════════════════
 *
 * customer_profiles is keyed on mobile and there is no customer id anywhere,
 * so the ledger keys on mobile too rather than inventing an identity the rest
 * of the system does not have.
 *
 * The cost is real and is surfaced rather than hidden: three mobile numbers in
 * this data carry two different customer names. The statement header lists
 * every name seen on the number, so a merged party is visible instead of
 * silently averaged.
 *
 * ══ SIGNS ══════════════════════════════════════════════════════════════════
 *
 *   customer   debit increases what THEY owe US     (invoice Dr, payment Cr)
 *   hub        credit increases what WE owe THEM    (their invoice Cr, our payment Dr)
 *
 * Closing balance is reported as a positive amount plus a direction, never as
 * a signed number. "₹95,150 Dr" is unambiguous; "-95150" depends on which way
 * the reader assumes the sign points.
 */

const { pool } = require('../config/db');
const { isHubUser } = require('../utils/hubScope');
const { loadCompany } = require('../utils/renderDocument');
const { calendarDate } = require('../utils/appTime');
const { renderHtmlToPdf } = require('../utils/pdf');
const { statementHtml } = require('../templates/statementPdf');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2  = (v) => Math.round(num(v) * 100) / 100;
const ciNo = (id) => `CI-${String(id).padStart(6, '0')}`;
const piNo = (id) => `PI-${String(id).padStart(6, '0')}`;
/* Was `new Date(d).toISOString().slice(0, 10)`, which is the UTC date. The
   process runs in IST (utils/appTime), so a DATE column arrives as local
   midnight and its UTC form is the DAY BEFORE — every invoice date, every note
   date and every opening date on every statement, one day early. Only visible
   on a server east of Greenwich, which is the only kind this runs on. */
const isoDate = calendarDate;

/** The live opening balance for a party, or null. */
/**
 * Everything that happened BEFORE `from`, as one debit-positive number.
 *
 * The filters here have to match the builders below exactly — same tables,
 * same status conditions. If one of them counts a cancelled invoice and the
 * other does not, a statement for August plus a statement for September stops
 * adding up to a statement for August–September, and nobody can tell which of
 * the two is lying.
 */
async function netBefore(partyType, partyKey, from) {
  const d = String(from).slice(0, 10);
  const q = partyType === 'customer'
    ? { sql: `SELECT
           (SELECT COALESCE(SUM(ci.grand_total), 0) FROM customer_invoices ci
             WHERE ci.mobile = $1 AND ci.invoice_date < $2::date)
         + (SELECT COALESCE(SUM(rf.amount), 0) FROM payment_refunds rf
              JOIN customer_invoices ci2 ON ci2.id = rf.customer_invoice_id
             WHERE ci2.mobile = $1 AND rf.status = 'processed' AND rf.created_at::date < $2::date)
         - (SELECT COALESCE(SUM(p.amount), 0) FROM customer_invoice_payments p
             WHERE p.mobile = $1 AND p.paid_at::date < $2::date)
         - (SELECT COALESCE(SUM(cn.grand_total), 0) FROM credit_notes cn
             WHERE cn.party_type = 'customer' AND cn.mobile = $1
               AND cn.status = 'issued' AND cn.note_date < $2::date) AS net`,
        params: [String(partyKey), d] }
    : { sql: `SELECT
           (SELECT COALESCE(SUM(hp.amount), 0) FROM hub_payments hp
             WHERE hp.hub_id = $1 AND hp.paid_at::date < $2::date)
         + (SELECT COALESCE(SUM(cn.grand_total), 0) FROM credit_notes cn
             WHERE cn.party_type = 'hub' AND cn.hub_id = $1
               AND cn.status = 'issued' AND cn.note_date < $2::date)
         - (SELECT COALESCE(SUM(pi.grand_total), 0) FROM purchase_invoices pi
             WHERE pi.hub_id = $1 AND pi.created_at::date < $2::date) AS net`,
        params: [Number(partyKey), d] };
  const r = await pool.query(q.sql, q.params);
  return num(r.rows[0]?.net);
}

/**
 * Where the statement starts.
 *
 * Unfiltered, that is the opening balance somebody typed in. Filtered to a
 * date range, it has to be the opening balance PLUS everything that happened
 * before the range — otherwise a statement for August silently drops January
 * to July and every balance in the column is wrong while looking perfectly
 * reasonable. That is the one failure mode a statement must not have.
 */
async function openingFor(partyType, partyKey, from) {
  const r = await pool.query(
    `SELECT amount, direction, as_of_date, note
       FROM party_opening_balances
      WHERE party_type = $1 AND party_key = $2 AND superseded_at IS NULL`,
    [partyType, String(partyKey)]
  );
  const stored = r.rows[0] || null;
  if (!from) return stored;

  /* Debit-positive throughout, the same direction `runBalance` works in. */
  const storedSigned = stored
    ? (stored.direction === 'dr' ? num(stored.amount) : -num(stored.amount))
    : 0;
  const net = r2(storedSigned + await netBefore(partyType, partyKey, from));

  /* A party that was square on the morning the range opens gets no row at all.
     Printing "brought forward ₹0.00" is noise dressed as diligence. */
  if (Math.abs(net) < 0.011) return null;
  return {
    amount: Math.abs(net),
    direction: net >= 0 ? 'dr' : 'cr',
    as_of_date: String(from).slice(0, 10),
    note: 'Balance brought forward',
    brought_forward: true,
  };
}

/**
 * Turn document rows into a statement.
 *
 * Sorted by date, then by a stable tie-break, because several documents
 * commonly share one date — an invoice and the payment that settled it, on the
 * same afternoon. Without the tie-break the running balance flickers between
 * page loads, which is the kind of thing that destroys trust in a statement
 * faster than a wrong number does.
 */
function runBalance(rows, opening, dirIsDebit) {
  const sorted = [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a._rank !== b._rank) return a._rank - b._rank;
    return String(a.ref).localeCompare(String(b.ref));
  });

  /* `bal` is debit-positive for BOTH parties, because the loop below does
     `bal += debit - credit`. A credit opening is therefore negative here
     whoever the party is, and only the LABEL flips with the convention.

     This used to read `opening.direction === (dirIsDebit ? 'dr' : 'cr')`,
     which stored a hub's credit opening as a POSITIVE — leaving every running
     balance after it wrong by twice the opening, in the direction that says
     the hub owes us. It never surfaced because party_opening_balances is
     empty, so no statement had ever taken this branch. A date-filtered
     statement brings a balance forward through this same path on every
     request, so it would have surfaced on the first filtered hub. */
  let bal = 0;
  if (opening) {
    bal = opening.direction === 'dr' ? num(opening.amount) : -num(opening.amount);
  }

  /* The single place that turns the internal figure into what is printed, so
     the opening row and every row after it cannot describe the same number in
     two different ways. */
  const describe = (b) => {
    const shown = dirIsDebit ? b : -b;
    return {
      balance: r2(Math.abs(shown)),
      balance_direction: shown >= 0
        ? (dirIsDebit ? 'dr' : 'cr')
        : (dirIsDebit ? 'cr' : 'dr'),
    };
  };

  const out = [];
  if (opening) {
    out.push({
      date: isoDate(opening.as_of_date),
      type: 'opening',
      col: opening.direction === 'dr' ? 'debit' : 'credit',
      ref: opening.brought_forward ? 'Brought forward' : 'Opening balance',
      particulars: opening.note || 'Carried in from before Spinoto',
      debit:  opening.direction === 'dr' ? r2(opening.amount) : 0,
      credit: opening.direction === 'cr' ? r2(opening.amount) : 0,
      ...describe(bal),
    });
  }

  for (const r of sorted) {
    bal += num(r.debit) - num(r.credit);
    /* The LABEL follows the convention, not just the sign. On the hub side a
       positive running figure means we owe them, which is a CREDIT balance —
       calling it 'dr' because the number came out positive is how a payables
       statement ends up saying the hub owes us. describe() holds that rule. */
    out.push({
      ...r,
      debit: r2(r.debit), credit: r2(r.credit),
      ...describe(bal),
    });
  }
  return out;
}

// =====================================================================
// The customer statement, as data. Used by the JSON endpoint and the PDF.
// =====================================================================
async function buildCustomerLedger(mobile, { from, to } = {}) {

    const dateWhere = (col) => {
      const parts = [];
      if (from) parts.push(`${col} >= '${String(from).slice(0, 10)}'::date`);
      if (to)   parts.push(`${col} <= '${String(to).slice(0, 10)}'::date`);
      return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    };

    const [invs, pays, notes, refunds, opening] = await Promise.all([
      pool.query(
        `SELECT ci.id, ci.invoice_date, ci.grand_total, ci.status,
                ci.customer_name, ci.is_b2b, ci.b2b_company_name, ci.b2b_gst_number,
                ci.vehicle_number, ci.amount_paid
           FROM customer_invoices ci
          WHERE ci.mobile = $1${dateWhere('ci.invoice_date')}
          ORDER BY ci.invoice_date, ci.id`, [mobile]),
      pool.query(
        `SELECT p.id, p.paid_at, p.amount, p.method, p.reference_no,
                p.customer_invoice_id, p.voucher_no
           FROM customer_invoice_payments p
          WHERE p.mobile = $1${dateWhere('p.paid_at::date')}
          ORDER BY p.paid_at, p.id`, [mobile]),
      pool.query(
        `SELECT cn.id, cn.note_no, cn.note_date, cn.grand_total, cn.reason,
                cn.customer_invoice_id
           FROM credit_notes cn
          WHERE cn.party_type = 'customer' AND cn.mobile = $1
            AND cn.status = 'issued'${dateWhere('cn.note_date')}
          ORDER BY cn.note_date, cn.id`, [mobile]),
      pool.query(
        `SELECT rf.id, rf.created_at, rf.amount, rf.customer_invoice_id, rf.voucher_no
           FROM payment_refunds rf
           JOIN customer_invoices ci ON ci.id = rf.customer_invoice_id
          WHERE ci.mobile = $1 AND rf.status = 'processed'${dateWhere('rf.created_at::date')}
          ORDER BY rf.created_at, rf.id`, [mobile]),
      openingFor('customer', mobile, from),
    ]);

    const rows = [];
    for (const i of invs.rows) rows.push({
      date: isoDate(i.invoice_date), _rank: 1, type: 'invoice', col: 'debit',
      ref: ciNo(i.id), entity_id: i.id,
      particulars: `Invoice${i.vehicle_number ? ` · ${i.vehicle_number}` : ''}`,
      debit: num(i.grand_total), credit: 0,
    });
    for (const p of pays.rows) rows.push({
      date: isoDate(p.paid_at), _rank: 2, type: 'payment', col: 'credit',
      ref: p.voucher_no || `Payment #${p.id}`, entity_id: p.customer_invoice_id,
      particulars: `Payment received${p.method ? ` · ${p.method}` : ''}` +
        (p.customer_invoice_id ? ` · against ${ciNo(p.customer_invoice_id)}` : ' · on account'),
      debit: 0, credit: num(p.amount),
    });
    for (const n of notes.rows) rows.push({
      date: isoDate(n.note_date), _rank: 2, type: 'credit_note', col: 'credit',
      ref: n.note_no, entity_id: n.id,
      particulars: `Credit note · ${String(n.reason).replace(/_/g, ' ')}` +
        (n.customer_invoice_id ? ` · against ${ciNo(n.customer_invoice_id)}` : ''),
      debit: 0, credit: num(n.grand_total),
    });
    for (const rf of refunds.rows) rows.push({
      date: isoDate(rf.created_at), _rank: 3, type: 'refund', col: 'debit',
      ref: rf.voucher_no || `Refund #${rf.id}`, entity_id: rf.customer_invoice_id,
      particulars: `Refund paid out${rf.customer_invoice_id ? ` · ${ciNo(rf.customer_invoice_id)}` : ''}`,
      debit: num(rf.amount), credit: 0,
    });

    const statement = runBalance(rows, opening, true);
    const last = statement[statement.length - 1];

    /* Every name this number has answered to. Three numbers in this data carry
       two names; showing both beats picking one and being wrong on a document
       somebody sends to a customer. */
    const names = [...new Set(invs.rows
      .map(i => (i.is_b2b && i.b2b_company_name) ? i.b2b_company_name : i.customer_name)
      .filter(Boolean))];

    /* Ageing on what is still open, by invoice date. Only the unpaid part of
       each invoice counts, so a half-settled invoice ages only for what is
       left rather than dropping out or counting in full. */
    const today = new Date();
    const ageing = { current: 0, d30: 0, d60: 0, d90plus: 0 };
    for (const i of invs.rows) {
      const owed = r2(num(i.grand_total) - num(i.amount_paid));
      if (owed <= 0.011) continue;
      const days = Math.floor((today - new Date(i.invoice_date)) / 86400000);
      if (days <= 30) ageing.current += owed;
      else if (days <= 60) ageing.d30 += owed;
      else if (days <= 90) ageing.d60 += owed;
      else ageing.d90plus += owed;
    }
    for (const k of Object.keys(ageing)) ageing[k] = r2(ageing[k]);

    return {
      party: {
        type: 'customer', key: mobile, mobile,
        name: names[0] || mobile, names,
        gstin: invs.rows.find(i => i.b2b_gst_number)?.b2b_gst_number || null,
        is_b2b: invs.rows.some(i => i.is_b2b),
      },
      opening,
      rows: statement,
      totals: {
        opening: opening ? r2(opening.amount) : 0,
        opening_direction: opening?.direction || null,
        debit:  r2(rows.reduce((s, r) => s + num(r.debit), 0)),
        credit: r2(rows.reduce((s, r) => s + num(r.credit), 0)),
        closing: last ? last.balance : 0,
        closing_direction: last ? last.balance_direction : 'dr',
        documents: rows.length,
      },
      /* Echoed back so the screen and the PDF print the period they were
         actually given rather than the period somebody meant to ask for. */
      range: { from: from || null, to: to || null },
      ageing,
    };
}

// =====================================================================
// The hub statement. Same shape, opposite sign.
// =====================================================================
async function buildHubLedger(hubId, { from, to } = {}) {

    const dateWhere = (col) => {
      const parts = [];
      if (from) parts.push(`${col} >= '${String(from).slice(0, 10)}'::date`);
      if (to)   parts.push(`${col} <= '${String(to).slice(0, 10)}'::date`);
      return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    };

    const [hub, invs, pays, notes, opening] = await Promise.all([
      pool.query(`SELECT id, hub_name, gst_number FROM hubs WHERE id = $1`, [hubId]),
      pool.query(
        `SELECT pi.id, pi.created_at, pi.grand_total, pi.payment_status
           FROM purchase_invoices pi
          WHERE pi.hub_id = $1${dateWhere('pi.created_at::date')}
          ORDER BY pi.created_at, pi.id`, [hubId]),
      /* hub_payments only. hub_payouts is a batch wrapper whose lines land
         here as well — including both would count every payout twice. */
      pool.query(
        `SELECT hp.id, hp.paid_at, hp.amount, hp.method, hp.reference_no, hp.purchase_invoice_id
           FROM hub_payments hp
          WHERE hp.hub_id = $1${dateWhere('hp.paid_at::date')}
          ORDER BY hp.paid_at, hp.id`, [hubId]),
      pool.query(
        `SELECT cn.id, cn.note_no, cn.note_date, cn.grand_total, cn.reason, cn.purchase_invoice_id
           FROM credit_notes cn
          WHERE cn.party_type = 'hub' AND cn.hub_id = $1
            AND cn.status = 'issued'${dateWhere('cn.note_date')}
          ORDER BY cn.note_date, cn.id`, [hubId]),
      openingFor('hub', String(hubId), from),
    ]);

    if (!hub.rows[0]) { const e = new Error('Hub not found.'); e.status = 404; throw e; }

    const rows = [];
    for (const i of invs.rows) rows.push({
      date: isoDate(i.created_at), _rank: 1, type: 'purchase_invoice', col: 'credit',
      ref: piNo(i.id), entity_id: i.id,
      particulars: i.payment_status === 'not_required'
        ? 'Purchase invoice · no payment due'
        : 'Purchase invoice',
      debit: 0, credit: num(i.grand_total),
    });
    for (const p of pays.rows) rows.push({
      date: isoDate(p.paid_at), _rank: 2, type: 'payment', col: 'debit',
      ref: p.reference_no || `Payment #${p.id}`, entity_id: p.purchase_invoice_id,
      particulars: `Paid to hub${p.method ? ` · ${p.method}` : ''}` +
        (p.purchase_invoice_id ? ` · ${piNo(p.purchase_invoice_id)}` : ''),
      debit: num(p.amount), credit: 0,
    });
    for (const n of notes.rows) rows.push({
      date: isoDate(n.note_date), _rank: 2, type: 'debit_note', col: 'debit',
      ref: n.note_no, entity_id: n.id,
      particulars: `Debit note · ${String(n.reason).replace(/_/g, ' ')}` +
        (n.purchase_invoice_id ? ` · against ${piNo(n.purchase_invoice_id)}` : ''),
      debit: num(n.grand_total), credit: 0,
    });

    const statement = runBalance(rows, opening, false);
    const last = statement[statement.length - 1];

    return {
      party: {
        type: 'hub', key: String(hubId),
        name: hub.rows[0].hub_name, names: [hub.rows[0].hub_name],
        gstin: hub.rows[0].gst_number || null,
      },
      opening,
      rows: statement,
      totals: {
        opening: opening ? r2(opening.amount) : 0,
        opening_direction: opening?.direction || null,
        debit:  r2(rows.reduce((s, r) => s + num(r.debit), 0)),
        credit: r2(rows.reduce((s, r) => s + num(r.credit), 0)),
        closing: last ? last.balance : 0,
        closing_direction: last ? last.balance_direction : 'cr',
        documents: rows.length,
      },
      /* Echoed back so the screen and the PDF print the period they were
         actually given rather than the period somebody meant to ask for. */
      range: { from: from || null, to: to || null },
    };
}

/* ── The handlers ─────────────────────────────────────────────────────────
   Thin on purpose. Both the JSON and the PDF need exactly the same statement,
   so the building happens once and the two endpoints only differ in how they
   hand it over — a PDF that could disagree with the screen it was printed
   from would be worse than no PDF. */
async function customerLedger(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const mobile = String(req.params.mobile || '').trim();
    if (!mobile) return res.status(400).json({ error: 'A mobile number is required.' });
    res.json(await buildCustomerLedger(mobile, req.query));
  } catch (err) { next(err); }
}

async function hubLedger(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const hubId = Number(req.params.hubId);
    if (!hubId) return res.status(400).json({ error: 'A hub is required.' });
    res.json(await buildHubLedger(hubId, req.query));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
}

// ── PDF ───────────────────────────────────────────────────────────────────
async function statementPdfHandler(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const isCustomer = !!req.params.mobile;
    const ledger = isCustomer
      ? await buildCustomerLedger(String(req.params.mobile).trim(), req.query)
      : await buildHubLedger(Number(req.params.hubId), req.query);

    const company = await loadCompany();
    const html = statementHtml(ledger, company);
    const pdf = await renderHtmlToPdf(html, { pageSize: 'A4' });

    const safe = String(ledger.party.name || 'statement')
      .replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50);
    res.setHeader('Content-Type', 'application/pdf');
    /* inline, not attachment: the common case is looking at it before deciding
       whether to send it, and a forced download makes that two steps. */
    res.setHeader('Content-Disposition', `inline; filename="statement-${safe}.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
}

// =====================================================================
// GET /api/ledger/payables — every hub we owe, oldest first
// =====================================================================
async function payables(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const r = await pool.query(
      `SELECT h.id AS hub_id, h.hub_name,
              COUNT(pi.id)::int AS open_invoices,
              ROUND(SUM(pi.grand_total), 2) AS outstanding,
              MIN(pi.created_at)::date AS oldest,
              EXTRACT(DAY FROM NOW() - MIN(pi.created_at))::int AS oldest_days,
              /* The last time money actually left for this hub.
                 hub_payments, NOT hub_payouts — the same table the Hub Payouts
                 screen sums for "what we paid", so the two screens cannot
                 disagree about when a hub was last paid. hub_payouts holds only
                 the transfers a provider sent; a payment recorded by hand from
                 a banking app never appears in it, and this column would then
                 tell someone a hub had never been paid when it had.
                 A payout covering three invoices writes three rows here, but
                 MAX is unaffected by that — the date is the same either way. */
              (SELECT MAX(hp.paid_at)::date
                 FROM hub_payments hp
                WHERE hp.hub_id = h.id) AS last_paid
         FROM purchase_invoices pi
         JOIN hubs h ON h.id = pi.hub_id
        WHERE pi.payment_status = 'pending' AND pi.grand_total > 0
        GROUP BY h.id, h.hub_name
        ORDER BY 4 DESC`
    );
    const total = r2(r.rows.reduce((s, x) => s + num(x.outstanding), 0));
    res.json({ items: r.rows, total, hubs: r.rows.length });
  } catch (err) { next(err); }
}

module.exports = {
  customerLedger, hubLedger, payables, statementPdfHandler,
  // exported so anything else that needs a statement builds the same one
  buildCustomerLedger, buildHubLedger,
};
