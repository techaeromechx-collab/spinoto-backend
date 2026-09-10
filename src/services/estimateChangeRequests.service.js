'use strict';

/**
 * estimateChangeRequests.service.js
 * ═══════════════════════════════════════════════════════════════════════════
 * A hub's proposed edit to an estimate, held until a Spinoto user decides.
 *
 * WHY THIS EXISTS
 * ───────────────
 * updateEstimate applied a hub's edit immediately and left the invoices behind,
 * because both sync endpoints are staff-only. Nothing was logged, nobody was
 * notified, and no screen showed the mismatch — so a hub changing a ₹10
 * discount to ₹30 left the estimate at ₹962.60 and the customer invoice at
 * ₹986.00, permanently and silently, and the customer was billed the old
 * figure. See migration 180 for the full account.
 *
 * WHY A SERVICE AND NOT JUST A CONTROLLER
 * ───────────────────────────────────────
 * Two callers reach this logic — updateEstimate (raising a request instead of
 * writing) and the review endpoints (deciding one) — and they must agree about
 * what a request contains and what "apply" means. The estimate/invoice pair in
 * this system has already been bitten once by the same rule living in two
 * places; estimateApproval.service.js was extracted for exactly that reason and
 * its header says so.
 */

const { pool } = require('../config/db');
const { applyTransactionDiscount } = require('../utils/transactionDiscount');
const { getRoundingFunction } = require('../utils/math');
const { getDiscountBasis } = require('../utils/discountBasis');
const { sendPush } = require('../utils/sendPush');
const { isNotificationEnabled } = require('../utils/notificationPrefs');

const NOTIF_TYPE_REQUESTED = 'estimate_change_requested';
const NOTIF_TYPE_DECIDED   = 'estimate_change_decided';

/** ₹1,234.56 — matching how every other notification in this codebase writes money. */
function inr(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * What the estimate and its invoices are worth RIGHT NOW.
 *
 * Read in one query rather than three so the three figures are from the same
 * instant — a reviewer comparing "before" against "after" must not be shown a
 * before that was assembled while something else was moving.
 */
async function readTotals(db, estimateId) {
  const r = await db.query(
    `SELECT
       e.id                              AS estimate_id,
       e.discount_mode,
       e.transaction_discount_type,
       e.transaction_discount_value,
       (SELECT COALESCE(SUM(ei.total_inc_gst), 0) FROM estimate_items ei
         WHERE ei.estimate_id = e.id AND ei.customer_approved IS DISTINCT FROM FALSE) AS estimate_total,
       ci.id            AS ci_id,
       ci.grand_total   AS ci_total,
       ci.status        AS ci_status,
       pi.id            AS pi_id,
       pi.grand_total   AS pi_total,
       pi.status        AS pi_status,
       COALESCE(pi.amount_paid, 0) AS pi_paid
     FROM estimates e
     LEFT JOIN customer_invoices ci ON ci.estimate_id = e.id
     LEFT JOIN LATERAL (
       SELECT id, grand_total, status, amount_paid FROM purchase_invoices
        WHERE estimate_id = e.id ORDER BY id DESC LIMIT 1
     ) pi ON TRUE
     WHERE e.id = $1`,
    [estimateId]
  );
  return r.rows[0] || null;
}

/**
 * What the estimate WOULD total if this payload were applied.
 *
 * Only the transaction discount is modelled, and only when the payload actually
 * changes it. That is deliberate rather than lazy: this figure is for the
 * notification line and the review header, and a number that is *sometimes*
 * a real preview and sometimes a guess is worse than one that is honestly
 * absent. Item edits return null here and the review screen says
 * "recalculated on approval" instead of inventing a total.
 *
 * The real numbers are always produced by the same pricing code the invoices
 * use, at apply time — never from this.
 */
async function previewTotal(db, estimateId, payload, current) {
  const touchesDiscount =
    payload.discount_mode !== undefined ||
    payload.transaction_discount_type !== undefined ||
    payload.transaction_discount_value !== undefined;

  if (!touchesDiscount || payload.items !== undefined) return null;

  const mode  = payload.discount_mode ?? current.discount_mode ?? 'none';
  const dType = payload.transaction_discount_type ?? current.transaction_discount_type ?? null;
  const dVal  = payload.transaction_discount_value !== undefined
    ? Number(payload.transaction_discount_value)
    : Number(current.transaction_discount_value || 0);

  /* EXACTLY the rows the sync handlers bill.
   *
   * Both syncFromEstimate handlers select
   *     customer_approved = TRUE AND work_status = 'completed'
   * and a preview drawn from a wider set would quote the reviewer a figure the
   * approval then does not produce — the reviewer would approve ₹962.60 and the
   * invoice would come out at something else. A preview that can disagree with
   * the apply is worse than no preview. */
  const items = await db.query(
    `SELECT customer_rate, quantity, gst_percent FROM estimate_items
      WHERE estimate_id = $1 AND customer_approved = TRUE AND work_status = 'completed'`,
    [estimateId]
  );
  if (!items.rowCount) return null;

  /* roundFn is keyed on the estimate's created_at, not on today. utils/math.js
   * exists because a document must reprint identically for ever; handing this
   * one today's rule would preview a total the apply — which uses created_at —
   * would not produce. */
  const meta = await db.query(`SELECT created_at FROM estimates WHERE id = $1`, [estimateId]);
  const roundFn = getRoundingFunction(meta.rows[0]?.created_at);

  const calc = applyTransactionDiscount({
    items: items.rows,
    discountType:  mode === 'transaction' ? dType : null,
    discountValue: mode === 'transaction' ? dVal : 0,
    roundFn,
    // Same rule the approval will apply, read from the same created_at.
    basis: getDiscountBasis(meta.rows[0]?.created_at),
    /* customer_rate is the ex-GST, PRE-discount unit rate (the estimate screen
     * says so in its own comment). The helper's default extractor reads
     * total_inc_gst − gst_amount, which these rows do not carry, so it is
     * given explicitly rather than silently evaluating to zero.
     *
     * incOf is given for the same reason and MUST be given alongside it: the
     * default reads total_inc_gst, which on these rows is the value after any
     * line-item discount — a different figure from the pre-discount ex-GST
     * above, and mixing the two would mis-apportion the split. */
    exGstOf: it => roundFn(Number(it.customer_rate || 0) * Number(it.quantity || 1)),
    incOf:   it => roundFn(Number(it.customer_rate || 0) * Number(it.quantity || 1)
                           * (1 + Number(it.gst_percent || 0) / 100)),
    rateOf:  it => Number(it.gst_percent || 0),
  });
  return calc.grandTotal;
}

/**
 * One human sentence describing the proposal, written once and stored.
 *
 * Stored rather than regenerated because it is what the NOTIFICATION said, and
 * a notification whose wording no longer matches the row it links to is worse
 * than none — the reader stops trusting both.
 */
function describe(payload, current) {
  const bits = [];

  const wasType = current.transaction_discount_type;
  const wasVal  = Number(current.transaction_discount_value || 0);
  const newType = payload.transaction_discount_type ?? wasType;
  const newVal  = payload.transaction_discount_value !== undefined
    ? Number(payload.transaction_discount_value) : wasVal;

  const fmtDisc = (t, v) => (t === 'percent' ? `${v}%` : inr(v));

  if (payload.discount_mode !== undefined && payload.discount_mode !== current.discount_mode) {
    bits.push(`Discount mode ${current.discount_mode || 'none'} → ${payload.discount_mode}`);
  }
  if (newVal !== wasVal || (payload.transaction_discount_type !== undefined && newType !== wasType)) {
    bits.push(`Discount ${fmtDisc(wasType, wasVal)} → ${fmtDisc(newType, newVal)}`);
  }
  if (payload.items !== undefined)  bits.push('Line items changed');
  if (payload.notes !== undefined)  bits.push('Notes changed');
  if (payload.is_b2b !== undefined || payload.b2b_company_name !== undefined
      || payload.b2b_gst_number !== undefined || payload.b2b_address !== undefined) {
    bits.push('Billing details changed');
  }
  if (payload.hub_id !== undefined) bits.push('Hub reassignment requested');

  return bits.length ? bits.join(' · ') : 'Estimate details changed';
}

/**
 * Which Spinoto users should hear about this.
 *
 * Staff only — `hub_id IS NULL` — because the point of the request is that a
 * hub cannot decide it. Narrowed to people who could actually act: super
 * admins, or holders of a permission that lets them approve or edit invoices.
 * Notifying everyone would train the whole company to ignore the bell.
 */
async function reviewerIds(db) {
  const r = await db.query(
    `SELECT DISTINCT u.id
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
      WHERE u.hub_id IS NULL
        AND u.is_active = TRUE
        AND (u.is_super_admin = TRUE
             OR up.permission_code IN ('APPROVE_ESTIMATE','EDIT_ESTIMATE','EDIT_INVOICE'))`
  );
  return r.rows.map(x => x.id);
}

/** Insert + push, respecting each user's own notification toggle. Never throws. */
async function notify(db, userIds, type, title, body, url) {
  for (const uid of userIds) {
    try {
      if (await isNotificationEnabled(db, uid, type)) {
        await db.query(
          `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)`,
          [uid, type, title, body]
        );
      }
      sendPush(uid, type, title, body, url);
    } catch (err) {
      // A notification failure must never fail the request it describes — the
      // same rule hubNotify.js states and for the same reason.
      console.error('[estimateChangeRequests] notify failed:', err.message);
    }
  }
}

/**
 * Raise (or replace) the pending request for an estimate.
 *
 * Replace, not queue: a hub that edits twice before anyone looks should leave
 * the LATEST proposal standing. Approving a stale first request would apply
 * figures the hub has already moved past. Migration 180's partial unique index
 * enforces that; this function is what keeps it satisfied, and both run inside
 * one transaction so a concurrent second submit cannot slip between the
 * supersede and the insert.
 */
async function raiseRequest({ estimateId, user, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await readTotals(client, estimateId);
    if (!current) {
      const e = new Error('Estimate not found');
      e.status = 404;
      throw e;
    }

    const estRow = await client.query(`SELECT hub_id FROM estimates WHERE id = $1`, [estimateId]);
    const hubId = estRow.rows[0]?.hub_id || null;

    const after = await previewTotal(client, estimateId, payload, current);
    const summary = describe(payload, current);

    const before_totals = {
      estimate: Number(current.estimate_total || 0),
      customer_invoice: current.ci_id
        ? { id: current.ci_id, total: Number(current.ci_total || 0), status: current.ci_status } : null,
      purchase_invoice: current.pi_id
        ? { id: current.pi_id, total: Number(current.pi_total || 0), status: current.pi_status } : null,
      discount_mode: current.discount_mode,
      transaction_discount_type: current.transaction_discount_type,
      transaction_discount_value: Number(current.transaction_discount_value || 0),
    };
    const after_totals = after == null ? { estimate: null } : { estimate: after };

    // Mark any standing proposal superseded FIRST, inside this transaction.
    const superseded = await client.query(
      `UPDATE estimate_change_requests
          SET status = 'superseded', updated_at = NOW()
        WHERE estimate_id = $1 AND status = 'pending'
      RETURNING id`,
      [estimateId]
    );

    const ins = await client.query(
      `INSERT INTO estimate_change_requests
         (estimate_id, hub_id, payload, before_totals, after_totals, summary, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [estimateId, hubId, JSON.stringify(payload), JSON.stringify(before_totals),
       JSON.stringify(after_totals), summary, user?.id || null]
    );

    await client.query('COMMIT');

    const row = ins.rows[0];
    const money = after != null && current.ci_total != null
      ? ` — ${inr(current.ci_total)} → ${inr(after)}`
      : '';
    const title = `Change request on EST-${String(estimateId).padStart(6, '0')}`;
    const body  = `${user?.name || 'A hub'} · ${summary}${money}`;

    // Outside the transaction: notifying is not part of the record, and a
    // slow push must not hold a database connection open.
    const ids = await reviewerIds(pool);
    await notify(pool, ids, NOTIF_TYPE_REQUESTED, title, body, `/estimates?change_request=${row.id}`);

    return { request: row, replaced: superseded.rows[0]?.id || null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Can this request actually be applied? Asked BEFORE anything is written.
 *
 * The estimate update and the two invoice syncs are each their own transaction
 * today, so "all three or nothing" is not something a single BEGIN can promise
 * without surgery on three money-handling functions at once. Checking the real
 * failure conditions up front is what makes that acceptable: a paid invoice, a
 * missing one, a request whose estimate has moved on. Those are the reasons a
 * sync refuses, and catching them here means the apply either does not start or
 * runs with nothing left to refuse it.
 *
 * Returns { ok, reasons[] }. Reasons are shown to the reviewer verbatim, so
 * they are written for a person, not a log.
 */
async function preflight(db, estimateId) {
  const t = await readTotals(db, estimateId);
  const reasons = [];
  if (!t) return { ok: false, reasons: ['That estimate no longer exists.'], totals: null };

  if (t.ci_id && t.ci_status === 'paid') {
    reasons.push(`Customer Invoice CI-${String(t.ci_id).padStart(6, '0')} is already paid — its amount cannot be changed.`);
  }
  if (t.pi_id && Number(t.pi_paid) > 0) {
    reasons.push(`Spinoto Invoice PI-${String(t.pi_id).padStart(6, '0')} already has ${inr(t.pi_paid)} paid against it — its amount cannot be changed.`);
  }
  return { ok: reasons.length === 0, reasons, totals: t };
}

module.exports = {
  raiseRequest,
  preflight,
  readTotals,
  describe,
  reviewerIds,
  notify,
  inr,
  NOTIF_TYPE_REQUESTED,
  NOTIF_TYPE_DECIDED,
};
