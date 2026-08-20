'use strict';

/**
 * PUBLIC estimate approval — the page a customer reaches from their WhatsApp
 * link, and the endpoint that records what they decided.
 *
 * ── Read the header of public.documents.controller.js first ─────────────────
 *
 * Same rule, and it matters more here. **Never reuse the internal estimate
 * select.** An estimate carries hub rates and commission — what Spinoto PAYS
 * the hub — and the difference between that and the customer rate is the margin
 * on the job. The payload below is built field by field so that adding a column
 * to the admin query next year cannot leak it, rather than filtered afterwards,
 * which fails open.
 *
 * ── Why this is not just another public document route ──────────────────────
 *
 * The invoice route serves a PDF: read-only, nothing to get wrong. This one
 * authorises work and money. A customer tapping Approve commits to a price, so
 * three things the invoice route did not need:
 *
 *   1. A second factor — the last 4 digits of the mobile the estimate belongs
 *      to. The realistic threat is not someone brute-forcing a 14-character
 *      token; it is the link being forwarded into a family group chat and the
 *      wrong person tapping Approve.
 *   2. A one-way transition guarded in SQL, so two taps cannot both win.
 *   3. Evidence — who, when, from where.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { resolveTokenToId } = require('../utils/publicToken');
const { toNational } = require('../utils/phone');
const { sendPush } = require('../utils/sendPush');
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
const { applyItemApprovals } = require('../services/estimateApproval.service');
const { fireWhatsAppEventDetached } = require('../services/whatsappAutomations.service');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

/**
 * The allowlist.
 *
 * Absent on purpose, and none of it should ever be added: hub_id, hub_rate,
 * commission_percent, total_payable, purchase_invoice_id, and every *_token
 * belonging to another entity.
 */
const PUBLIC_ESTIMATE = `
  SELECT
    e.id, e.public_token, e.status,
    -- Needed to cancel the booking when a customer refuses every line. NOT
    -- returned to the browser — the response below is built field by field and
    -- this one is not in it.
    e.appointment_id,
    e.estimate_date::text AS estimate_date,
    e.created_at,
    COALESCE(e.customer_name, a.customer_name) AS customer_name,
    COALESCE(e.mobile,        a.mobile)        AS mobile,
    COALESCE(e.vehicle_number, a.vehicle_number) AS vehicle_number,
    mk.name AS make_name,
    md.name AS model_name,
    e.subtotal_ex_gst, e.total_gst, e.grand_total,
    e.notes,
    e.decision_source, e.decided_at, e.decision_comment, e.decision_expires_at,
    h.map_url AS hub_map_url,
    ('Spinoto ' || ar.name) AS hub_name
  FROM estimates e
  LEFT JOIN appointments   a  ON a.id = e.appointment_id
  LEFT JOIN hubs           h  ON h.id = e.hub_id
  LEFT JOIN areas          ar ON ar.id = h.area_id
  LEFT JOIN vehicle_makes  mk ON mk.id = COALESCE(a.make_id, e.make_id)
  LEFT JOIN vehicle_models md ON md.id = COALESCE(a.model_id, e.model_id)
  WHERE e.id = $1
`;

/** Line items — what the customer pays, never what the hub is paid. */
async function publicItems(estimateId) {
  const r = await pool.query(
    `SELECT ei.id, ei.item_type, ei.description, ei.quantity,
            ei.customer_rate, ei.gst_percent, ei.gst_amount,
            ei.discount_amount, ei.total_inc_gst,
            -- The decision state, so the page can show what is already
            -- settled rather than presenting a fresh choice on an estimate
            -- somebody has already answered. Still no hub rate and no
            -- commission: those are what Spinoto PAYS the hub, and the gap
            -- between them and customer_rate is the margin on the job.
            ei.customer_approved
       FROM estimate_items ei
      WHERE ei.estimate_id = $1
      ORDER BY ei.id`,
    [estimateId]
  );
  return r.rows;
}

/** Never return the customer's own number — only whether a guess matched it. */
function last4Matches(mobile, supplied) {
  const real = toNational(mobile);
  const given = String(supplied || '').replace(/\D/g, '');
  if (!real || given.length !== 4) return false;
  return real.slice(-4) === given;
}

/**
 * Which estimates a customer may download.
 *
 * Everything from "Spinoto has sent it" onward, including the states that come
 * after a decision — a customer reopening the link to check what they agreed to
 * is the common case, and a dead link there is a support call. Excluded:
 * 'draft' and 'pending_company_review', which are prices nobody has approved.
 */
const DOWNLOADABLE_STATUSES = new Set([
  'sent_to_customer', 'partially_approved', 'fully_approved',
  'work_in_progress', 'work_completed',
]);

/**
 * 'sent_to_customer', not 'submitted'.
 *
 * 'submitted' is not a value estimates.status can hold. The CHECK constraint
 * (migration 052) allows: draft, pending_company_review, sent_to_customer,
 * partially_approved, fully_approved, revision_requested, work_in_progress,
 * work_completed. So this guard rejected EVERY estimate as 'not_pending' and no
 * customer could ever approve one.
 *
 * The right value is the one companyApprove writes — an estimate reaches the
 * customer only after Spinoto has reviewed the hub's pricing, and
 * 'pending_company_review' must stay undecidable.
 */
function decidable(row) {
  if (row.status !== 'sent_to_customer') return { ok: false, reason: 'not_pending' };
  if (row.decision_source)        return { ok: false, reason: 'already_decided' };
  if (row.decision_expires_at && new Date(row.decision_expires_at) < new Date()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

async function loadByToken(token) {
  if (!token || token.length > 20) return null;
  const id = await resolveTokenToId(pool, 'estimates', token);
  if (!id) return null;
  const r = await pool.query(PUBLIC_ESTIMATE, [id]);
  return r.rows[0] || null;
}

/**
 * GET /api/public/estimates/:token
 *
 * Loads WITHOUT the second factor. Seeing your own estimate is not the risky
 * act — committing to it is. Requiring four digits just to look would push
 * people to give up before they read the price.
 */
async function getPublicEstimate(req, res, next) {
  try {
    const row = await loadByToken(String(req.params.token || ''));
    if (!row) return res.status(404).json({ error: 'Estimate not found' });

    res.set('Cache-Control', 'private, no-store');

    const d = decidable(row);
    res.json({
      estimate: {
        number: row.id,
        // Safe to return: it is the customer's own estimate and the page uses
        // it to say what happened ("approved and booked in", "being reviewed")
        // instead of the useless "no longer awaiting your approval". It carries
        // no pricing or hub information.
        status: row.status,
        date: row.estimate_date || row.created_at,
        customer_name: row.customer_name,
        vehicle: [row.make_name, row.model_name].filter(Boolean).join(' ') || null,
        vehicle_number: row.vehicle_number,
        hub_name: row.hub_name,
        hub_map_url: row.hub_map_url,
        subtotal_ex_gst: row.subtotal_ex_gst,
        total_gst: row.total_gst,
        grand_total: row.grand_total,
        notes: row.notes,
      },
      items: await publicItems(row.id),
      // Drives the whole page: buttons, or a message explaining why not.
      decision: {
        can_decide: d.ok,
        blocked_reason: d.ok ? null : d.reason,
        source: row.decision_source,
        decided_at: row.decided_at,
        comment: row.decision_comment,
        expires_at: row.decision_expires_at,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Per ITEM, not per estimate.
 *
 * The old shape was `{ decision: 'approved' | 'rejected' }` for the whole
 * quote. That was wrong twice over: it wrote its word straight into
 * estimates.status — a value the CHECK constraint does not allow, so every
 * submission 500'd — and it never touched estimate_items at all, so even a
 * "successful" approval left every line undecided and nothing entered the
 * workshop's queue.
 *
 * Same shape the staff endpoint takes, because both now run the same service.
 */
const decisionSchema = z.object({
  approvals: z.array(z.object({
    item_id:  z.coerce.number().int().positive(),
    approved: z.boolean(),
  })).min(1, 'Choose what you would like us to do'),
  last4: z.string().trim().length(4, 'Enter the last 4 digits of your mobile number'),
  comment: z.string().trim().max(1000).optional().nullable(),
});

/**
 * POST /api/public/estimates/:token/decision
 */
async function decidePublicEstimate(req, res, next) {
  try {
    const d = decisionSchema.parse(req.body || {});
    const row = await loadByToken(String(req.params.token || ''));
    if (!row) return res.status(404).json({ error: 'Estimate not found' });

    if (!last4Matches(row.mobile, d.last4)) {
      // Same message whatever went wrong. Distinguishing "wrong digits" from
      // "no number on file" would turn this into an oracle for probing whose
      // estimate a token belongs to.
      return res.status(403).json({ error: "Those digits don't match our records." });
    }

    const gate = decidable(row);
    if (!gate.ok) {
      return res.status(409).json({
        error: {
          already_decided: 'This estimate has already been answered.',
          expired: 'This estimate has expired. Please contact us for an updated one.',
          not_pending: 'This estimate is no longer awaiting your approval.',
        }[gate.reason] || 'This estimate cannot be answered.',
        reason: gate.reason,
      });
    }

    // ── Every line must be accounted for ──────────────────────────────────
    //
    // Checked BEFORE anything is written. A payload missing an item would leave
    // that row's customer_approved NULL, and the derivation reads any NULL as
    // "still waiting on the customer" — so the estimate would show as
    // unanswered even though they submitted, and the approved work would never
    // reach the workshop.
    //
    // It also catches the real race: the customer opens the link, staff edit
    // the estimate, the customer submits ids that no longer describe it. Better
    // to ask them to reload than to half-apply a decision.
    const live = await pool.query(
      `SELECT id FROM estimate_items WHERE estimate_id = $1`, [row.id]);
    const liveIds = new Set(live.rows.map(r => r.id));
    const sentIds = new Set(d.approvals.map(a => a.item_id));

    // A foreign id is refused outright, not silently skipped. These arrive in a
    // request body on an UNAUTHENTICATED endpoint; quietly ignoring them would
    // hide an attempt to approve another estimate's lines. (applyItemApprovals
    // also scopes its UPDATE by estimate_id, so nothing could be written — this
    // is so the attempt is visible rather than shrugged off.)
    const foreign = [...sentIds].filter(id => !liveIds.has(id));
    if (foreign.length) {
      return res.status(409).json({
        error: 'This estimate has changed. Please reload the page and try again.',
        reason: 'items_changed',
      });
    }
    if (sentIds.size !== liveIds.size) {
      return res.status(422).json({
        error: 'Please choose yes or no for every line before confirming.',
        reason: 'incomplete',
      });
    }

    // ── One transaction: the items and the status they imply ──────────────
    let result;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The one-way guard stays in SQL, not in an `if` above it. Two taps
      // arriving together would both pass a check-then-write; only one can win
      // a conditional UPDATE. It runs FIRST so a loser writes no items either.
      const claim = await client.query(
        `UPDATE estimates
            SET decision_source = 'customer_link',
                decided_at = NOW(),
                decision_comment = $2,
                decision_ip = $3,
                decision_ua = $4,
                updated_at = NOW()
          WHERE id = $1
            AND status = 'sent_to_customer'
            AND decision_source IS NULL
          RETURNING id`,
        [
          row.id,
          d.comment || null,
          (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
          (req.get('user-agent') || '').slice(0, 500),
        ]
      );
      if (!claim.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This estimate has already been answered.' });
      }

      // The SAME function the staff screen calls. Note it is not handed a
      // status — it derives one from the items, which is why the customer's
      // answer and an advisor's produce identical state.
      result = await applyItemApprovals(client, row.id, d.approvals);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // ── Side effects, after the commit and never thrown ───────────────────
    // The customer's decision is recorded. Neither a cancelled appointment nor
    // a staff notification failing may turn a successful answer into an error
    // on their phone — and unlike staff, they cannot simply retry.
    if (result.allRejected) {
      // Refusing every line means the job is not happening.
      advanceAppointmentStatus(row.appointment_id, 'cancelled').catch(err =>
        console.error('[estimate:decision] appointment cancel failed:', err.message));
    }

    notifyStaff(row, { ...d, decision: result.allRejected ? 'rejected' : 'approved' }).catch(err =>
      console.error('[estimate:decision] notify failed:', err.message));

    // ── "Thank you for approving" ────────────────────────────────────────
    //
    // Only when something was actually approved. An all-rejected estimate is
    // not a job starting, and "we'll begin work" would be the opposite of true.
    //
    // WHY IT IS QUEUED HERE AND NOT FROM A STATUS TRIGGER
    //
    // Migration 128 is the precedent. Settings -> WhatsApp offers an
    // appointment-status trigger for every template, but fireStatusMessages()
    // always loads the APPOINTMENT context, which has no grand_total. An
    // estimate template hung off a status fires, resolves estimate_amount to
    // undefined, and the dispatcher refuses to queue -- every time, while the
    // template looks correctly configured. So the trigger is code, here, where
    // the estimate is the record in hand.
    //
    // manual is left false, so the dispatcher requires auto_send: the second
    // checkbox in Settings -> WhatsApp is what switches this on, and until
    // somebody ticks it this resolves to {queued:false, reason:'auto_send_off'}
    // and nothing reaches the customer.
    if (!result.allRejected) {
      queueApprovalThanks(row.id).catch(err =>
        console.error('[estimate:decision] whatsapp queue failed:', err.message));
    }

    res.json({
      ok: true,
      status: result.status,
      approved_count: result.approved_count,
      rejected_count: result.rejected_count,
      total: result.total,
      // What the page announces back. "3 of 4 approved" is more use to a
      // customer than a status slug they have never seen.
      decision: result.allRejected ? 'rejected' : 'approved',
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: err.errors[0]?.message || 'Invalid input' });
    }
    next(err);
  }
}

/**
 * Notify staff that a customer answered.
 *
 * Without this the feature is half-built: the estimate flips status and nobody
 * finds out until someone happens to look. A rejection especially is a thing
 * that needs a phone call back, and the customer has just been told "our team
 * will call you to discuss it" — a promise nothing else in the system keeps.
 *
 * Recipients follow the pattern in appointmentReminders.service.js:79-88 —
 * whoever created it, plus the hub's active staff. A Set because on a small
 * team those overlap.
 */
/**
 * Queue the "thank you for approving" WhatsApp message.
 *
 * Its own connection and its own transaction, because the caller's has already
 * COMMITted by the time this runs.
 *
 * Never throws to the caller. The customer's approval is already recorded; a
 * WhatsApp outage must not turn a successful answer into an error on their
 * phone, and unlike staff they cannot simply try again.
 */
async function queueApprovalThanks(estimateId) {
  // Which template(s) fire is the 'estimate.customer_approved' automation rows
  // (migration 151). fireWhatsAppEventDetached owns the connection,
  // transaction and the quiet/loud logging split, and never throws.
  await fireWhatsAppEventDetached(pool, {
    event: 'estimate.customer_approved',
    entityId: estimateId,
    // One per estimate. The claim above already makes a second answer a 409,
    // so this is belt and braces -- but a duplicate "thank you for approving"
    // is the kind of thing a customer screenshots.
    dedupeKey: `approved:${estimateId}`,
  });
}

async function notifyStaff(row, d) {
  const meta = await pool.query(
    `SELECT e.created_by, e.hub_id, a.assigned_to
       FROM estimates e
       LEFT JOIN appointments a ON a.id = e.appointment_id
      WHERE e.id = $1`,
    [row.id]
  );
  const m = meta.rows[0] || {};

  const recipients = new Set();
  if (m.created_by) recipients.add(m.created_by);
  if (m.assigned_to) recipients.add(m.assigned_to);
  if (m.hub_id) {
    const staff = await pool.query(
      `SELECT id FROM users WHERE hub_id = $1 AND is_active = TRUE`, [m.hub_id]
    );
    for (const s of staff.rows) recipients.add(s.id);
  }
  if (!recipients.size) return;

  const approved = d.decision === 'approved';
  const title = approved
    ? `✅ Estimate #${row.id} approved by customer`
    : `❌ Estimate #${row.id} rejected by customer`;
  const body = [
    row.customer_name || row.mobile,
    row.vehicle_number,
    // The reason is the entire point of a rejection notification — putting it
    // in the body means the advisor can pick up the phone already knowing why.
    d.comment ? `— "${d.comment.slice(0, 120)}"` : null,
  ].filter(Boolean).join(' · ');

  for (const userId of recipients) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [userId, approved ? 'estimate_approved' : 'estimate_rejected', title, body]
    ).catch(() => {});
    // Fire-and-forget, and it respects the user's own notification toggles.
    sendPush(userId, approved ? 'estimate_approved' : 'estimate_rejected',
      title, body, '/estimates');
  }
}

/**
 * GET /api/public/documents/estimate-pdf/:token — the printable estimate.
 *
 * Mirrors getPublicCustomerInvoice in public.documents.controller.js, and the
 * reasoning in that file's header applies here unchanged. The differences worth
 * naming:
 *
 *   - It uses PUBLIC_ESTIMATE and publicItems above, NOT the internal estimate
 *     select. An estimate carries hub rates and commission — what Spinoto pays
 *     the hub — and the gap between that and the customer rate is the margin on
 *     the job. Building the row from the same narrow query the page already
 *     uses means there is one definition of "what a customer may see", not two
 *     that can drift.
 *
 *   - A draft is not a quote. Only an estimate Spinoto has reviewed and sent is
 *     downloadable; 'draft' and 'pending_company_review' would hand the customer
 *     a price nobody has approved.
 *
 *   - baseUrl is null, deliberately. On a public request Origin and Referer are
 *     attacker-controlled and qr.js would bake the supplied host into the QR
 *     printed on the customer's own estimate. PUBLIC_APP_URL or no QR.
 */
async function getPublicEstimatePdf(req, res, next) {
  try {
    const token = String(req.params.token || '');
    // public_token is VARCHAR(20) (migration 085) — anything longer cannot
    // match, so it is rejected before it costs a query.
    if (!token || token.length > 20) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Hardcoded table name, never request-derived — publicToken.js requires it,
    // as the value is interpolated into the SQL.
    const id = await resolveTokenToId(pool, 'estimates', token);
    // Same 404 for "no such token" and "malformed token": a distinguishable
    // response turns this into an oracle for probing which tokens are real.
    if (!id) return res.status(404).json({ error: 'Document not found' });

    const r = await pool.query(PUBLIC_ESTIMATE, [id]);
    const estimate = r.rows[0];
    if (!estimate) return res.status(404).json({ error: 'Document not found' });

    // 410, not 404: the customer's link was valid. Telling them the document
    // is not available yet is more use than pretending it never existed.
    if (!DOWNLOADABLE_STATUSES.has(estimate.status)) {
      return res.status(410).json({
        error: 'This estimate is not available yet. Please contact us if you need a copy.',
      });
    }

    // The authenticated PDF routes are protected from intermediary caching by
    // their Authorization header. This one has nothing to vary on, so a CDN or
    // corporate proxy would be free to cache a named customer's estimate and
    // serve it to whoever asked next.
    res.set('Cache-Control', 'private, no-store');

    estimate.items = await publicItems(id);

    const company = await loadCompany();
    // share: true selects auto_share_theme — the look the customer-facing copy
    // is configured to have. user null ⇒ viewerRole 'admin', which for an
    // estimate affects only the title and number prefix; the hub view exists to
    // relabel purchase invoices, which this endpoint cannot serve.
    const { cfg, theme } = resolveRender(company, 'estimate', null, { share: true });

    await sendPdf(res, {
      docType: 'estimate',
      row: estimate,
      company,
      cfg,
      theme,
      baseUrl: null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPublicEstimate, getPublicEstimatePdf, decidePublicEstimate, last4Matches, decidable,
};
