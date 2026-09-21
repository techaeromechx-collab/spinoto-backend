'use strict';

/**
 * Credit notes to customers, debit notes to hubs.
 *
 * ══ THE RULE THAT SHAPES EVERYTHING HERE ═══════════════════════════════════
 *
 * An issued invoice is never edited. Section 34 says the way to reduce one is
 * to issue a note against it, and Rule 56 says an erroneous entry is corrected
 * by a new attested entry rather than an overwrite. So nothing in this file
 * touches customer_invoices except to recompute its derived payment state.
 *
 * The note reduces what is PAYABLE, not what was BILLED. invoiceBalance
 * .service.js does that arithmetic; see the comment there on why a credit note
 * must not be counted as a payment.
 *
 * ══ NUMBERING ══════════════════════════════════════════════════════════════
 *
 * Issued inside the creating transaction, under SELECT … FOR UPDATE on the
 * sequence row. Two users saving in the same second serialise on that lock,
 * and the unique index on note_no is the guarantee behind it — because it does
 * not depend on this code being correct.
 *
 * Never renumbered, never reused. A note raised in error is CANCELLED and
 * keeps its number; a gap in a tax series is something somebody has to explain
 * to an officer later.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { recalcInvoiceState } = require('../services/invoiceBalance.service');
const { generatePublicToken } = require('../utils/publicToken');
const { logActivity } = require('../services/activityLog.service');
const { isHubUser } = require('../utils/hubScope');
const { resolvePlaceOfSupply } = require('../utils/gstStates');
const { loadCompany } = require('../utils/renderDocument');

/* The printed number. One place, so a change here cannot leave half the
   system formatting the old way. */
const NOTE_PREFIX = { customer: 'CN', hub: 'DN' };
const formatNoteNo = (partyType, fy, seq) =>
  `${NOTE_PREFIX[partyType]}/${fy}/${String(seq).padStart(4, '0')}`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2  = (v) => Math.round(num(v) * 100) / 100;

/** Indian financial year for a date: April to March, '2026-27'. */
function fyOf(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;   // month 3 === April
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Section 34(2): the last date a note may be DECLARED and still reduce tax —
 * 30 November following the end of the financial year of the supply, or the
 * date the annual return is filed, whichever is earlier.
 *
 * Returned as a warning, never as a block. Whether the annual return has been
 * filed is not knowable from this database, and a note issued late is still a
 * valid commercial document — it just cannot reduce the tax. Refusing to
 * record it would leave the customer's balance wrong as well.
 */
function lateDeclarationWarning(invoiceDate, noteDate) {
  if (!invoiceDate || !noteDate) return null;
  const fy = fyOf(invoiceDate);
  const fyEndYear = Number(fy.slice(0, 4)) + 1;
  const cutoff = new Date(Date.UTC(fyEndYear, 10, 30));   // 30 November
  const nd = new Date(`${String(noteDate).slice(0, 10)}T00:00:00Z`);
  if (nd <= cutoff) return null;
  return `This note is dated after 30 November ${fyEndYear}, the Section 34(2) cut-off for the invoice's financial year (${fy}). It will still reduce the customer's balance, but the GST on it may no longer be adjustable. Confirm with your CA before filing.`;
}

// ── Validation ─────────────────────────────────────────────────────────────
const lineSchema = z.object({
  customer_invoice_item_id: z.number().int().positive().nullable().optional(),
  purchase_invoice_item_id: z.number().int().positive().nullable().optional(),
  item_type:   z.enum(['part', 'service']).default('service'),
  description: z.string().trim().min(1).max(300),
  hsn_sac:     z.string().trim().max(20).nullable().optional(),
  quantity:    z.number().positive().default(1),
  rate:        z.number().min(0),
  gst_percent: z.number().min(0).max(100).default(0),
});

const createSchema = z.object({
  party_type:          z.enum(['customer', 'hub']),
  customer_invoice_id: z.number().int().positive().nullable().optional(),
  purchase_invoice_id: z.number().int().positive().nullable().optional(),
  note_date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(['rejection_after_payment', 'price_correction', 'goods_returned',
                  'deficiency_in_service', 'post_sale_discount', 'other']),
  reason_note: z.string().trim().max(2000).nullable().optional(),
  items: z.array(lineSchema).min(1, 'A note needs at least one line'),
});

/** Take the next number for this series, under a row lock. */
async function issueNumber(client, partyType, fy) {
  const existing = await client.query(
    `SELECT id, next_seq FROM credit_note_sequences
      WHERE party_type = $1 AND fy = $2 FOR UPDATE`,
    [partyType, fy]
  );

  let seq;
  if (existing.rows[0]) {
    seq = existing.rows[0].next_seq;
    await client.query(
      `UPDATE credit_note_sequences SET next_seq = next_seq + 1, updated_at = NOW() WHERE id = $1`,
      [existing.rows[0].id]
    );
  } else {
    /* ON CONFLICT rather than a plain insert: two transactions can both find
       no row for a brand-new financial year, and the unique index is what
       decides between them. The loser re-reads under the lock. */
    const ins = await client.query(
      `INSERT INTO credit_note_sequences (party_type, fy, next_seq)
            VALUES ($1, $2, 2)
       ON CONFLICT (party_type, fy) DO NOTHING
         RETURNING id`,
      [partyType, fy]
    );
    if (ins.rows[0]) {
      seq = 1;
    } else {
      const again = await client.query(
        `SELECT id, next_seq FROM credit_note_sequences
          WHERE party_type = $1 AND fy = $2 FOR UPDATE`,
        [partyType, fy]
      );
      seq = again.rows[0].next_seq;
      await client.query(
        `UPDATE credit_note_sequences SET next_seq = next_seq + 1, updated_at = NOW() WHERE id = $1`,
        [again.rows[0].id]
      );
    }
  }
  return { seq, note_no: formatNoteNo(partyType, fy, seq) };
}

// =====================================================================
// POST /api/credit-notes
// =====================================================================
async function createCreditNote(req, res, next) {
  const client = await pool.connect();
  try {
    /* A hub must not be able to reduce what it owes, or what it is owed. */
    if (isHubUser(req)) {
      return res.status(403).json({ error: 'Credit notes are not available to hub logins.' });
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid credit note' });
    }
    const data = parsed.data;
    const isCustomer = data.party_type === 'customer';

    if (isCustomer && !data.customer_invoice_id) {
      return res.status(400).json({ error: 'A customer credit note needs a customer invoice.' });
    }
    if (!isCustomer && !data.purchase_invoice_id) {
      return res.status(400).json({ error: 'A hub debit note needs a purchase invoice.' });
    }

    // ── Totals, computed here and never trusted from the client ───────────
    const lines = data.items.map(it => {
      const base = r2(num(it.rate) * num(it.quantity));
      const gst  = r2(base * num(it.gst_percent) / 100);
      return { ...it, taxable: base, gst_amount: gst, total_inc_gst: r2(base + gst) };
    });
    const subtotal = r2(lines.reduce((s, l) => s + l.taxable, 0));
    const totalGst = r2(lines.reduce((s, l) => s + l.gst_amount, 0));
    const grand    = r2(subtotal + totalGst);

    if (grand <= 0) {
      return res.status(400).json({ error: 'A credit note must be for more than zero.' });
    }

    await client.query('BEGIN');

    /* Serialise per invoice, so two notes raised at once cannot each pass the
       "does not exceed the invoice" check and jointly break it. */
    const lockKey = isCustomer ? data.customer_invoice_id : data.purchase_invoice_id;
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [isCustomer ? 4 : 5, lockKey]);

    let invoice, alreadyCredited, warning = null;

    if (isCustomer) {
      const inv = await client.query(
        `SELECT ci.id, ci.grand_total, ci.invoice_date, ci.status,
                ci.customer_name, ci.mobile,
                ci.is_b2b, ci.b2b_gst_number, ci.b2b_company_name,
                ci.place_of_supply_code, ci.place_of_supply_name
           FROM customer_invoices ci WHERE ci.id = $1`,
        [data.customer_invoice_id]
      );
      invoice = inv.rows[0];
      if (!invoice) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer invoice not found.' }); }

      const c = await client.query(
        `SELECT COALESCE(SUM(grand_total), 0) AS t FROM credit_notes
          WHERE customer_invoice_id = $1 AND status = 'issued'`,
        [data.customer_invoice_id]
      );
      alreadyCredited = r2(c.rows[0].t);
      warning = lateDeclarationWarning(invoice.invoice_date, data.note_date);
    } else {
      const inv = await client.query(
        `SELECT pi.id, pi.grand_total, pi.hub_id, pi.status
           FROM purchase_invoices pi WHERE pi.id = $1`,
        [data.purchase_invoice_id]
      );
      invoice = inv.rows[0];
      if (!invoice) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase invoice not found.' }); }

      const c = await client.query(
        `SELECT COALESCE(SUM(grand_total), 0) AS t FROM credit_notes
          WHERE purchase_invoice_id = $1 AND status = 'issued'`,
        [data.purchase_invoice_id]
      );
      alreadyCredited = r2(c.rows[0].t);
    }

    /* The one arithmetic rule: total notes may never exceed the invoice. More
       than that is not a credit, it is an invoice in the other direction, and
       it would drive the payable figure negative. */
    const headroom = r2(num(invoice.grand_total) - alreadyCredited);
    if (grand > headroom + 0.011) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `This note is for ₹${grand.toFixed(2)} but only ₹${headroom.toFixed(2)} of the invoice is left to credit` +
               (alreadyCredited > 0 ? ` (₹${alreadyCredited.toFixed(2)} already credited).` : '.'),
      });
    }

    const fy = fyOf(data.note_date);
    const { seq, note_no } = await issueNumber(client, data.party_type, fy);

    /* Place of supply: the invoice's own, resolved the same way the PDF and
       GSTR-1 resolve it, so the note files under the same state as the supply
       it reverses. Anything else splits one transaction across two states. */
    let posCode = null, posName = null;
    if (isCustomer) {
      const company = await loadCompany();
      const pos = resolvePlaceOfSupply(invoice, company);
      posCode = pos.code || null;
      posName = pos.code ? pos.name : null;
    }

    const noteRow = await client.query(
      `INSERT INTO credit_notes
         (note_no, note_fy, note_seq, direction, party_type,
          customer_invoice_id, purchase_invoice_id,
          mobile, customer_name, hub_id,
          note_date, reason, reason_note,
          subtotal_ex_gst, total_gst, grand_total,
          place_of_supply_code, place_of_supply_name,
          is_b2b, b2b_gst_number, b2b_company_name,
          public_token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        note_no, fy, seq, isCustomer ? 'credit' : 'debit', data.party_type,
        isCustomer ? invoice.id : null,
        isCustomer ? null : invoice.id,
        isCustomer ? invoice.mobile : null,
        isCustomer ? invoice.customer_name : null,
        isCustomer ? null : invoice.hub_id,
        data.note_date, data.reason, data.reason_note || null,
        subtotal.toFixed(2), totalGst.toFixed(2), grand.toFixed(2),
        posCode, posName,
        isCustomer ? !!invoice.is_b2b : false,
        isCustomer ? invoice.b2b_gst_number : null,
        isCustomer ? invoice.b2b_company_name : null,
        generatePublicToken(),
        req.user?.id || null,
      ]
    );
    const noteId = noteRow.rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO credit_note_items
           (credit_note_id, customer_invoice_item_id, purchase_invoice_item_id,
            item_type, description, hsn_sac, quantity, rate,
            gst_percent, gst_amount, total_inc_gst)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [noteId,
         isCustomer ? (l.customer_invoice_item_id || null) : null,
         isCustomer ? null : (l.purchase_invoice_item_id || null),
         l.item_type, l.description, l.hsn_sac || null,
         l.quantity, l.rate, l.gst_percent,
         l.gst_amount.toFixed(2), l.total_inc_gst.toFixed(2)]
      );
    }

    /* The invoice's payment state changes the moment the note exists: a fully
       paid invoice with a note against it is now overpaid, and that has to
       show up before anyone looks at the ledger. */
    let state = null;
    if (isCustomer) state = await recalcInvoiceState(client, invoice.id);

    await client.query('COMMIT');

    /* After the commit, not inside it, and not awaited — matching every other
       controller. An activity log that cannot be written must never be the
       reason a credit note fails to save. */
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'credit_note', entityId: noteId,
      description: `Issued ${note_no} for ₹${grand.toFixed(2)} against ` +
        (isCustomer ? `CI-${String(invoice.id).padStart(6, '0')}` : `PI-${String(invoice.id).padStart(6, '0')}`) +
        ` (${data.reason})`,
    });
    res.status(201).json({ id: noteId, note_no, grand_total: grand, invoice_state: state, warning });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
    next(err);
  } finally {
    client.release();
  }
}

// =====================================================================
// POST /api/credit-notes/:id/cancel
// =====================================================================
async function cancelCreditNote(req, res, next) {
  const client = await pool.connect();
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });

    const id = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation needs a reason.' });

    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, note_no, status, customer_invoice_id FROM credit_notes WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const note = r.rows[0];
    if (!note) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Credit note not found.' }); }
    if (note.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already cancelled.' }); }

    /* Cancelled, not deleted, and it keeps its number. The row stays as the
       record that a note was raised and withdrawn — which is exactly what an
       officer asking about a gap in the series wants to see. */
    await client.query(
      `UPDATE credit_notes
          SET status='cancelled', cancelled_by=$1, cancelled_at=NOW(),
              cancel_reason=$2, updated_at=NOW()
        WHERE id=$3`,
      [req.user?.id || null, reason, id]
    );

    let state = null;
    if (note.customer_invoice_id) state = await recalcInvoiceState(client, note.customer_invoice_id);

    await client.query('COMMIT');

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'UPDATE', entity: 'credit_note', entityId: id,
      description: `Cancelled ${note.note_no}: ${reason}`,
    });
    res.json({ ok: true, invoice_state: state });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
}

// =====================================================================
// GET /api/credit-notes
// =====================================================================
async function listCreditNotes(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });

    const { party_type, customer_invoice_id, purchase_invoice_id, mobile, hub_id, from, to, status } = req.query;
    const where = [], params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

    if (party_type)          add('cn.party_type = $?', party_type);
    if (customer_invoice_id) add('cn.customer_invoice_id = $?', Number(customer_invoice_id));
    if (purchase_invoice_id) add('cn.purchase_invoice_id = $?', Number(purchase_invoice_id));
    if (mobile)              add('cn.mobile = $?', String(mobile));
    if (hub_id)              add('cn.hub_id = $?', Number(hub_id));
    if (from)                add('cn.note_date >= $?::date', from);
    if (to)                  add('cn.note_date <= $?::date', to);
    if (status)              add('cn.status = $?', status);

    const rows = await pool.query(
      `SELECT cn.*,
              CASE WHEN cn.customer_invoice_id IS NOT NULL
                   THEN 'CI-' || lpad(cn.customer_invoice_id::text, 6, '0')
                   ELSE 'PI-' || lpad(cn.purchase_invoice_id::text, 6, '0') END AS against,
              h.hub_name,
              u.name AS created_by_name
         FROM credit_notes cn
         LEFT JOIN hubs  h ON h.id = cn.hub_id
         LEFT JOIN users u ON u.id = cn.created_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY cn.note_date DESC, cn.id DESC
        LIMIT 500`,
      params
    );
    res.json({ items: rows.rows });
  } catch (err) { next(err); }
}

// =====================================================================
// GET /api/credit-notes/:id
// =====================================================================
async function getCreditNote(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });

    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT cn.*,
              CASE WHEN cn.customer_invoice_id IS NOT NULL
                   THEN 'CI-' || lpad(cn.customer_invoice_id::text, 6, '0')
                   ELSE 'PI-' || lpad(cn.purchase_invoice_id::text, 6, '0') END AS against,
              h.hub_name, u.name AS created_by_name
         FROM credit_notes cn
         LEFT JOIN hubs h  ON h.id = cn.hub_id
         LEFT JOIN users u ON u.id = cn.created_by
        WHERE cn.id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Credit note not found.' });

    const items = await pool.query(
      `SELECT * FROM credit_note_items WHERE credit_note_id = $1 ORDER BY id`, [id]
    );
    res.json({ item: { ...r.rows[0], items: items.rows } });
  } catch (err) { next(err); }
}

module.exports = {
  createCreditNote, cancelCreditNote, listCreditNotes, getCreditNote,
  // exported for tests and for the GSTR-1 controller's Table 9B
  fyOf, formatNoteNo, lateDeclarationWarning,
};
