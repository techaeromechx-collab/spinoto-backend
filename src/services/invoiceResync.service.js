'use strict';
const { pool } = require('../config/db');

/**
 * invoiceResync.service.js — put the invoices back in step with the estimate.
 *
 * ══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 *
 * Both invoices choose their lines with one rule:
 *
 *     customer_approved = true AND work_status = 'completed'
 *
 * but they choose them ONCE, when they are generated, and store the result.
 * Change a decision afterwards and the estimate moves while the invoices stay
 * where they were.
 *
 * That produced this, on a real job:
 *
 *     estimate          CI-000087 bills        PI bills
 *     ─────────────────────────────────────────────────────────
 *     Compressor  REJECTED   ✓ charged          ✓ ₹449.10 paid
 *     Filter      approved   ✓ charged          ✓
 *     Gas Check   approved   ✓ charged          ✓
 *     Gas Refill  approved   ✗ not charged      ✗
 *
 * The customer was billed for the line he refused, the hub was paid for it, and
 * the work he did approve was on neither document. Both totals still read
 * ₹1,497, because it is three lines of ₹499 whichever three they are — which is
 * the worst version of this: nothing looks wrong.
 *
 * A sync endpoint for each invoice already existed, and a confirm-then-sync
 * modal already existed. The modal was only ever fired from one place: the
 * estimate EDIT form. Recording a decision and moving a work status — the two
 * things that most obviously change what should be billed — offered nothing.
 *
 * ══ WHY IT IS SILENT, AND WHEN IT IS NOT ═══════════════════════════════════
 *
 * Nobody chooses to leave an invoice contradicting its estimate. Asking "shall I
 * make these agree?" is a question with one sensible answer, and a prompt with
 * one sensible answer is a prompt people learn to dismiss.
 *
 * So it syncs on its own while that is safe, and refuses to guess when it is
 * not: a PAID invoice is never touched. Reducing a document somebody has
 * already settled would leave it smaller than the payment recorded against it.
 * That case is reported back and left for a person, because the remedy is a
 * refund or a credit note, not a quieter total.
 *
 * ══ NEVER THROWS ═══════════════════════════════════════════════════════════
 *
 * The caller has already committed the customer's decision. That decision is
 * correct and recorded whether or not the invoices could follow. A failure here
 * is reported in the result — never raised — so a sync problem cannot turn a
 * saved approval into an error the user reads as "it didn't work".
 */

/**
 * Call an Express handler as a function.
 * Same shim as estimate_change_requests.controller, and for the same reason:
 * the sync logic lives in a route handler, and duplicating it to call it from
 * here is how the two copies start disagreeing.
 */
function invoke(fn, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { user, params, body, query, headers: {} };
    let code = 200;
    const res = {
      status(c) { code = c; return res; },
      json(payload) {
        if (code >= 400) {
          reject(Object.assign(new Error(payload?.error || `Failed with ${code}`), { status: code }));
        } else {
          resolve(payload);
        }
      },
    };
    try { fn(req, res, reject); } catch (err) { reject(err); }
  });
}

/**
 * @param {number} estimateId
 * @param {object} user  the SESSION user — a sync runs with their authority,
 *                       never anonymously. The public approval link has no
 *                       session, so it passes the estimate's owner instead.
 * @returns {Promise<{ pi: Outcome, ci: Outcome, changed: boolean, blocked: string[] }>}
 *          Outcome: 'synced' | 'none' | 'skipped_paid' | 'failed'
 */
async function resyncInvoicesForEstimate(estimateId, user) {
  const out = { pi: 'none', ci: 'none', changed: false, blocked: [] };
  if (!estimateId) return out;

  let rows;
  try {
    // amount_paid for the PI and status for the CI, because that is what each
    // sync endpoint itself refuses on. Asking the same question here means the
    // skip is reported as a skip rather than surfacing as a failure.
    const r = await pool.query(
      `SELECT
         (SELECT pi.id           FROM purchase_invoices pi WHERE pi.estimate_id = $1 ORDER BY pi.id DESC LIMIT 1) AS pi_id,
         (SELECT pi.amount_paid  FROM purchase_invoices pi WHERE pi.estimate_id = $1 ORDER BY pi.id DESC LIMIT 1) AS pi_paid,
         (SELECT ci.id           FROM customer_invoices ci WHERE ci.estimate_id = $1 ORDER BY ci.id DESC LIMIT 1) AS ci_id,
         (SELECT ci.status       FROM customer_invoices ci WHERE ci.estimate_id = $1 ORDER BY ci.id DESC LIMIT 1) AS ci_status`,
      [estimateId]
    );
    rows = r.rows[0] || {};
  } catch (err) {
    console.error(`[invoiceResync] est #${estimateId} lookup failed:`, err.message);
    return out;
  }

  // ── Hub's invoice ────────────────────────────────────────────────────────
  if (rows.pi_id) {
    if (parseFloat(rows.pi_paid || 0) > 0) {
      out.pi = 'skipped_paid';
      out.blocked.push(`PI-${String(rows.pi_id).padStart(6, '0')} has a payment against it`);
    } else {
      try {
        const { syncPurchaseInvoiceFromEstimate } = require('../controllers/purchase_invoices.controller');
        await invoke(syncPurchaseInvoiceFromEstimate, { user, params: { id: String(rows.pi_id) } });
        out.pi = 'synced'; out.changed = true;
      } catch (err) {
        out.pi = 'failed';
        out.blocked.push(`PI: ${err.message}`);
        console.error(`[invoiceResync] PI #${rows.pi_id} sync failed:`, err.message);
      }
    }
  }

  // ── Customer's invoice ───────────────────────────────────────────────────
  if (rows.ci_id) {
    if (rows.ci_status === 'paid') {
      out.ci = 'skipped_paid';
      out.blocked.push(`CI-${String(rows.ci_id).padStart(6, '0')} is already paid`);
    } else {
      try {
        const { syncCustomerInvoiceFromEstimate } = require('../controllers/customer_invoices.controller');
        await invoke(syncCustomerInvoiceFromEstimate, { user, params: { id: String(rows.ci_id) } });
        out.ci = 'synced'; out.changed = true;
      } catch (err) {
        out.ci = 'failed';
        out.blocked.push(`CI: ${err.message}`);
        console.error(`[invoiceResync] CI #${rows.ci_id} sync failed:`, err.message);
      }
    }
  }

  return out;
}

/** One sentence for a toast. Null when there is nothing worth saying. */
function describeResync(r) {
  if (!r) return null;
  const did = [r.pi === 'synced' && 'the hub invoice', r.ci === 'synced' && 'the customer invoice'].filter(Boolean);
  const parts = [];
  if (did.length) parts.push(`Updated ${did.join(' and ')}.`);
  if (r.blocked.length) parts.push(`Not updated — ${r.blocked.join('; ')}.`);
  return parts.length ? parts.join(' ') : null;
}

module.exports = { resyncInvoicesForEstimate, describeResync };
