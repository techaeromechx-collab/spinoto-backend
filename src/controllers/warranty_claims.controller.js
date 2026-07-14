'use strict';

/**
 * Warranty Claims controller
 *
 * Claims are registered against a PAID customer invoice line item, validated
 * against the warranty snapshot frozen on that item, and (when approved)
 * spawn a redo job that flows through the normal APT → EST → PI → CI pipeline.
 *
 * Lifecycle: registered → under_review → approved → resolved
 *                              └→ rejected      (pre-approval: → cancelled)
 */

const { z }     = require('zod');
const { pool }  = require('../config/db');
const { getIO } = require('../socket');
const { generateAppointmentCode } = require('../utils/appointmentCode');
const { generatePublicToken, ensureCustomerIdentity } = require('../utils/publicToken');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

// ── Validators ────────────────────────────────────────────────────────────────
const idParam = z.coerce.number().int().positive();

const createClaimSchema = z.object({
  customer_invoice_item_id: z.coerce.number().int().positive(),
  claim_type: z.enum(['warranty', 'guarantee']).optional().default('warranty'),
  claim_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  current_km: z.coerce.number().int().nonnegative().optional().nullable(),
  reason:     z.string().trim().min(3).max(2000),
});

const updateClaimSchema = z.object({
  claim_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  current_km: z.coerce.number().int().nonnegative().optional().nullable(),
  reason:     z.string().trim().min(3).max(2000).optional(),
});

const approveSchema = z.object({
  resolution_type:     z.enum(['free_redo', 'discounted_redo', 'no_action']),
  redo_charge_percent: z.coerce.number().min(0).max(100).optional().default(0),
  cost_bearer:         z.enum(['hub', 'company']),
  confirm_expired:     z.boolean().optional().default(false),
});

const rejectSchema = z.object({
  rejection_reason: z.string().trim().min(3).max(2000),
});

const createRedoSchema = z.object({
  hub_id:         z.coerce.number().int().positive().optional().nullable(),
  scheduled_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'An open claim already exists for this invoice item.' });
    next(err);
  });
}

// ── Shared SELECT ─────────────────────────────────────────────────────────────
const WC_SELECT = `
  SELECT
    wc.*,
    h.hub_name,
    cu.name  AS created_by_name,
    du.name  AS decided_by_name,
    ci.grand_total   AS ci_grand_total,
    ci.public_token  AS ci_public_token,
    ra.appointment_code AS redo_appointment_code,
    ra.public_token     AS redo_appointment_token,
    re.status           AS redo_estimate_status,
    re.public_token     AS redo_estimate_token,
    (SELECT rci.id           FROM customer_invoices rci WHERE rci.estimate_id = wc.redo_estimate_id LIMIT 1) AS redo_customer_invoice_id,
    (SELECT rci.status       FROM customer_invoices rci WHERE rci.estimate_id = wc.redo_estimate_id LIMIT 1) AS redo_customer_invoice_status,
    (SELECT rci.public_token FROM customer_invoices rci WHERE rci.estimate_id = wc.redo_estimate_id LIMIT 1) AS redo_customer_invoice_token,
    (SELECT rpi.id           FROM purchase_invoices rpi WHERE rpi.estimate_id = wc.redo_estimate_id ORDER BY rpi.id DESC LIMIT 1) AS redo_purchase_invoice_id,
    (SELECT rpi.status       FROM purchase_invoices rpi WHERE rpi.estimate_id = wc.redo_estimate_id ORDER BY rpi.id DESC LIMIT 1) AS redo_purchase_invoice_status,
    (SELECT rpi.public_token FROM purchase_invoices rpi WHERE rpi.estimate_id = wc.redo_estimate_id ORDER BY rpi.id DESC LIMIT 1) AS redo_purchase_invoice_token
  FROM warranty_claims wc
  LEFT JOIN hubs  h  ON h.id  = wc.hub_id
  LEFT JOIN users cu ON cu.id = wc.created_by
  LEFT JOIN users du ON du.id = wc.decided_by
  LEFT JOIN customer_invoices ci ON ci.id = wc.customer_invoice_id
  LEFT JOIN appointments ra ON ra.id = wc.redo_appointment_id
  LEFT JOIN estimates    re ON re.id = wc.redo_estimate_id
`;

// ── Warranty validation math ──────────────────────────────────────────────────
// Mirrors the claim rules in WARRANTY_CLAIMS_PLAN.md:
//   time:  claim_date <= service_date + months + days      (NULL if no time limit)
//   km:    current_km − service_odometer_km <= warranty_km (NULL if not checkable)
//   overall: any FALSE → expired; any TRUE (and none FALSE) → valid; else manual
function validateClaim({ warranty_months, warranty_days, warranty_km, service_date, service_odometer_km, claim_date, current_km }) {
  let withinTime = null;
  if (service_date && (warranty_months || warranty_days)) {
    const expiry = new Date(service_date);
    if (warranty_months) expiry.setMonth(expiry.getMonth() + Number(warranty_months));
    if (warranty_days)   expiry.setDate(expiry.getDate() + Number(warranty_days));
    withinTime = new Date(claim_date) <= expiry;
  }

  let withinKm = null;
  if (warranty_km != null && service_odometer_km != null && current_km != null) {
    withinKm = (Number(current_km) - Number(service_odometer_km)) <= Number(warranty_km);
  }

  let validation = 'manual';
  if (withinTime === false || withinKm === false) validation = 'expired';
  else if (withinTime === true || withinKm === true) validation = 'valid';

  return { within_time: withinTime, within_km: withinKm, validation };
}

// Fetch a CI item + its CI header + warranty context for claim registration.
async function loadClaimContext(ciItemId) {
  const r = await pool.query(
    `SELECT
       cii.id            AS ci_item_id,
       cii.description, cii.item_type, cii.quantity, cii.customer_rate,
       cii.gst_percent, cii.hsn_sac, cii.estimate_item_id,
       cii.warranty_months, cii.warranty_days, cii.warranty_km, cii.warranty_text,
       cii.guarantee_months, cii.guarantee_days, cii.guarantee_km, cii.guarantee_text,
       ci.id AS ci_id, ci.status AS ci_status, ci.hub_id, ci.appointment_id, ci.estimate_id,
       ci.customer_name, ci.mobile, ci.vehicle_number, ci.odometer_km AS service_odometer_km,
       COALESCE(
         (SELECT MAX(p.paid_at)::date FROM customer_invoice_payments p WHERE p.customer_invoice_id = ci.id),
         ci.created_at::date
       ) AS service_date
     FROM customer_invoice_items cii
     JOIN customer_invoices ci ON ci.id = cii.customer_invoice_id
     WHERE cii.id = $1`,
    [ciItemId]
  );
  return r.rows[0] || null;
}

// ── LIST ──────────────────────────────────────────────────────────────────────
function listClaims(req, res, next) {
  handle(req, res, next, async () => {
    const status     = req.query.status || null;
    const validation = req.query.validation || null;
    const search     = req.query.search ? `%${req.query.search}%` : null;
    // Hub portal users only ever see their own hub's claims
    let hubId = req.query.hub_id ? parseInt(req.query.hub_id, 10) : null;
    if (req.user.hub_id) hubId = req.user.hub_id;

    const r = await pool.query(
      `${WC_SELECT}
        WHERE ($1::text IS NULL OR wc.status = $1)
          AND ($2::text IS NULL OR wc.validation = $2)
          AND ($3::int  IS NULL OR wc.hub_id = $3)
          AND ($4::text IS NULL OR wc.claim_code ILIKE $4 OR wc.customer_name ILIKE $4
               OR wc.mobile ILIKE $4 OR wc.vehicle_number ILIKE $4 OR wc.item_description ILIKE $4)
        ORDER BY wc.created_at DESC`,
      [status, validation, hubId, search]
    );

    // Status tab counts (unfiltered by the active status filter, like appointments)
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM warranty_claims
        WHERE ($1::int IS NULL OR hub_id = $1)
        GROUP BY status`,
      [hubId]
    );
    const statusCounts = {};
    for (const row of counts.rows) statusCounts[row.status] = row.n;

    res.json({ items: r.rows, status_counts: statusCounts });
  });
}

// ── GET ONE ───────────────────────────────────────────────────────────────────
function getClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${WC_SELECT} WHERE wc.id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Claim not found' });
    if (req.user.hub_id && r.rows[0].hub_id !== req.user.hub_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ item: r.rows[0] });
  });
}

// ── ELIGIBLE ITEMS ────────────────────────────────────────────────────────────
// GET /eligible-items?mobile=…  or  ?customer_invoice_id=…
// Returns paid-CI line items that carry a warranty, each with a live-computed
// validity verdict, so the register modal can show Valid/Expired upfront.
function eligibleItems(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.query.mobile ? req.query.mobile.trim() : null;
    const ciId   = req.query.customer_invoice_id ? parseInt(req.query.customer_invoice_id, 10) : null;
    if (!mobile && !ciId) return res.status(400).json({ error: 'Provide mobile or customer_invoice_id' });

    const r = await pool.query(
      `SELECT
         cii.id AS customer_invoice_item_id,
         cii.description, cii.item_type, cii.total_inc_gst,
         cii.warranty_months, cii.warranty_days, cii.warranty_km, cii.warranty_text,
         cii.guarantee_months, cii.guarantee_days, cii.guarantee_km, cii.guarantee_text,
         ci.id AS customer_invoice_id, ci.customer_name, ci.mobile, ci.vehicle_number,
         ci.hub_id, h.hub_name, ci.odometer_km AS service_odometer_km,
         COALESCE(
           (SELECT MAX(p.paid_at)::date FROM customer_invoice_payments p WHERE p.customer_invoice_id = ci.id),
           ci.created_at::date
         ) AS service_date,
         (SELECT wc.id FROM warranty_claims wc
           WHERE wc.customer_invoice_item_id = cii.id AND wc.claim_type = 'warranty'
             AND wc.status IN ('registered','under_review','approved')
           LIMIT 1) AS open_warranty_claim_id,
         (SELECT wc.id FROM warranty_claims wc
           WHERE wc.customer_invoice_item_id = cii.id AND wc.claim_type = 'guarantee'
             AND wc.status IN ('registered','under_review','approved')
           LIMIT 1) AS open_guarantee_claim_id
       FROM customer_invoice_items cii
       JOIN customer_invoices ci ON ci.id = cii.customer_invoice_id
       LEFT JOIN hubs h ON h.id = ci.hub_id
       WHERE ci.status = 'paid'
         AND ($1::text IS NULL OR ci.mobile = $1)
         AND ($2::int  IS NULL OR ci.id = $2)
         AND (cii.warranty_months IS NOT NULL OR cii.warranty_days IS NOT NULL
              OR cii.warranty_km IS NOT NULL OR cii.warranty_text IS NOT NULL
              OR cii.guarantee_months IS NOT NULL OR cii.guarantee_days IS NOT NULL
              OR cii.guarantee_km IS NOT NULL OR cii.guarantee_text IS NOT NULL)
       ORDER BY ci.id DESC, cii.id`,
      [mobile, ciId]
    );

    const today = new Date().toISOString().slice(0, 10);
    const items = r.rows.map(row => {
      const hasWarranty  = row.warranty_months != null || row.warranty_days != null
                        || row.warranty_km != null || row.warranty_text != null;
      const hasGuarantee = row.guarantee_months != null || row.guarantee_days != null
                        || row.guarantee_km != null || row.guarantee_text != null;
      return {
        ...row,
        has_warranty:  hasWarranty,
        has_guarantee: hasGuarantee,
        // Kept for backward compat with older UI reads
        open_claim_id: row.open_warranty_claim_id || row.open_guarantee_claim_id,
        // Pre-verdicts per type using today's date; km verdict needs
        // current_km at registration time so only time is definitive here.
        precheck: hasWarranty ? validateClaim({ ...row, claim_date: today, current_km: null }) : null,
        precheck_guarantee: hasGuarantee ? validateClaim({
          warranty_months: row.guarantee_months, warranty_days: row.guarantee_days,
          warranty_km: row.guarantee_km, service_date: row.service_date,
          service_odometer_km: row.service_odometer_km, claim_date: today, current_km: null,
        }) : null,
      };
    });
    res.json({ items });
  });
}

// ── CREATE (register) ─────────────────────────────────────────────────────────
function createClaim(req, res, next) {
  handle(req, res, next, async () => {
    const data = createClaimSchema.parse(req.body);
    const ctx  = await loadClaimContext(data.customer_invoice_item_id);

    if (!ctx) return res.status(404).json({ error: 'Customer invoice item not found' });
    if (ctx.ci_status !== 'paid') {
      return res.status(400).json({ error: `Claims can only be registered on PAID invoices (current: ${ctx.ci_status}).` });
    }

    // The claim invokes ONE promise type — pick that type's snapshot fields.
    const isGuarantee = data.claim_type === 'guarantee';
    const promise = isGuarantee
      ? { months: ctx.guarantee_months, days: ctx.guarantee_days, km: ctx.guarantee_km, text: ctx.guarantee_text }
      : { months: ctx.warranty_months,  days: ctx.warranty_days,  km: ctx.warranty_km,  text: ctx.warranty_text };

    const hasPromise = promise.months != null || promise.days != null
                    || promise.km != null || promise.text != null;
    if (!hasPromise) {
      return res.status(400).json({ error: `This invoice item carries no ${data.claim_type}.` });
    }
    if (req.user.hub_id && ctx.hub_id !== req.user.hub_id) {
      return res.status(403).json({ error: 'Hub users can only register claims for their own hub.' });
    }

    const claimDate = data.claim_date || new Date().toISOString().slice(0, 10);
    const verdict = validateClaim({
      warranty_months: promise.months,
      warranty_days:   promise.days,
      warranty_km:     promise.km,
      service_date:    ctx.service_date,
      service_odometer_km: ctx.service_odometer_km,
      claim_date:      claimDate,
      current_km:      data.current_km ?? null,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO warranty_claims
           (customer_invoice_id, customer_invoice_item_id, hub_id,
            customer_name, mobile, vehicle_number, item_description,
            claim_type,
            warranty_months, warranty_days, warranty_km, warranty_text,
            claim_date, current_km, reason,
            service_date, service_odometer_km, within_time, within_km, validation,
            created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          ctx.ci_id, ctx.ci_item_id, ctx.hub_id,
          ctx.customer_name, ctx.mobile, ctx.vehicle_number, ctx.description,
          data.claim_type,
          // The invoked promise's snapshot (warranty OR guarantee fields,
          // stored in the claim's warranty_* columns — claim_type says which)
          promise.months, promise.days, promise.km, promise.text,
          claimDate, data.current_km ?? null, data.reason,
          ctx.service_date, ctx.service_odometer_km,
          verdict.within_time, verdict.within_km, verdict.validation,
          req.user.id,
        ]
      );
      const claimId = ins.rows[0].id;
      // WC- for warranty claims, GC- for guarantee claims
      await client.query(
        `UPDATE warranty_claims SET claim_code = $2 || LPAD($1::text, 5, '0') WHERE id = $1`,
        [claimId, isGuarantee ? 'GC-' : 'WC-']
      );
      await client.query('COMMIT');

      const full = await pool.query(`${WC_SELECT} WHERE wc.id = $1`, [claimId]);
      getIO().emit('invalidate', { topic: 'warranty_claims' });
      res.status(201).json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ── UPDATE (intake fields, pre-decision only) ─────────────────────────────────
function updateClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateClaimSchema.parse(req.body);

    const cur = await pool.query(`SELECT * FROM warranty_claims WHERE id = $1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Claim not found' });
    const claim = cur.rows[0];
    if (!['registered', 'under_review'].includes(claim.status)) {
      return res.status(400).json({ error: `Cannot edit a ${claim.status} claim.` });
    }
    if (req.user.hub_id && claim.hub_id !== req.user.hub_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const claimDate = data.claim_date || (claim.claim_date ? new Date(claim.claim_date).toISOString().slice(0, 10) : null);
    const currentKm = data.current_km !== undefined ? data.current_km : claim.current_km;

    // Re-run validation with merged values
    const verdict = validateClaim({
      warranty_months: claim.warranty_months,
      warranty_days:   claim.warranty_days,
      warranty_km:     claim.warranty_km,
      service_date:    claim.service_date,
      service_odometer_km: claim.service_odometer_km,
      claim_date:      claimDate,
      current_km:      currentKm,
    });

    await pool.query(
      `UPDATE warranty_claims
         SET claim_date = $1, current_km = $2, reason = COALESCE($3, reason),
             within_time = $4, within_km = $5, validation = $6, updated_at = NOW()
       WHERE id = $7`,
      [claimDate, currentKm ?? null, data.reason ?? null,
       verdict.within_time, verdict.within_km, verdict.validation, id]
    );

    const full = await pool.query(`${WC_SELECT} WHERE wc.id = $1`, [id]);
    getIO().emit('invalidate', { topic: 'warranty_claims' });
    res.json({ item: full.rows[0] });
  });
}

// ── STATUS TRANSITIONS ────────────────────────────────────────────────────────
async function _transition(req, res, id, allowedFrom, updates, params) {
  const cur = await pool.query(`SELECT status, validation, hub_id FROM warranty_claims WHERE id = $1`, [id]);
  if (cur.rowCount === 0) { res.status(404).json({ error: 'Claim not found' }); return null; }
  if (!allowedFrom.includes(cur.rows[0].status)) {
    res.status(400).json({ error: `Not allowed from status '${cur.rows[0].status}'.` });
    return null;
  }
  await pool.query(
    `UPDATE warranty_claims SET ${updates}, updated_at = NOW() WHERE id = $${params.length + 1}`,
    [...params, id]
  );
  const full = await pool.query(`${WC_SELECT} WHERE wc.id = $1`, [id]);
  getIO().emit('invalidate', { topic: 'warranty_claims' });
  return full.rows[0];
}

function reviewClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const item = await _transition(req, res, id, ['registered'], `status = 'under_review'`, []);
    if (item) res.json({ item });
  });
}

function approveClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = approveSchema.parse(req.body);

    const cur = await pool.query(`SELECT status, validation FROM warranty_claims WHERE id = $1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Claim not found' });
    if (!['registered', 'under_review'].includes(cur.rows[0].status)) {
      return res.status(400).json({ error: `Not allowed from status '${cur.rows[0].status}'.` });
    }
    // Expired claims can be approved as goodwill — but only with explicit confirmation
    if (cur.rows[0].validation === 'expired' && !data.confirm_expired) {
      return res.status(400).json({
        error: 'This claim is EXPIRED. Pass confirm_expired: true to approve it as a goodwill gesture.',
        requires_confirmation: true,
      });
    }

    const chargePct = data.resolution_type === 'free_redo' ? 0 : (data.redo_charge_percent || 0);
    const item = await _transition(req, res, id, ['registered', 'under_review'],
      `status = 'approved', resolution_type = $1, redo_charge_percent = $2,
       cost_bearer = $3, decided_by = $4, decided_at = NOW(), rejection_reason = NULL`,
      [data.resolution_type, chargePct, data.cost_bearer, req.user.id]);
    if (item) res.json({ item });
  });
}

function rejectClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = rejectSchema.parse(req.body);
    const item = await _transition(req, res, id, ['registered', 'under_review'],
      `status = 'rejected', rejection_reason = $1, decided_by = $2, decided_at = NOW()`,
      [data.rejection_reason, req.user.id]);
    if (item) res.json({ item });
  });
}

function cancelClaim(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const item = await _transition(req, res, id, ['registered', 'under_review'], `status = 'cancelled'`, []);
    if (item) res.json({ item });
  });
}

// ── CREATE REDO JOB ───────────────────────────────────────────────────────────
// One transaction: redo appointment (flagged) + redo estimate with the claimed
// item priced at redo_charge_percent of the original rate. NO warranty is
// stamped on redo items — the original warranty stands; no warranty-on-warranty.
function createRedo(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = createRedoSchema.parse(req.body);

    const claimRow = await pool.query(`SELECT * FROM warranty_claims WHERE id = $1`, [id]);
    if (claimRow.rowCount === 0) return res.status(404).json({ error: 'Claim not found' });
    const claim = claimRow.rows[0];
    if (claim.status !== 'approved') {
      return res.status(400).json({ error: `Redo jobs can only be created for APPROVED claims (current: ${claim.status}).` });
    }
    if (claim.redo_appointment_id || claim.redo_estimate_id) {
      return res.status(409).json({ error: 'A redo job already exists for this claim.' });
    }

    const ctx = await loadClaimContext(claim.customer_invoice_item_id);
    if (!ctx) return res.status(404).json({ error: 'Original invoice item no longer exists.' });

    // Original vehicle context: from the original appointment when there is
    // one, otherwise from the original estimate's standalone columns.
    let veh = {};
    if (ctx.appointment_id) {
      const a = await pool.query(
        `SELECT vehicle_type_id, make_id, model_id, body_type_id, segment_ids, cc_category_id, whatsapp
         FROM appointments WHERE id = $1`, [ctx.appointment_id]);
      veh = a.rows[0] || {};
    } else if (ctx.estimate_id) {
      const e = await pool.query(
        `SELECT vehicle_type_id, make_id, model_id, body_type_id, segment_ids, cc_category_id, whatsapp
         FROM estimates WHERE id = $1`, [ctx.estimate_id]);
      veh = e.rows[0] || {};
    }

    // Original estimate item → service/part ids for the redo line
    let orig = { service_id: null, part_id: null };
    if (ctx.estimate_item_id) {
      const o = await pool.query(
        `SELECT service_id, part_id FROM estimate_items WHERE id = $1`, [ctx.estimate_item_id]);
      orig = o.rows[0] || orig;
    }

    const hubId = data.hub_id || claim.hub_id || null;
    const scheduledDate = data.scheduled_date || new Date().toISOString().slice(0, 10);

    // Default appointment status
    const defStatus = await pool.query(
      `SELECT id FROM appointment_statuses WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`);
    const statusId = defStatus.rows[0]?.id || null;

    const chargePct = parseFloat(claim.redo_charge_percent) || 0;
    const exRate    = Math.round((parseFloat(ctx.customer_rate) || 0) * chargePct) / 100; // pct of original ex-GST rate
    const qty       = parseFloat(ctx.quantity) || 1;
    const gstPct    = parseFloat(ctx.gst_percent) || 0;
    const gstAmount = Math.round(exRate * qty * gstPct) / 100;
    const totalIncGst = Math.round((exRate * qty + gstAmount) * 100) / 100;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Redo appointment
      const apptIns = await client.query(
        `INSERT INTO appointments
           (customer_name, mobile, whatsapp, vehicle_number,
            vehicle_type_id, make_id, model_id, body_type_id, segment_ids, cc_category_id,
            hub_id, scheduled_date, status_id, total_price, notes,
            is_warranty_redo, warranty_claim_id, odometer_km,
            created_by, public_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,TRUE,$15,$16,$17,$18)
         RETURNING id`,
        [
          ctx.customer_name || null, ctx.mobile, veh.whatsapp || null, ctx.vehicle_number || null,
          veh.vehicle_type_id || null, veh.make_id || null, veh.model_id || null,
          veh.body_type_id || null, veh.segment_ids || [], veh.cc_category_id || null,
          hubId, scheduledDate, statusId,
          `Warranty redo for claim ${claim.claim_code} — ${ctx.description}`,
          id, claim.current_km ?? null,
          req.user.id, generatePublicToken(),
        ]
      );
      const redoApptId = apptIns.rows[0].id;

      if (ctx.mobile) await ensureCustomerIdentity(client, ctx.mobile);

      if (hubId) {
        const hubRow = await client.query(`SELECT hub_code FROM hubs WHERE id = $1`, [hubId]);
        const hubCode = hubRow.rows[0]?.hub_code;
        if (hubCode) {
          const code = await generateAppointmentCode(client, { hubId, hubCode });
          await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [code, redoApptId]);
        }
      }

      // 2) Redo estimate (draft — flows through the normal review/approve/work cycle)
      const estIns = await client.query(
        `INSERT INTO estimates
           (appointment_id, hub_id, status, notes, created_by, discount_mode,
            warranty_claim_id, odometer_km, public_token,
            subtotal_ex_gst, total_gst, grand_total)
         VALUES ($1,$2,'draft',$3,$4,'none',$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          redoApptId, hubId,
          `Warranty redo for claim ${claim.claim_code}${chargePct > 0 ? ` (customer pays ${chargePct}%)` : ' (free of charge)'}`,
          req.user.id, id, claim.current_km ?? null, generatePublicToken(),
          (exRate * qty).toFixed(2), gstAmount.toFixed(2), totalIncGst.toFixed(2),
        ]
      );
      const redoEstId = estIns.rows[0].id;

      // 3) Redo line item — NO warranty snapshot on redo items
      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, item_type, service_id, part_id, description,
            quantity, customer_rate, gst_percent, gst_amount, total_inc_gst, hsn_sac)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          redoEstId, ctx.item_type, orig.service_id, orig.part_id,
          // Plain description — the redo marker is shown as a banner on the
          // estimate/invoice (via warranty_claim_id), not inside the item name.
          ctx.description,
          qty, exRate.toFixed(4), gstPct, gstAmount.toFixed(2), totalIncGst.toFixed(2),
          ctx.hsn_sac || null,
        ]
      );

      // 4) Link redo job back to the claim
      await client.query(
        `UPDATE warranty_claims
           SET redo_appointment_id = $1, redo_estimate_id = $2, updated_at = NOW()
         WHERE id = $3`,
        [redoApptId, redoEstId, id]
      );

      await client.query('COMMIT');

      // Mirror the normal estimate-creation status advance (fire-and-forget)
      await advanceAppointmentStatus(redoApptId, 'estimate-created');

      const full = await pool.query(`${WC_SELECT} WHERE wc.id = $1`, [id]);
      getIO().emit('invalidate', { topic: 'warranty_claims' });
      getIO().emit('invalidate', { topic: 'appointments' });
      getIO().emit('invalidate', { topic: 'estimates' });
      res.status(201).json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ── STATS / ANALYTICS ─────────────────────────────────────────────────────────
// GET /api/warranty-claims/stats — summary cards, monthly trend, claim rate by
// service, and per-hub breakdown (incl. who bore the redo cost). Hub users see
// only their own hub's numbers.
function claimStats(req, res, next) {
  handle(req, res, next, async () => {
    let hubId = req.query.hub_id ? parseInt(req.query.hub_id, 10) : null;
    if (req.user.hub_id) hubId = req.user.hub_id;

    // ── Summary ──
    const summary = await pool.query(
      `SELECT
         COUNT(*)::int                                                          AS total,
         COUNT(*) FILTER (WHERE status IN ('registered','under_review','approved'))::int AS open,
         COUNT(*) FILTER (WHERE status = 'resolved')::int                       AS resolved,
         COUNT(*) FILTER (WHERE status = 'rejected')::int                       AS rejected,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int                      AS cancelled,
         COUNT(*) FILTER (WHERE validation = 'expired'
                            AND status IN ('approved','resolved'))::int         AS goodwill_approvals,
         ROUND(AVG(EXTRACT(EPOCH FROM decided_at - created_at) / 86400)
               FILTER (WHERE decided_at IS NOT NULL)::numeric, 1)               AS avg_decision_days,
         COUNT(*) FILTER (WHERE cost_bearer = 'hub'
                            AND status IN ('approved','resolved'))::int         AS borne_by_hub,
         COUNT(*) FILTER (WHERE cost_bearer = 'company'
                            AND status IN ('approved','resolved'))::int         AS borne_by_company
       FROM warranty_claims
       WHERE ($1::int IS NULL OR hub_id = $1)`,
      [hubId]
    );
    const s = summary.rows[0];
    const decided = (s.resolved || 0) + (s.rejected || 0)
      + (await pool.query(
          `SELECT COUNT(*)::int AS n FROM warranty_claims
            WHERE status = 'approved' AND ($1::int IS NULL OR hub_id = $1)`, [hubId]
        )).rows[0].n;
    const approvedTotal = decided - (s.rejected || 0);
    s.approval_rate = decided > 0 ? Math.round(approvedTotal / decided * 100) : null;

    // ── Monthly trend (last 12 months) ──
    const trend = await pool.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', claim_date), 'YYYY-MM') AS month,
              COUNT(*)::int AS claims,
              COUNT(*) FILTER (WHERE status IN ('approved','resolved'))::int AS approved
       FROM warranty_claims
       WHERE claim_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
         AND ($1::int IS NULL OR hub_id = $1)
       GROUP BY 1 ORDER BY 1`,
      [hubId]
    );

    // ── Claim rate by service ──
    // claims per service ÷ times that service appears on PAID customer invoices.
    // Services are resolved through the CI item's original estimate item.
    const byService = await pool.query(
      `WITH sold AS (
         SELECT ei.service_id, COUNT(*)::int AS times_sold
         FROM customer_invoice_items cii
         JOIN customer_invoices ci ON ci.id = cii.customer_invoice_id AND ci.status = 'paid'
         JOIN estimate_items ei ON ei.id = cii.estimate_item_id
         WHERE ei.service_id IS NOT NULL
           AND ($1::int IS NULL OR ci.hub_id = $1)
         GROUP BY ei.service_id
       ),
       claimed AS (
         SELECT ei.service_id, COUNT(*)::int AS claims,
                COUNT(*) FILTER (WHERE wc.status IN ('approved','resolved'))::int AS approved_claims
         FROM warranty_claims wc
         JOIN customer_invoice_items cii ON cii.id = wc.customer_invoice_item_id
         JOIN estimate_items ei ON ei.id = cii.estimate_item_id
         WHERE ei.service_id IS NOT NULL
           AND ($1::int IS NULL OR wc.hub_id = $1)
         GROUP BY ei.service_id
       )
       SELECT s.name AS service_name, sold.times_sold, claimed.claims, claimed.approved_claims,
              ROUND(claimed.claims::numeric / NULLIF(sold.times_sold, 0) * 100, 1) AS claim_rate_pct
       FROM claimed
       LEFT JOIN sold ON sold.service_id = claimed.service_id
       JOIN services s ON s.id = claimed.service_id
       ORDER BY claimed.claims DESC
       LIMIT 15`,
      [hubId]
    );

    // ── Per-hub breakdown ──
    // Redo cost = the original item's inc-GST total for approved/resolved
    // claims (what the redo work would have billed at full price).
    const byHub = await pool.query(
      `SELECT h.id AS hub_id, h.hub_name,
              COUNT(*)::int AS claims,
              COUNT(*) FILTER (WHERE wc.status = 'resolved')::int AS resolved,
              COUNT(*) FILTER (WHERE wc.cost_bearer = 'hub'
                                 AND wc.status IN ('approved','resolved'))::int AS borne_by_hub,
              COUNT(*) FILTER (WHERE wc.cost_bearer = 'company'
                                 AND wc.status IN ('approved','resolved'))::int AS borne_by_company,
              COALESCE(SUM(cii.total_inc_gst)
                FILTER (WHERE wc.status IN ('approved','resolved')), 0) AS redo_value
       FROM warranty_claims wc
       LEFT JOIN hubs h ON h.id = wc.hub_id
       LEFT JOIN customer_invoice_items cii ON cii.id = wc.customer_invoice_item_id
       WHERE ($1::int IS NULL OR wc.hub_id = $1)
       GROUP BY h.id, h.hub_name
       ORDER BY claims DESC`,
      [hubId]
    );

    res.json({
      summary: s,
      monthly: trend.rows,
      by_service: byService.rows,
      by_hub: byHub.rows,
    });
  });
}

// ── AUTO-RESOLVE hook ─────────────────────────────────────────────────────────
// Called by customer_invoices.controller.js when a redo CI reaches 'paid'.
// Fire-and-forget: never blocks the payment flow.
async function resolveClaimForEstimate(estimateId) {
  try {
    const r = await pool.query(
      `UPDATE warranty_claims wc
          SET status = 'resolved', updated_at = NOW()
        FROM estimates e
        WHERE e.id = $1 AND e.warranty_claim_id = wc.id AND wc.status = 'approved'
        RETURNING wc.id`,
      [estimateId]
    );
    if (r.rowCount > 0) getIO().emit('invalidate', { topic: 'warranty_claims' });
  } catch (err) {
    console.error('[warranty_claims] auto-resolve failed:', err.message);
  }
}

module.exports = {
  listClaims, getClaim, eligibleItems, createClaim, updateClaim,
  reviewClaim, approveClaim, rejectClaim, cancelClaim, createRedo,
  claimStats, resolveClaimForEstimate, validateClaim,
};
