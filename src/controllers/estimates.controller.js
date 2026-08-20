'use strict';

/**
 * Estimates controller
 *
 * Endpoints:
 *   GET    /api/estimates                          — list with filters
 *   POST   /api/estimates                          — create estimate (draft)
 *   GET    /api/estimates/:id                      — full detail with items
 *   PATCH  /api/estimates/:id                      — update notes/items (draft/revision_requested only)
 *   POST   /api/estimates/:id/submit               — hub submits for company review
 *   POST   /api/estimates/:id/company-approve      — company approves → sent_to_customer
 *   POST   /api/estimates/:id/company-revise       — company requests revision
 *   POST   /api/estimates/:id/customer-approval    — company marks customer item approvals
 */

const { z }    = require('zod');
const { pool } = require('../config/db');
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');
const { fireWhatsAppEventDetached } = require('../services/whatsappAutomations.service');
const { applyItemApprovals } = require('../services/estimateApproval.service');
const { getRoundingFunction } = require('../utils/math');
const { generatePublicToken, ensureCustomerIdentity, resolveTokenToId } = require('../utils/publicToken');
const { hubScopeSql, assertHubOwns } = require('../utils/hubScope');
const { logActivity } = require('../services/activityLog.service');
const { getIO } = require('../socket');

// ─── Validators ───────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();
const { loadCompany, resolveRender, sendPdf } = require('../utils/renderDocument');
const { validateInvoiceDate, validationError, istToday, toIstDate } = require('../utils/invoiceDate');
const { buildSearchSql } = require('../utils/listSearch');

// What the estimate search box looks at. Split out of COALESCE for the same
// planner reason as the purchase-invoice list — see PI_SEARCH.
//
// This page used to match the id with `CAST(e.id AS TEXT) ILIKE '%48%'`, which
// also returned 148, 480 and 1148. Estimate numbers now go through the id
// branch in buildSearchSql, so "EST-48" is an exact primary-key hit.
const EST_SEARCH = {
  textColumns: [
    'a.customer_name',  'e.customer_name',
    'a.vehicle_number', 'e.vehicle_number',
    'a.mobile',         'e.mobile',
  ],
  idColumn: 'e.id',
  idPrefixes: ['est', 'e', 'q'],
};
const { warrantyImpact, WARRANTY_ITEMS_SQL } = require('../utils/warrantyPreflight');

const itemSchema = z.object({
  // The existing estimate_items row this line came from, when editing.
  //
  // Absent = a newly added line. Present = update that row IN PLACE, so its id
  // survives the edit. That matters because customer_invoice_items and
  // purchase_invoice_items point at these ids: the save used to delete every
  // row and re-insert, which forced those links to be nulled first and
  // permanently severed the estimate↔invoice relationship on every edit.
  //
  // An id that doesn't belong to this estimate is ignored and treated as a new
  // line — the diff only ever looks the id up in this estimate's own rows.
  id:           z.coerce.number().int().positive().optional().nullable(),
  item_type:    z.enum(['service', 'part']),
  service_id:   z.coerce.number().int().positive().optional().nullable(),
  part_id:      z.coerce.number().int().positive().optional().nullable(),
  item_id:      z.coerce.number().int().positive().optional().nullable(),  // frontend unified field
  description:  z.string().trim().min(1).max(300),
  quantity:     z.coerce.number().positive().default(1),
  customer_rate: z.coerce.number().nonnegative(),
  gst_percent:  z.coerce.number().min(0).max(100).default(0),
  is_from_appointment: z.boolean().optional().default(false),
  discount_type:   z.enum(['percent', 'flat']).optional().nullable(),
  discount_value:  z.coerce.number().nonnegative().optional().default(0),
  discount_amount: z.coerce.number().nonnegative().optional().default(0),
  discount_source: z.enum(['master', 'manual']).optional().nullable(),
  // Warranty/guarantee snapshots — resolved from warranty_master at add-time
  // and frozen here so later master edits never change what this estimate
  // promised. Both promise types can apply to the same line at once.
  warranty_months: z.coerce.number().int().positive().optional().nullable(),
  warranty_days:   z.coerce.number().int().positive().optional().nullable(),
  warranty_km:     z.coerce.number().int().positive().optional().nullable(),
  warranty_text:   z.string().trim().max(300).optional().nullable(),
  warranty_source: z.enum(['master', 'manual']).optional().nullable(),
  guarantee_months: z.coerce.number().int().positive().optional().nullable(),
  guarantee_days:   z.coerce.number().int().positive().optional().nullable(),
  guarantee_km:     z.coerce.number().int().positive().optional().nullable(),
  guarantee_text:   z.string().trim().max(300).optional().nullable(),
  guarantee_source: z.enum(['master', 'manual']).optional().nullable(),
});

// Shared B2B fields, validated the same way on create and update: when
// is_b2b is true, company name / GST number / address are all required.
// GST number just needs to be present — format/checksum (GSTIN) validation
// was intentionally removed per user request; any text up to 15 chars is
// accepted (15-char cap is a DB column limit, not a format check).
const b2bFieldsRefine = (data, ctx) => {
  if (!data.is_b2b) return;
  if (!data.b2b_company_name || !data.b2b_company_name.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['b2b_company_name'], message: 'Company name is required for a B2B invoice.' });
  }
  if (!data.b2b_address || !data.b2b_address.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['b2b_address'], message: 'Address is required for a B2B invoice.' });
  }
  if (!data.b2b_gst_number || !data.b2b_gst_number.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['b2b_gst_number'], message: 'GST number is required for a B2B invoice.' });
  }
};

// Reused from appointments.controller.js's mobile validator, so standalone
// estimates enforce the same format rule as appointment creation.
const mobileRegex = /^\+?[\d\s\-]{7,20}$/;

const createSchema = z.object({
  // Optional now — an estimate can either link to an existing appointment
  // OR carry its own standalone customer/vehicle context (see below).
  appointment_id:            z.coerce.number().int().positive().optional().nullable(),
  hub_id:                    z.coerce.number().int().positive().optional().nullable(),
  notes:                     z.string().trim().max(3000).optional().nullable(),
  items:                     z.array(itemSchema).optional().default([]),
  discount_mode:             z.enum(['none', 'line_item', 'transaction']).default('none'),
  transaction_discount_type: z.enum(['percent', 'flat']).optional().nullable(),
  transaction_discount_value: z.coerce.number().nonnegative().optional().default(0),
  is_b2b:                    z.boolean().optional().default(false),
  b2b_company_name:          z.string().trim().max(200).optional().nullable(),
  b2b_gst_number:            z.string().trim().max(15).transform(v => v ? v.toUpperCase() : v).optional().nullable(),
  b2b_address:               z.string().trim().max(2000).optional().nullable(),
  save_b2b_to_profile:       z.boolean().optional().default(false),

  // Standalone customer + vehicle context — required when appointment_id is
  // absent (mirrors the appointments table's own column shape).
  customer_name:             z.string().trim().max(160).optional().nullable(),
  mobile:                    z.string().trim().max(20).regex(mobileRegex, 'Mobile must be 7–20 digits and may include +, spaces, or dashes').optional().nullable(),
  whatsapp:                  z.string().trim().max(20).optional().nullable(),
  vehicle_number:            z.string().trim().max(30).optional().nullable(),
  vehicle_type_id:           z.coerce.number().int().positive().optional().nullable(),
  make_id:                   z.coerce.number().int().positive().optional().nullable(),
  model_id:                  z.coerce.number().int().positive().optional().nullable(),
  body_type_id:              z.coerce.number().int().positive().optional().nullable(),
  segment_ids:               z.array(z.coerce.number().int().positive()).optional().default([]),
  cc_category_id:            z.coerce.number().int().positive().optional().nullable(),
  odometer_km:               z.coerce.number().int().nonnegative().optional().nullable(),

  // Backdating a job that was done before it was entered. Omitted = the
  // appointment's scheduled date if there is one, else today — so the common
  // case needs no input at all.
  estimate_date:             z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'estimate_date must be YYYY-MM-DD').optional(),
  backdate_reason:           z.string().trim().min(10, 'Please give a reason of at least 10 characters.').optional(),
  override:                  z.coerce.boolean().optional().default(false),
}).superRefine((data, ctx) => {
  b2bFieldsRefine(data, ctx);
  if (!data.appointment_id) {
    if (!data.mobile || !data.mobile.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mobile'], message: 'Mobile number is required when no appointment is linked.' });
    }
    if (!data.vehicle_type_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vehicle_type_id'], message: 'Vehicle type is required when no appointment is linked.' });
    }
  }
});

const updateSchema = z.object({
  notes:                     z.string().trim().max(3000).optional().nullable(),
  items:                     z.array(itemSchema).optional(),
  // Hub reassignment — guarded in updateEstimate: free while no PI exists,
  // needs confirm_regenerate_pi with an unpaid PI (old PI is deleted and must
  // be regenerated), hard-blocked once the hub has actually been paid.
  hub_id:                    z.coerce.number().int().positive().optional(),
  confirm_regenerate_pi:     z.boolean().optional().default(false),
  confirm_cost_bearer_company: z.boolean().optional().default(false),
  discount_mode:             z.enum(['none', 'line_item', 'transaction']).optional(),
  transaction_discount_type: z.enum(['percent', 'flat']).optional().nullable(),
  transaction_discount_value: z.coerce.number().nonnegative().optional(),
  is_b2b:                    z.boolean().optional(),
  b2b_company_name:          z.string().trim().max(200).optional().nullable(),
  b2b_gst_number:            z.string().trim().max(15).transform(v => v ? v.toUpperCase() : v).optional().nullable(),
  b2b_address:               z.string().trim().max(2000).optional().nullable(),
  save_b2b_to_profile:       z.boolean().optional().default(false),
}).superRefine((data, ctx) => {
  // Update payloads may omit is_b2b entirely (partial save). Only run the
  // B2B requiredness check when is_b2b is explicitly part of this request.
  if (data.is_b2b === undefined) return;
  b2bFieldsRefine(data, ctx);
});

const customerApprovalSchema = z.object({
  approvals: z.array(z.object({
    item_id:  z.coerce.number().int().positive(),
    approved: z.boolean(),
  })).min(1, 'At least one approval entry is required'),
});

const companyReviseSchema = z.object({
  notes: z.string().trim().max(3000).optional().nullable(),
});

// ─── Error handler ────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Estimate date support (PLAN_backdated_job_chain.md)
//
// The estimate's date is the anchor for the whole job: the purchase invoice and
// customer invoice generated from it inherit it when the estimate was
// explicitly backdated. That makes entering a job that happened weeks ago a
// single date entry rather than three.
// ─────────────────────────────────────────────────────────────────────────────

async function loadDateSettings() {
  const r = await pool.query(
    `SELECT books_locked_through::text AS books_locked_through, backdate_max_days
       FROM company_settings ORDER BY id LIMIT 1`
  );
  return r.rows[0] || { books_locked_through: null, backdate_max_days: 30 };
}

// Mirrors requirePermission's logic for the finer-grained decisions inside a
// handler (may this user override a soft rule?), is_super_admin bypass included.
function hasPerm(req, code) {
  if (!req.user) return false;
  if (req.user.is_super_admin) return true;
  return !!req.user.permissions?.has(code);
}

// Everything the validator needs about one estimate and its downstream
// documents, in one round trip.
async function loadEstimateDateContext(db, id) {
  const r = await db.query(
    `SELECT e.id, e.status,
            e.estimate_date::text          AS estimate_date,
            e.original_estimate_date::text AS original_estimate_date,
            a.scheduled_date::text         AS appointment_date,
            pi.id                          AS pi_id,
            pi.invoice_date::text          AS pi_invoice_date,
            pi.amount_paid                 AS pi_amount_paid,
            ci.id                          AS ci_id,
            ci.invoice_date::text          AS ci_invoice_date,
            ci.status                      AS ci_status,
            (SELECT COUNT(*)::int FROM invoice_payment_lines p
              WHERE p.customer_invoice_id = ci.id)  AS ci_payment_count
       FROM estimates e
       LEFT JOIN appointments a       ON a.id = e.appointment_id
       LEFT JOIN purchase_invoices pi ON pi.estimate_id = e.id
       LEFT JOIN customer_invoices ci ON ci.estimate_id = e.id
      WHERE e.id = $1
      LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

// What moving the estimate would do to the linked invoice's warranties.
//
// The cascade rewrites customer_invoices.invoice_date directly, which is the
// same change updateInvoiceDate() guards with a hard WARRANTY_WOULD_EXPIRE
// rule. Without this the cascade was a way around that rule — and it defaults
// to on, so it was the EASIER path. Unclaimed warranties would have expired
// retroactively with no warning and no record.
async function cascadeWarrantyImpact(db, ctx, newDate, today) {
  if (!ctx.ci_id) return { shifting: [], expiring: [], unaffected: 0 };
  const items = await db.query(WARRANTY_ITEMS_SQL, [ctx.ci_id]);
  return warrantyImpact({
    items: items.rows,
    currentDate: ctx.ci_invoice_date,
    newDate,
    today,
  });
}

// Runs the validator for a proposed estimate date. Shared by the preflight and
// the write so the dry run can never disagree with the real thing.
function checkEstimateDate(ctx, newDate, { canBackdate, canOverride, today, warranty = null }) {
  // The estimate sits at the head of the chain, so nothing is upstream of it —
  // but anything already generated FROM it constrains how far forward it can
  // move. The earliest downstream document is the binding one.
  const downstream = [ctx.pi_invoice_date, ctx.ci_invoice_date].filter(Boolean).sort()[0] || null;
  return validateInvoiceDate({
    invoiceDate: newDate,
    currentDate: ctx.estimate_date,
    documentType: 'estimate',
    chainAfter: downstream,
    chainAfterLabel: ctx.pi_invoice_date && downstream === ctx.pi_invoice_date
      ? 'its purchase invoice' : 'its customer invoice',
    settings: ctx._settings,
    // Only meaningful when the CI is actually moving with us.
    warranty,
    canBackdate,
    canOverride,
    today,
  });
}

// Which downstream documents can follow the estimate, and why not if not.
// Same freeze rules as phase 3: a PI is frozen once the hub has been paid, a
// CI once any payment is recorded against it.
function cascadeTargets(ctx) {
  const out = [];
  if (ctx.pi_id) {
    const paid = Number(ctx.pi_amount_paid || 0) > 0;
    out.push({
      type: 'purchase_invoice', id: ctx.pi_id, invoice_date: ctx.pi_invoice_date,
      can_follow: !paid,
      blocked_reason: paid ? 'The hub has already been paid for this job.' : null,
    });
  }
  if (ctx.ci_id) {
    const hasPayments = Number(ctx.ci_payment_count || 0) > 0;
    const badStatus = !['generated', 'approved'].includes(ctx.ci_status);
    out.push({
      type: 'customer_invoice', id: ctx.ci_id, invoice_date: ctx.ci_invoice_date,
      can_follow: !hasPayments && !badStatus,
      blocked_reason: hasPayments ? 'The customer invoice has payments recorded against it.'
        : (badStatus ? `The customer invoice status is ${ctx.ci_status}.` : null),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates/:id/date-preflight?estimate_date=YYYY-MM-DD
//   Dry run. Reports what a date change would do — which rules fail, what needs
//   an override, and which downstream documents can follow — without writing.
// ─────────────────────────────────────────────────────────────────────────────
function estimateDatePreflight(req, res, next) {
  handle(req, res, next, async () => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const newDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'estimate_date must be YYYY-MM-DD')
      .parse(req.query.estimate_date);

    await _assertEstimateHub(req, id);

    const ctx = await loadEstimateDateContext(pool, id);
    if (!ctx) return res.status(404).json({ error: 'Estimate not found' });

    const today = istToday();
    ctx._settings = await loadDateSettings();
    const warranty = await cascadeWarrantyImpact(pool, ctx, newDate, today);
    const check = checkEstimateDate(ctx, newDate, {
      canBackdate: hasPerm(req, 'BACKDATE_ESTIMATE'),
      canOverride: false, // report what WOULD need an override, don't apply one
      today,
      warranty,
    });

    res.json({
      current_date: ctx.estimate_date,
      proposed_date: newDate,
      appointment_date: ctx.appointment_date,
      today,
      ok: check.ok,
      unchanged: !!check.unchanged,
      errors: check.errors,
      warnings: check.warnings,
      requires_override: check.errors.some(e => e.overridable),
      requires_reason: newDate !== ctx.estimate_date,
      // Same shape the CI preflight returns, so the shared dialog renders it
      // without a second code path.
      warranty,
      cascade: cascadeTargets(ctx),
      books_locked_through: ctx._settings.books_locked_through,
      backdate_max_days: ctx._settings.backdate_max_days,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/estimates/:id/estimate-date
//   Body: { estimate_date, reason, override?, cascade? }
//   cascade moves the PI and CI to match, each refused individually if frozen.
// ─────────────────────────────────────────────────────────────────────────────
function updateEstimateDate(req, res, next) {
  handle(req, res, next, async () => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const body = z.object({
      estimate_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'estimate_date must be YYYY-MM-DD'),
      reason: z.string().trim().min(10, 'Please give a reason of at least 10 characters.'),
      override: z.coerce.boolean().optional().default(false),
      cascade: z.coerce.boolean().optional().default(true),
    }).parse(req.body);

    await _assertEstimateHub(req, id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise every date change and generation for this job.
      //
      // Without it two concurrent edits both read the pre-change state, both
      // validate against it, and both commit — producing exactly the ordering
      // the chain rule exists to prevent (a CI dated before its estimate), or
      // a date moved onto an invoice that received a payment in between.
      // Keyed on the ESTIMATE id so all three documents in a job contend on
      // the same lock. Namespace 3 — 1 is appointment creation, 2 is CI
      // generation.
      await client.query(`SELECT pg_advisory_xact_lock(3, $1)`, [id]);

      const ctx = await loadEstimateDateContext(client, id);
      if (!ctx) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Estimate not found' }); }

      if (ctx.estimate_date === body.estimate_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That is already the estimate date.', code: 'UNCHANGED' });
      }
      // Mirrors the CI's status freeze. A cancelled or rejected estimate is
      // history; re-dating it (and cascading from it) is never a correction.
      if (['cancelled', 'rejected'].includes(ctx.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `An estimate with status "${ctx.status}" cannot have its date changed.`,
          code: 'BAD_STATUS',
        });
      }

      const today = istToday();
      ctx._settings = await loadDateSettings();

      // When cascading, the downstream documents are moving too, so they must
      // not also be treated as a ceiling — that would make every cascade
      // self-blocking. Their own freeze rules still apply below.
      const movable = cascadeTargets(ctx);
      const cascading = body.cascade && movable.some(t => t.can_follow);
      const ctxForCheck = cascading
        ? { ...ctx,
            pi_invoice_date: movable.find(t => t.type === 'purchase_invoice')?.can_follow ? null : ctx.pi_invoice_date,
            ci_invoice_date: movable.find(t => t.type === 'customer_invoice')?.can_follow ? null : ctx.ci_invoice_date }
        : ctx;

      // Only when the CI is actually being moved — if it stays put its
      // warranties don't move either.
      const ciMoving = cascading && movable.find(t => t.type === 'customer_invoice')?.can_follow;
      const warranty = ciMoving
        ? await cascadeWarrantyImpact(client, ctx, body.estimate_date, today)
        : null;

      const check = checkEstimateDate(ctxForCheck, body.estimate_date, {
        canBackdate: hasPerm(req, 'BACKDATE_ESTIMATE'),
        canOverride: body.override && hasPerm(req, 'OVERRIDE_INVOICE_DATE_LIMITS'),
        today,
        warranty,
      });
      if (!check.ok) { await client.query('ROLLBACK'); return res.status(409).json(validationError(check)); }

      await client.query(
        `UPDATE estimates
            SET estimate_date          = $1::date,
                original_estimate_date = COALESCE(original_estimate_date, $2::date),
                backdate_reason        = $3,
                backdated_by           = $4,
                backdated_at           = NOW(),
                updated_by             = $4,
                updated_at             = NOW()
          WHERE id = $5`,
        [body.estimate_date, ctx.estimate_date, body.reason, req.user?.id || null, id]
      );

      // ── Cascade ────────────────────────────────────────────────────────
      const moved = [];
      if (body.cascade) {
        for (const t of movable) {
          if (!t.can_follow) { moved.push({ ...t, moved: false }); continue; }
          const table = t.type === 'purchase_invoice' ? 'purchase_invoices' : 'customer_invoices';
          await client.query(
            `UPDATE ${table}
                SET invoice_date          = $1::date,
                    original_invoice_date = COALESCE(original_invoice_date, invoice_date),
                    backdate_reason       = $2,
                    backdated_by          = $3,
                    backdated_at          = NOW(),
                    updated_by            = $3,
                    updated_at            = NOW()
              WHERE id = $4`,
            [body.estimate_date, `Followed estimate #${id}: ${body.reason}`, req.user?.id || null, t.id]
          );
          moved.push({ ...t, moved: true, invoice_date: body.estimate_date });
        }
      }

      await client.query('COMMIT');

      logActivity({
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'UPDATE',
        entity: 'estimate',
        entityId: id,
        description:
          `Estimate date changed on EST-${String(id).padStart(6, '0')}: ` +
          `${ctx.estimate_date} → ${body.estimate_date}` +
          (check.overridden?.length ? ` [overrode: ${check.overridden.map(o => o.code).join(', ')}]` : '') +
          (moved.filter(m => m.moved).length
            ? ` [also moved: ${moved.filter(m => m.moved).map(m => m.type).join(', ')}]` : '') +
          ` — ${body.reason}`,
      });

      res.json({
        ok: true, id,
        estimate_date: body.estimate_date,
        previous_estimate_date: ctx.estimate_date,
        warnings: check.warnings,
        overridden: check.overridden || [],
        warranty,
        cascade: moved,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
      }
      // Same migration hint the invoice and settings controllers give. Estimate
      // creation reads company_settings.books_locked_through (migration 100) and
      // estimates.estimate_date (101); without them this was a bare 500 that
      // looked like a code fault rather than a pending migration.
      if (err.code === '42703' && /estimate_date|backdat|books_locked|updated_by/i.test(err.message || '')) {
        console.error('[estimates] missing column — migrations not applied:', err.message);
        return res.status(503).json({
          error: 'Database is behind the code: the document-date columns are missing. ' +
                 'Run `npm run db:migrate` in backend/ to apply migrations 099-101.',
          code: 'MIGRATION_PENDING',
          detail: err.message,
        });
      }
      next(err);
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hub tenancy guard for the estimate write paths.
 *
 * Load-bearing, not defence in depth: every estimate mutation route is gated
 * with requirePermissionOrHub (estimates.routes.js), and that middleware waves
 * through any hub login holding zero permissions. Without this check such a
 * login could PATCH, submit, revise, company-approve or set work status on ANY
 * estimate in the system, not just its own hub's.
 *
 * Costs one extra round trip, and only on hub-portal requests — for staff and
 * super admins it returns immediately.
 */
async function _assertEstimateHub(req, id, db = pool) {
  if (!req.user?.hub_id) return;
  const r = await db.query(`SELECT hub_id FROM estimates WHERE id = $1`, [id]);
  assertHubOwns(req, r.rows[0], 'hub_id', 'Estimate');
}

function computeItem(data, roundFn = parseFloat) {
  const qty    = Number(data.quantity)      || 1;
  const rate   = Number(data.customer_rate) || 0; // ex-GST (stored at 4dp precision)
  const gstPct = Number(data.gst_percent)   || 0;

  // Step 1: total inc-GST before discount
  const totalBeforeDisc = roundFn(rate * qty * (1 + gstPct / 100));

  // Step 1b: derive the discount amount SERVER-SIDE from type + value.
  // Never trust a client-supplied discount_amount — it could zero out a line.
  let discountAmt = 0;
  const dValue = Number(data.discount_value) || 0;
  if (data.discount_type === 'percent' && dValue > 0) {
    discountAmt = roundFn(totalBeforeDisc * dValue / 100);
  } else if (data.discount_type === 'flat' && dValue > 0) {
    discountAmt = Math.min(dValue, totalBeforeDisc);
  }
  // Step 2: apply line-item discount
  const totalIncGst = roundFn(Math.max(0, totalBeforeDisc - discountAmt));
  // Step 3: back-calculate ex-GST from the discounted total (correct for Indian GST)
  const exGstTotal  = gstPct > 0
    ? roundFn(totalIncGst / (1 + gstPct / 100))
    : totalIncGst;
  // Step 4: GST = total − exGST (NOT exGST × rate — prevents cumulative ₹0.01 drift)
  const gstAmount   = roundFn(totalIncGst - exGstTotal);
  return { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt };
}

async function recalcTotals(client, estimateId) {
  // Step 1: sum items (per-item discounts already baked into total_inc_gst)
  const sumRes = await client.query(`
    SELECT
      COALESCE(SUM(total_inc_gst - gst_amount), 0) AS subtotal_ex_gst,
      COALESCE(SUM(gst_amount), 0)                 AS total_gst,
      COALESCE(SUM(total_inc_gst), 0)              AS grand_total_before
    FROM estimate_items WHERE estimate_id = $1
  `, [estimateId]);

  const { subtotal_ex_gst, total_gst, grand_total_before } = sumRes.rows[0];

  // Step 2: fetch discount mode and created_at for this estimate
  const modeRes = await client.query(
    `SELECT discount_mode, transaction_discount_type, transaction_discount_value, created_at
     FROM estimates WHERE id = $1`,
    [estimateId]
  );
  const { discount_mode, transaction_discount_type, transaction_discount_value, created_at } = modeRes.rows[0] || {};
  const roundFn = getRoundingFunction(created_at);

  // Step 3: apply transaction-level discount if applicable
  let transactionDiscountAmount = 0;
  let grandTotal = parseFloat(grand_total_before);

  if (discount_mode === 'transaction' && parseFloat(transaction_discount_value) > 0) {
    const val = parseFloat(transaction_discount_value);
    if (transaction_discount_type === 'percent') {
      transactionDiscountAmount = roundFn(grandTotal * val / 100);
    } else if (transaction_discount_type === 'flat') {
      transactionDiscountAmount = Math.min(val, grandTotal);
    }
    grandTotal = roundFn(grandTotal - transactionDiscountAmount);
  }

  await client.query(`
    UPDATE estimates SET
      subtotal_ex_gst          = $1,
      total_gst                = $2,
      grand_total              = $3,
      transaction_discount_amount = $4,
      updated_at               = NOW()
    WHERE id = $5
  `, [
    subtotal_ex_gst,
    total_gst,
    grandTotal.toFixed(2),
    transactionDiscountAmount.toFixed(2),
    estimateId,
  ]);
}

// Saves the given B2B billing details as this customer's autofill default,
// keyed by mobile (customer_profiles is a convenience cache — the estimate's
// own b2b_* columns remain the source of truth for that specific invoice).
async function _saveB2bProfileDefault(client, mobile, { companyName, gstNumber, address }) {
  if (!mobile) return;
  await client.query(
    `INSERT INTO customer_profiles
       (mobile, default_is_b2b, default_b2b_company_name, default_b2b_gst_number, default_b2b_address, updated_at)
     VALUES ($1, TRUE, $2, $3, $4, NOW())
     ON CONFLICT (mobile) DO UPDATE SET
       default_is_b2b           = TRUE,
       default_b2b_company_name = EXCLUDED.default_b2b_company_name,
       default_b2b_gst_number   = EXCLUDED.default_b2b_gst_number,
       default_b2b_address      = EXCLUDED.default_b2b_address,
       updated_at                = NOW()`,
    [mobile, companyName || null, gstNumber || null, address || null]
  );
}

async function _getItems(estimateId) {
  const r = await pool.query(
    `SELECT
       ei.id,
       ei.estimate_id,
       ei.item_type,
       ei.description,
       ei.quantity,
       ei.customer_rate,
       ei.gst_percent,
       ei.gst_amount,
       ei.total_inc_gst,
       ei.is_from_appointment,
       ei.customer_approved,
       ei.work_status,
       ei.discount_type,
       ei.discount_value,
       ei.discount_amount,
       ei.discount_source,
       ei.warranty_months,
       ei.warranty_days,
       ei.warranty_km,
       ei.warranty_text,
       ei.warranty_source,
       ei.guarantee_months,
       ei.guarantee_days,
       ei.guarantee_km,
       ei.guarantee_text,
       ei.guarantee_source,
       ei.created_at,
       ei.updated_at,
       COALESCE(ei.hsn_sac, s.sac_code, p.hsn_code) AS hsn_sac,
       s.id   AS service_id,   s.name  AS service_name,
       p.id   AS part_id,      p.name  AS part_name
     FROM estimate_items ei
     LEFT JOIN services s ON s.id = ei.service_id
     LEFT JOIN parts    p ON p.id = ei.part_id
     WHERE ei.estimate_id = $1
     ORDER BY ei.id`,
    [estimateId]
  );
  return r.rows;
}

// ─── Full SELECT fragment ─────────────────────────────────────────────────────

const EST_SELECT = `
  SELECT
    e.id,
    e.public_token,
    e.appointment_id,
    e.hub_id,
    e.status,
    e.notes,
    e.odometer_km,
    e.warranty_claim_id,
    e.subtotal_ex_gst,
    e.total_gst,
    e.grand_total,
    e.reviewed_by,
    e.reviewed_at,
    e.created_by,
    e.created_at,
    e.updated_at,
    -- The estimate's own date (migration 101): when the WORK happened, which
    -- is not necessarily when the row was keyed in. ::text so pg-types can't
    -- parse the DATE into a local-midnight JS Date and shift it a day on an
    -- IST server. created_at stays as the system record.
    e.estimate_date::text          AS estimate_date,
    e.original_estimate_date::text AS original_estimate_date,
    e.backdate_reason,
    e.backdated_at,
    e.discount_mode,
    e.transaction_discount_type,
    e.transaction_discount_value,
    e.transaction_discount_amount,
    e.is_b2b,
    e.b2b_company_name,
    e.b2b_gst_number,
    e.b2b_address,

    -- Customer / vehicle context — from the linked appointment when present,
    -- otherwise from the estimate's own standalone columns.
    COALESCE(a.customer_name, e.customer_name)   AS customer_name,
    COALESCE(a.mobile, e.mobile)                 AS mobile,
    (SELECT public_token FROM customer_identities WHERE mobile = COALESCE(a.mobile, e.mobile)) AS customer_token,
    COALESCE(a.vehicle_number, e.vehicle_number) AS vehicle_number,
    -- Pickup logistics, printed under BILL TO when the job was a pickup.
    -- Only the appointment has these; a standalone estimate simply has none.
    a.pickup_required, a.pickup_address_line1, a.pickup_address_line2,
    a.pickup_city, a.pickup_pincode,
    a.scheduled_date,

    -- Raw vehicle dimension ids (for re-deriving pricing context client-side
    -- when editing a standalone estimate — appointment mode already gets
    -- these from the /api/appointments list instead).
    COALESCE(a.vehicle_type_id, e.vehicle_type_id) AS vehicle_type_id,
    COALESCE(a.make_id, e.make_id)                 AS make_id,
    COALESCE(a.model_id, e.model_id)               AS model_id,
    COALESCE(a.body_type_id, e.body_type_id)       AS body_type_id,
    COALESCE(a.cc_category_id, e.cc_category_id)   AS cc_category_id,
    COALESCE(a.segment_ids, e.segment_ids)         AS segment_ids,

    -- Vehicle details
    vt.name  AS vehicle_type_name,
    vm.name  AS make_name,
    vmod.name AS model_name,
    bt.name  AS body_type_name,
    cc.name  AS cc_category_name,
    cc.min_cc,
    cc.max_cc,
    vmod.engine_cc,
    (SELECT string_agg(sg.name, ', ') FROM segments sg WHERE sg.id = ANY(COALESCE(a.segment_ids, e.segment_ids))) AS segment_names,

    -- Hub
    ('Spinoto ' || ar.name) AS hub_name,
    h.hub_name AS hub_full_name,

    -- Reviewer
    rv.name  AS reviewed_by_name,

    -- Creator
    u.name   AS created_by_name,

    -- Item count
    (SELECT COUNT(*)::int FROM estimate_items ei WHERE ei.estimate_id = e.id) AS item_count,

    -- Linked customer invoice (null if not yet generated)
    (SELECT ci.id     FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_id,
    (SELECT ci.public_token FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_token,
    (SELECT ci.status FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_status,
    (SELECT ci.grand_total FROM customer_invoices ci WHERE ci.estimate_id = e.id LIMIT 1) AS customer_invoice_total,

    -- Advances already taken against this job, before any invoice exists.
    -- Drives both the "₹2,000 taken" label on the button and the ceiling in the
    -- modal — the figure has to come from the same place the server validates
    -- against, or staff are offered an amount that will then be refused.
    (SELECT COALESCE(SUM(p.amount), 0) FROM customer_invoice_payments p
      WHERE p.estimate_id = e.id AND p.payment_type = 'advance') AS advanced_total,

    -- Linked purchase invoice (id + status, so UI can gate CI generation)
    (SELECT pi.id     FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_id,
    (SELECT pi.public_token FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_token,
    (SELECT pi.status FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_status,
    (SELECT pi.grand_total FROM purchase_invoices pi WHERE pi.estimate_id = e.id ORDER BY pi.id DESC LIMIT 1) AS purchase_invoice_total

  FROM estimates e
  LEFT JOIN appointments  a    ON a.id    = e.appointment_id
  LEFT JOIN vehicle_types vt   ON vt.id   = COALESCE(a.vehicle_type_id, e.vehicle_type_id)
  LEFT JOIN vehicle_makes vm   ON vm.id   = COALESCE(a.make_id, e.make_id)
  LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, e.model_id)
  LEFT JOIN body_types     bt   ON bt.id   = COALESCE(a.body_type_id, e.body_type_id)
  LEFT JOIN cc_categories  cc   ON cc.id   = COALESCE(a.cc_category_id, e.cc_category_id)
  LEFT JOIN hubs           h    ON h.id    = e.hub_id
  LEFT JOIN areas          ar   ON ar.id   = h.area_id
  LEFT JOIN users          rv   ON rv.id   = e.reviewed_by
  LEFT JOIN users          u    ON u.id    = e.created_by
`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates — List
// ─────────────────────────────────────────────────────────────────────────────
function listEstimates(req, res, next) {
  handle(req, res, next, async () => {
    const appointmentId = req.query.appointment_id || '';
    const hubId         = req.query.hub_id         || '';
    const hubIds        = req.query.hub_ids        || '';
    const status        = req.query.status         || '';
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    // ── User scoping ──────────────────────────────────────────────────────────
    // Hub-portal logins are pinned to their own hub, checked BEFORE the
    // permission tiers so that granting a hub user VIEW_ESTIMATE widens them
    // within their hub instead of across every hub. Without this branch a hub
    // login saw only estimates it had typed itself (created_by), never the rest
    // of its hub's work.
    // Then: super admins and VIEW_ESTIMATE users see all; everyone else sees
    // only their own.
    const hubScope = hubScopeSql(req, params, 'e.hub_id');
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_ESTIMATE');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (!isAll) {
      params.push(req.user.id);
      conditions.push(`e.created_by = $${params.length}`);
    }

    if (appointmentId) { params.push(Number(appointmentId)); conditions.push(`e.appointment_id = $${params.length}`); }
    // Skipped for hub logins — hubScope already pinned the hub above.
    if (!hubScope && hubIds) {
      const ids = hubIds.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`e.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && hubId) {
      params.push(Number(hubId));
      conditions.push(`e.hub_id = $${params.length}`);
    }
    if (status)        { params.push(status);                conditions.push(`e.status = $${params.length}`); }
    if (req.query.vehicle_type) {
      // Match either via the linked appointment's vehicle type, or (for
      // standalone estimates with no appointment) the estimate's own
      // vehicle_type_id column.
      if (req.query.vehicle_type === '2W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = e.appointment_id AND vt.name ILIKE '%2%')
          OR EXISTS (SELECT 1 FROM vehicle_types vt WHERE vt.id = e.vehicle_type_id AND vt.name ILIKE '%2%')
        )`);
      } else if (req.query.vehicle_type === '4W') {
        conditions.push(`(
          EXISTS (SELECT 1 FROM appointments a JOIN vehicle_types vt ON vt.id = a.vehicle_type_id WHERE a.id = e.appointment_id AND vt.name ILIKE '%4%')
          OR EXISTS (SELECT 1 FROM vehicle_types vt WHERE vt.id = e.vehicle_type_id AND vt.name ILIKE '%4%')
        )`);
      }
    }

    const searchSql = buildSearchSql({ search: req.query.search, params, ...EST_SEARCH });
    if (searchSql) conditions.push(searchSql);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        // Estimate date, not keyed-in date — a retroactively entered job
        // belongs where the work happened. id tiebreaker so OFFSET paging
        // can't repeat or skip rows when many share a date.
        `${EST_SELECT} ${where} ORDER BY e.estimate_date DESC, e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      // Count needs the appointments join too — the search condition
      // references a.* columns.
      pool.query(
        `SELECT COUNT(*)::int                      AS total,
                COALESCE(SUM(e.grand_total), 0)    AS sum_total
         FROM estimates e
         LEFT JOIN appointments a ON a.id = e.appointment_id
         ${where}`,
        params
      ),
    ]);

    return res.json({
      items: dataRes.rows,
      total: countRes.rows[0]?.total || 0,
      // Only one figure here, deliberately. An estimate is a quote, not a
      // receivable: the table has no amount_paid column, and money against the
      // job is tracked on the customer invoice that follows it. A "received"
      // number on this page would have to be invented.
      totals: { amount: parseFloat(countRes.rows[0]?.sum_total || 0) },
      page,
      limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates/:id — Detail
// ─────────────────────────────────────────────────────────────────────────────
function getEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const estimate = row.rows[0];
    // Scoping the list is not enough on its own — a hub login could otherwise
    // read any estimate by walking ids. Also covers /by-token/:token, which
    // resolves the token then delegates here.
    assertHubOwns(req, estimate, 'hub_id', 'Estimate');
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates/:id/pdf?theme=xxx
//
// Renders the estimate through the shared themed-document pipeline (the same
// templates that produce customer invoices and purchase invoices), replacing
// the browser's window.print() of the on-screen layout.
//
// Note the adapter drops customer-rejected line items: the old print view
// showed them while excluding them from the totals, so the printed rows didn't
// sum to the printed Grand Total.
// ─────────────────────────────────────────────────────────────────────────────
function getEstimatePdf(req, res, next) {
  handle(req, res, next, async () => {
    const id  = idParam.parse(req.params.id);
    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const estimate = row.rows[0];
    assertHubOwns(req, estimate, 'hub_id', 'Estimate');
    estimate.items = await _getItems(id);

    const company = await loadCompany();
    const { cfg, theme } = resolveRender(company, 'estimate', req.user, {
      themeOverride: req.query.theme,
      share: req.query.share === '1' || req.query.share === 'true',
    });

    await sendPdf(res, {
      docType: 'estimate', row: estimate, company, cfg, theme,
      baseUrl: req.get('origin') || req.get('referer'),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/estimates/by-token/:token — resolves a public_token (used in
// shareable /estimates/:token URLs) to the numeric id, then delegates to
// the exact same logic as GET /api/estimates/:id.
// ─────────────────────────────────────────────────────────────────────────────
function getEstimateByToken(req, res, next) {
  handle(req, res, next, async () => {
    const id = await resolveTokenToId(pool, 'estimates', req.params.token);
    if (!id) return res.status(404).json({ error: 'Estimate not found' });
    req.params.id = String(id);
    return getEstimate(req, res, next);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates — Create
// ─────────────────────────────────────────────────────────────────────────────
function createEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);
    const isStandalone = !data.appointment_id;

    // A hub login may only raise estimates against its own hub. POST /estimates
    // is gated with requirePermissionOrHub, so without this a zero-permission
    // hub user could put work on another hub's books. Mirrors the identical
    // guard in purchase_invoices.controller.js#generatePurchaseInvoice.
    if (req.user?.hub_id && Number(data.hub_id) !== Number(req.user.hub_id)) {
      return res.status(403).json({ error: 'You can only create estimates for your own hub' });
    }

    // Mobile used for the "save B2B details to profile" lookup — either the
    // linked appointment's mobile, or the standalone estimate's own mobile.
    let profileMobile = data.mobile || null;
    let apptScheduledDate = null;

    if (!isStandalone) {
      // Validate appointment exists
      const apptCheck = await pool.query(
        // scheduled_date comes along because it is the natural default for the
        // estimate's date: book the appointment for the day the work happened
        // and the whole chain lands there without anyone typing a date twice.
        `SELECT id, mobile, scheduled_date::text AS scheduled_date FROM appointments WHERE id = $1`,
        [data.appointment_id]
      );
      if (!apptCheck.rows[0]) {
        return res.status(400).json({ error: `Appointment #${data.appointment_id} not found.` });
      }
      profileMobile = apptCheck.rows[0].mobile;
      apptScheduledDate = apptCheck.rows[0].scheduled_date || null;

      // Guard: only one estimate per appointment
      const dupCheck = await pool.query(
        `SELECT id, status FROM estimates WHERE appointment_id = $1 LIMIT 1`,
        [data.appointment_id]
      );
      if (dupCheck.rows[0]) {
        return res.status(409).json({
          error: `An estimate already exists for appointment #${data.appointment_id} (estimate #${dupCheck.rows[0].id}, status: ${dupCheck.rows[0].status}).`,
          existing_estimate_id: dupCheck.rows[0].id,
        });
      }
    }

    // ── Estimate date ───────────────────────────────────────────────────────
    //
    // Two completely different cases, and conflating them broke the product:
    //
    //   USER-CHOSEN date  → a deliberate backdate. Full validation, permission
    //                       required, reason required.
    //   DERIVED default   → not a decision the user made. Never validated,
    //                       never permission-gated.
    //
    // The derived default comes from the appointment's scheduled_date, which is
    // routinely in the FUTURE (that is what a booking is) and may be older than
    // the backdating window. Running the backdate rules over it meant every
    // advance booking failed with "Estimate date cannot be in the future", and
    // any staff member without BACKDATE_ESTIMATE couldn't write up yesterday's
    // job. Clamped to today instead: an estimate is written when the work is
    // being quoted, so it can never legitimately be dated ahead.
    const today = istToday();
    const derivedDefault = apptScheduledDate && apptScheduledDate < today
      ? apptScheduledDate     // job already happened — sensible starting point
      : today;                // future or same-day booking — quoted today

    const estimateDate = data.estimate_date || derivedDefault;
    const userChoseDate = !!data.estimate_date && data.estimate_date !== today;
    let dateWarnings = [];

    if (userChoseDate) {
      const settings = await loadDateSettings();
      const check = validateInvoiceDate({
        invoiceDate: estimateDate,
        documentType: 'estimate',
        settings,
        canBackdate: hasPerm(req, 'BACKDATE_ESTIMATE'),
        canOverride: data.override && hasPerm(req, 'OVERRIDE_INVOICE_DATE_LIMITS'),
        today,
      });
      if (!check.ok) return res.status(409).json(validationError(check));
      if (!data.backdate_reason) {
        return res.status(400).json({
          error: 'A reason is required when dating an estimate earlier than today.',
          code: 'REASON_REQUIRED',
        });
      }
      dateWarnings = check.warnings;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!isStandalone) {
        // Serialize concurrent creates for the same appointment, then re-check
        // the one-estimate-per-appointment guard INSIDE the transaction —
        // the pre-check above is not atomic on its own.
        await client.query(`SELECT pg_advisory_xact_lock(1, $1)`, [data.appointment_id]);
        const dupInTx = await client.query(
          `SELECT id FROM estimates WHERE appointment_id = $1 LIMIT 1`,
          [data.appointment_id]
        );
        if (dupInTx.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `An estimate already exists for appointment #${data.appointment_id}.`,
            existing_estimate_id: dupInTx.rows[0].id,
          });
        }
      }

      const ins = await client.query(
        `INSERT INTO estimates
           (appointment_id, hub_id, status, notes, created_by,
            discount_mode, transaction_discount_type, transaction_discount_value,
            is_b2b, b2b_company_name, b2b_gst_number, b2b_address,
            customer_name, mobile, whatsapp, vehicle_number,
            vehicle_type_id, make_id, model_id, body_type_id, segment_ids, cc_category_id,
            public_token, odometer_km,
            estimate_date, original_estimate_date, backdate_reason, backdated_by, backdated_at,
            updated_by)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                 $24::date, $25::date, $26, $27, $28, $29)
         RETURNING id`,
        [
          data.appointment_id || null, data.hub_id, data.notes || null, req.user.id,
          data.discount_mode, // schema defaults to 'none'
          data.transaction_discount_type || null,
          data.transaction_discount_value || 0,
          data.is_b2b || false,
          data.is_b2b ? (data.b2b_company_name || null) : null,
          data.is_b2b ? (data.b2b_gst_number   || null) : null,
          data.is_b2b ? (data.b2b_address      || null) : null,
          // Standalone customer/vehicle columns — left null when an
          // appointment is linked (the appointment remains the source of truth).
          isStandalone ? (data.customer_name   || null) : null,
          isStandalone ? (data.mobile          || null) : null,
          isStandalone ? (data.whatsapp        || null) : null,
          isStandalone ? (data.vehicle_number  || null) : null,
          isStandalone ? (data.vehicle_type_id || null) : null,
          isStandalone ? (data.make_id         || null) : null,
          isStandalone ? (data.model_id        || null) : null,
          isStandalone ? (data.body_type_id    || null) : null,
          isStandalone ? (data.segment_ids     || [])   : [],
          isStandalone ? (data.cc_category_id  || null) : null,
          generatePublicToken(),
          data.odometer_km ?? null,
          estimateDate,
          // original_estimate_date doubles as the "this job was entered
          // retroactively" flag that decides whether the PI and CI inherit
          // this date. Only set when the USER chose the date — a date that
          // merely came from the appointment is the normal path, not a
          // backdate, and shouldn't make downstream documents inherit it.
          // userChoseDate, not "date != today". A derived default is the
          // normal path, not a backdate, so it must not set the provenance
          // columns — original_estimate_date is what makes downstream
          // documents inherit this date, and inheriting an appointment date
          // nobody deliberately set is exactly the wrong behaviour.
          userChoseDate ? today : null,
          userChoseDate ? (data.backdate_reason || null) : null,
          userChoseDate ? (req.user?.id || null) : null,
          userChoseDate ? new Date() : null,
          req.user?.id || null,
        ]
      );

      const estimateId = ins.rows[0].id;

      // Make sure this mobile number has a customer routing identity
      // (public_token) even if no customer_profiles row is ever created.
      await ensureCustomerIdentity(client, profileMobile);

      // Remember the vehicle so the NEXT estimate for this customer prefills.
      //
      // Standalone estimates carry their own vehicle columns and nothing else
      // wrote them to customer_vehicles, so a hub raising a direct estimate had
      // to retype the same car on every visit — and hubs have no vehicle-write
      // endpoint (POST /customers/:mobile/vehicles is staff-only), so this is
      // the only place it can happen for them.
      //
      // ON CONFLICT DO NOTHING against the (mobile, vehicle_number) unique
      // constraint: never overwrite. If your staff have already recorded this
      // car with a colour, year or notes, an estimate must not flatten that.
      //
      // Normalisation is trim + uppercase and nothing more, deliberately: that
      // is exactly what addCustomerVehicle does, and writing a differently
      // normalised string here would defeat the unique constraint and give one
      // car two rows. (The system does still treat "GJ 01 AB 1234" and
      // "GJ01AB1234" as different plates on write — a pre-existing wrinkle.
      // The customer lookup strips punctuation when matching, so it finds
      // either form; only the write side is strict.)
      if (isStandalone && profileMobile && data.vehicle_number) {
        const plate = String(data.vehicle_number).trim().toUpperCase();
        if (plate) {
          await client.query(
            `INSERT INTO customer_vehicles
               (mobile, vehicle_number, vehicle_type_id, make_id, model_id, segment_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (mobile, vehicle_number) DO NOTHING`,
            [
              profileMobile,
              plate,
              data.vehicle_type_id || null,
              data.make_id         || null,
              data.model_id        || null,
              Array.isArray(data.segment_ids) ? (data.segment_ids[0] ?? null) : null,
            ]
          );
        }
      }

      if (data.is_b2b && data.save_b2b_to_profile) {
        await _saveB2bProfileDefault(client, profileMobile, {
          companyName: data.b2b_company_name,
          gstNumber:   data.b2b_gst_number,
          address:     data.b2b_address,
        });
      }

      const roundFn = getRoundingFunction(new Date());

      const forceZeroDiscount = ['transaction', 'none'].includes(data.discount_mode);
      for (const item of data.items) {
        const itemForCalc = forceZeroDiscount
          ? { ...item, discount_type: null, discount_value: 0, discount_amount: 0 }
          : item;
        const { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt } = computeItem(itemForCalc, roundFn);
        const svcId  = item.item_type === 'service' ? (item.service_id || item.item_id || null) : null;
        const partId = item.item_type === 'part'    ? (item.part_id    || item.item_id || null) : null;
        await client.query(
          `INSERT INTO estimate_items
             (estimate_id, item_type, service_id, part_id, description,
              quantity, customer_rate, gst_percent, gst_amount, total_inc_gst,
              is_from_appointment, hsn_sac,
              discount_type, discount_value, discount_amount, discount_source,
              warranty_months, warranty_days, warranty_km, warranty_text, warranty_source,
              guarantee_months, guarantee_days, guarantee_km, guarantee_text, guarantee_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE(
               (SELECT sac_code FROM services WHERE id = $3),
               (SELECT hsn_code FROM parts    WHERE id = $4)
             ),
             $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          [
            estimateId,
            item.item_type,
            svcId,
            partId,
            item.description,
            qty,
            rate,
            gstPct,
            gstAmount,
            totalIncGst,
            item.is_from_appointment ?? false,
            forceZeroDiscount ? null        : (item.discount_type   || null),
            forceZeroDiscount ? 0           : (item.discount_value  || 0),
            forceZeroDiscount ? 0           : discountAmt,
            forceZeroDiscount ? null        : (item.discount_source || null),
            item.warranty_months ?? null,
            item.warranty_days   ?? null,
            item.warranty_km     ?? null,
            item.warranty_text   || null,
            item.warranty_source || null,
            item.guarantee_months ?? null,
            item.guarantee_days   ?? null,
            item.guarantee_km     ?? null,
            item.guarantee_text   || null,
            item.guarantee_source || null,
          ]
        );
      }

      await recalcTotals(client, estimateId);
      await client.query('COMMIT');

      // Auto-advance appointment status to "Estimate Created"
      await advanceAppointmentStatus(data.appointment_id, 'estimate-created');

      const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [estimateId]);
      const estimate = row.rows[0];
      estimate.items = await _getItems(estimateId);

      return res.status(201).json({ item: estimate });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/estimates/:id — Update (any status; invoice sync handled by caller)
// ─────────────────────────────────────────────────────────────────────────────
function updateEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    const cur = await pool.query(`SELECT id, status, created_at, appointment_id, mobile, hub_id, warranty_claim_id FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    // The row already carries hub_id, so no extra round trip is needed here.
    // Note this also blocks a hub login from reassigning an estimate to another
    // hub: the guard runs on the CURRENT owner before data.hub_id is applied.
    assertHubOwns(req, cur.rows[0], 'hub_id', 'Estimate');

    const { status, created_at, appointment_id, mobile: standaloneMobile, hub_id: currentHubId, warranty_claim_id: claimId } = cur.rows[0];
    const roundFn = getRoundingFunction(created_at);
    // Status restriction removed — estimates can be edited at any status.
    // Invoice sync is handled separately after save.

    const hubChanged = data.hub_id !== undefined && Number(data.hub_id) !== Number(currentHubId);

    if (
      data.notes === undefined &&
      data.items === undefined &&
      data.discount_mode === undefined &&
      data.transaction_discount_type === undefined &&
      data.transaction_discount_value === undefined &&
      data.is_b2b === undefined &&
      data.b2b_company_name === undefined &&
      data.b2b_gst_number === undefined &&
      data.b2b_address === undefined &&
      !hubChanged
    ) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    // ── Hub reassignment guards ─────────────────────────────────────────────
    // Rules (see SPEC_estimate_hub_reassignment.md):
    //   no PI            → free
    //   unpaid PI        → allowed with confirm_regenerate_pi (old PI deleted)
    //   hub already paid → hard block (money moved on the old hub's terms)
    let deletedPiId = null;
    let newHubName  = null, oldHubName = null;
    if (hubChanged) {
      const hubRow = await pool.query(
        `SELECT id, hub_name, is_active FROM hubs WHERE id = $1`, [data.hub_id]);
      if (!hubRow.rows[0]) return res.status(400).json({ error: 'Selected hub does not exist.' });
      if (!hubRow.rows[0].is_active) return res.status(400).json({ error: `${hubRow.rows[0].hub_name} is inactive — pick an active hub.` });
      newHubName = hubRow.rows[0].hub_name;
      const oldHubRow = await pool.query(`SELECT hub_name FROM hubs WHERE id = $1`, [currentHubId]);
      oldHubName = oldHubRow.rows[0]?.hub_name || `Hub #${currentHubId}`;

      const piRow = await pool.query(
        `SELECT id, status, payment_status, COALESCE(amount_paid, 0) AS amount_paid, grand_total
           FROM purchase_invoices WHERE estimate_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      const pi = piRow.rows[0] || null;

      if (pi && parseFloat(pi.amount_paid) > 0) {
        return res.status(409).json({
          code: 'HUB_PAID',
          error: `Hub payout of ₹${parseFloat(pi.amount_paid).toFixed(2)} has already been made to ${oldHubName} — the hub can no longer be changed. Reverse the hub payment on Purchase Invoice PI-${String(pi.id).padStart(6, '0')} first, or create a new job for the new hub.`,
        });
      }

      // Warranty redo estimate: reassigning away from the at-fault hub while
      // the claim says 'hub bears the cost' would punish the wrong hub.
      if (claimId) {
        const claimRow = await pool.query(
          `SELECT cost_bearer, claim_code FROM warranty_claims WHERE id = $1`, [claimId]);
        const claim = claimRow.rows[0];
        if (claim?.cost_bearer === 'hub' && !data.confirm_cost_bearer_company) {
          return res.status(409).json({
            code: 'REDO_COST_BEARER',
            error: `This is a warranty-redo estimate for claim ${claim.claim_code}, where ${oldHubName} bears the redo cost. Moving the work to ${newHubName} means the company must bear the cost instead (the new hub is not at fault). Confirm to continue.`,
          });
        }
      }

      if (pi) {
        if (!data.confirm_regenerate_pi) {
          return res.status(409).json({
            code: 'PI_EXISTS',
            error: `A purchase invoice (PI-${String(pi.id).padStart(6, '0')}, ₹${parseFloat(pi.grand_total).toFixed(2)}, ${pi.status.replace(/_/g, ' ')}) was generated with ${oldHubName}'s rates. Changing the hub will DELETE it — a new PI must be generated with ${newHubName}'s rates. Confirm to continue.`,
          });
        }
        // Confirmed: remove the old (unpaid) PI so a fresh one can be
        // generated against the new hub's rates.
        await pool.query(`DELETE FROM pi_payment_schedule WHERE purchase_invoice_id = $1`, [pi.id]);
        await pool.query(`DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [pi.id]);
        await pool.query(`DELETE FROM purchase_invoices WHERE id = $1`, [pi.id]);
        deletedPiId = pi.id;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Build dynamic SET for top-level estimate fields
      const setFields = [];
      const setVals   = [];
      let   n         = 1;

      if (data.notes !== undefined) {
        setFields.push(`notes = $${n++}`); setVals.push(data.notes);
      }
      if (hubChanged) {
        setFields.push(`hub_id = $${n++}`); setVals.push(data.hub_id);
      }
      if (data.discount_mode !== undefined) {
        setFields.push(`discount_mode = $${n++}`); setVals.push(data.discount_mode);
      }
      if (data.transaction_discount_type !== undefined) {
        setFields.push(`transaction_discount_type = $${n++}`); setVals.push(data.transaction_discount_type);
      }
      if (data.transaction_discount_value !== undefined) {
        setFields.push(`transaction_discount_value = $${n++}`); setVals.push(data.transaction_discount_value);
      }

      // B2B fields — resolved as a group against the current row so a
      // partial payload (e.g. just correcting the GST number) doesn't wipe
      // out the company name / address. Turning is_b2b off always clears
      // all three sub-fields.
      const b2bTouched = data.is_b2b !== undefined
        || data.b2b_company_name !== undefined
        || data.b2b_gst_number   !== undefined
        || data.b2b_address      !== undefined;
      let nextIsB2b = null, nextCompanyName = null, nextGstNumber = null, nextAddress = null;
      if (b2bTouched) {
        const curB2b = await client.query(
          `SELECT is_b2b, b2b_company_name, b2b_gst_number, b2b_address FROM estimates WHERE id = $1`,
          [id]
        );
        const cur = curB2b.rows[0] || {};
        nextIsB2b = data.is_b2b !== undefined ? data.is_b2b : (cur.is_b2b || false);
        nextCompanyName = nextIsB2b ? (data.b2b_company_name !== undefined ? data.b2b_company_name : cur.b2b_company_name) : null;
        nextGstNumber   = nextIsB2b ? (data.b2b_gst_number   !== undefined ? data.b2b_gst_number   : cur.b2b_gst_number)   : null;
        nextAddress     = nextIsB2b ? (data.b2b_address      !== undefined ? data.b2b_address      : cur.b2b_address)     : null;

        setFields.push(`is_b2b = $${n++}`);            setVals.push(nextIsB2b);
        setFields.push(`b2b_company_name = $${n++}`);  setVals.push(nextCompanyName);
        setFields.push(`b2b_gst_number = $${n++}`);    setVals.push(nextGstNumber);
        setFields.push(`b2b_address = $${n++}`);       setVals.push(nextAddress);
      }

      if (setFields.length > 0) {
        setFields.push(`updated_at = NOW()`);
        setVals.push(id);
        await client.query(
          `UPDATE estimates SET ${setFields.join(', ')} WHERE id = $${n}`,
          setVals
        );
      }

      // Auto-sync B2B billing details to the linked Customer Invoice, if one
      // exists and hasn't been paid/cancelled yet. This is a plain field copy
      // (no pricing/recalc involved) — separate from the manual
      // sync-from-estimate flow, which only re-derives line items/totals.
      if (b2bTouched) {
        await client.query(
          `UPDATE customer_invoices
           SET is_b2b = $1, b2b_company_name = $2, b2b_gst_number = $3, b2b_address = $4, updated_at = NOW()
           WHERE estimate_id = $5 AND status NOT IN ('paid','cancelled')`,
          [nextIsB2b, nextCompanyName, nextGstNumber, nextAddress, id]
        );

        if (nextIsB2b && data.save_b2b_to_profile) {
          // Linked appointment's mobile takes priority; falls back to the
          // estimate's own mobile column for standalone estimates.
          let mobileForProfile = standaloneMobile || null;
          if (appointment_id) {
            const apptRow = await client.query(`SELECT mobile FROM appointments WHERE id = $1`, [appointment_id]);
            mobileForProfile = apptRow.rows[0]?.mobile || mobileForProfile;
          }
          await _saveB2bProfileDefault(client, mobileForProfile, {
            companyName: nextCompanyName,
            gstNumber:   nextGstNumber,
            address:     nextAddress,
          });
        }
      }

      if (data.items !== undefined) {
        // Resolve the effective discount mode (may have just been updated above)
        const modeRow = await client.query(
          `SELECT discount_mode FROM estimates WHERE id = $1`, [id]
        );
        const effectiveMode = modeRow.rows[0]?.discount_mode || 'line_item';
        const forceZeroDiscount = ['transaction', 'none'].includes(effectiveMode);

        // ── Diff, not full replace ──────────────────────────────────────────
        //
        // Lines carrying an id are UPDATEd in place; lines without one are
        // INSERTed; rows the payload no longer mentions are DELETEd. Only that
        // last group needs its inbound FKs cleared.
        //
        // This replaces a delete-every-row-and-re-insert, which was the root of
        // three separate problems: it nulled customer_invoice_items.estimate_item_id
        // on every save (severing the link the CI sync needs), it churned ids
        // that warranty_claims references, and it silently renumbered lines.
        const origRows = await client.query(
          `SELECT id, service_id, part_id, description, customer_approved, work_status
           FROM estimate_items WHERE estimate_id = $1`,
          [id]
        );
        // Keyed by id so a payload id can only ever match a row of THIS
        // estimate — an id from elsewhere falls through to INSERT.
        const existingById = new Map(origRows.rows.map(r => [Number(r.id), r]));
        const keptIds = new Set();
        // Manual items have neither service_id nor part_id — key those by
        // description so distinct manual items don't share one map entry.
        const itemKey = (svcId, partId, description) =>
          (svcId || partId) ? `${svcId ?? ''}:${partId ?? ''}` : `manual:${description ?? ''}`;
        const statusMap = {};
        for (const r of origRows.rows) {
          const key = itemKey(r.service_id, r.part_id, r.description);
          // Keep the most advanced status if same service appears twice
          if (!statusMap[key] || r.work_status === 'completed') {
            statusMap[key] = { customer_approved: r.customer_approved, work_status: r.work_status };
          }
        }

        for (const item of data.items) {
          const itemForCalc = forceZeroDiscount
            ? { ...item, discount_type: null, discount_value: 0, discount_amount: 0 }
            : item;
          const { qty, rate, gstPct, gstAmount, totalIncGst, discountAmt } = computeItem(itemForCalc, roundFn);
          const svcId  = item.item_type === 'service' ? (item.service_id || item.item_id || null) : null;
          const partId = item.item_type === 'part'    ? (item.part_id    || item.item_id || null) : null;
          const existingRow = item.id ? existingById.get(Number(item.id)) : null;

          if (existingRow) {
            // ── UPDATE in place: the id survives, so every inbound FK stays
            //    valid. hsn_sac is re-derived exactly as the INSERT does, in
            //    case the line now points at a different service or part.
            await client.query(
              `UPDATE estimate_items SET
                 item_type = $2, service_id = $3, part_id = $4, description = $5,
                 quantity = $6, customer_rate = $7, gst_percent = $8,
                 gst_amount = $9, total_inc_gst = $10, is_from_appointment = $11,
                 hsn_sac = COALESCE(
                   (SELECT sac_code FROM services WHERE id = $3),
                   (SELECT hsn_code FROM parts    WHERE id = $4)
                 ),
                 discount_type = $12, discount_value = $13, discount_amount = $14,
                 discount_source = $15,
                 warranty_months = $16, warranty_days = $17, warranty_km = $18,
                 warranty_text = $19, warranty_source = $20,
                 guarantee_months = $21, guarantee_days = $22, guarantee_km = $23,
                 guarantee_text = $24, guarantee_source = $25
               WHERE id = $1`,
              [
                existingRow.id,
                item.item_type, svcId, partId, item.description,
                qty, rate, gstPct, gstAmount, totalIncGst,
                item.is_from_appointment ?? false,
                forceZeroDiscount ? null : (item.discount_type   || null),
                forceZeroDiscount ? 0    : (item.discount_value  || 0),
                forceZeroDiscount ? 0    : discountAmt,
                forceZeroDiscount ? null : (item.discount_source || null),
                item.warranty_months ?? null,
                item.warranty_days   ?? null,
                item.warranty_km     ?? null,
                item.warranty_text   || null,
                item.warranty_source || null,
                item.guarantee_months ?? null,
                item.guarantee_days   ?? null,
                item.guarantee_km     ?? null,
                item.guarantee_text   || null,
                item.guarantee_source || null,
              ]
            );
            keptIds.add(Number(existingRow.id));

            // An existing row already carries the right approval/work status —
            // only the estimate-wide statuses below may override it. Deliberately
            // NOT reapplying statusMap here: that map is keyed by service/part,
            // so with the same service on two lines it could copy one line's
            // status onto the other.
            if (status === 'work_completed' || status === 'work_in_progress') {
              await client.query(
                `UPDATE estimate_items SET customer_approved = TRUE, work_status = $2 WHERE id = $1`,
                [existingRow.id, status === 'work_completed' ? 'completed' : 'in_progress']
              );
            }
            continue;
          }

          const insertedRow = await client.query(
            `INSERT INTO estimate_items
               (estimate_id, item_type, service_id, part_id, description,
                quantity, customer_rate, gst_percent, gst_amount, total_inc_gst,
                is_from_appointment, hsn_sac,
                discount_type, discount_value, discount_amount, discount_source,
                warranty_months, warranty_days, warranty_km, warranty_text, warranty_source,
                guarantee_months, guarantee_days, guarantee_km, guarantee_text, guarantee_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE(
                 (SELECT sac_code FROM services WHERE id = $3),
                 (SELECT hsn_code FROM parts    WHERE id = $4)
               ),
               $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
             RETURNING id`,
            [
              id,
              item.item_type,
              svcId,
              partId,
              item.description,
              qty,
              rate,
              gstPct,
              gstAmount,
              totalIncGst,
              item.is_from_appointment ?? false,
              forceZeroDiscount ? null : (item.discount_type   || null),
              forceZeroDiscount ? 0    : (item.discount_value  || 0),
              forceZeroDiscount ? 0    : discountAmt,
              forceZeroDiscount ? null : (item.discount_source || null),
              item.warranty_months ?? null,
              item.warranty_days   ?? null,
              item.warranty_km     ?? null,
              item.warranty_text   || null,
              item.warranty_source || null,
              item.guarantee_months ?? null,
              item.guarantee_days   ?? null,
              item.guarantee_km     ?? null,
              item.guarantee_text   || null,
              item.guarantee_source || null,
            ]
          );

          // Restore original approval + work status using the exact new item id.
          // Priority:
          //   1. If estimate is work_completed → all items must be completed & approved
          //   2. Else use statusMap (per-item saved status)
          //   3. Else leave as default (null / pending)
          const newItemId = insertedRow.rows[0].id;
          let restoredApproved = null;
          let restoredStatus   = null;

          if (status === 'work_completed' || status === 'work_in_progress') {
            restoredApproved = true;
            restoredStatus   = status === 'work_completed' ? 'completed' : 'in_progress';
          } else {
            const origKey = itemKey(svcId, partId, item.description);
            const orig    = statusMap[origKey];
            if (orig && orig.work_status) {
              restoredApproved = orig.customer_approved;
              restoredStatus   = orig.work_status;
            }
          }

          if (restoredStatus) {
            await client.query(
              `UPDATE estimate_items SET customer_approved = $1, work_status = $2 WHERE id = $3`,
              [restoredApproved, restoredStatus, newItemId]
            );
          }
          keptIds.add(Number(newItemId));
        }

        // ── Remove only the lines the payload dropped ───────────────────────
        // Their inbound FKs are cleared first, exactly as before — but now for
        // these rows alone, so surviving lines keep their invoice links.
        const removedIds = origRows.rows
          .map(r => Number(r.id))
          .filter(rid => !keptIds.has(rid));

        if (removedIds.length) {
          await client.query(
            `UPDATE purchase_invoice_items SET estimate_item_id = NULL
             WHERE estimate_item_id = ANY($1::int[])`,
            [removedIds]
          );
          await client.query(
            `UPDATE customer_invoice_items SET estimate_item_id = NULL
             WHERE estimate_item_id = ANY($1::int[])`,
            [removedIds]
          );
          await client.query(
            `DELETE FROM estimate_items WHERE id = ANY($1::int[])`,
            [removedIds]
          );
        }

        await recalcTotals(client, id);
      } else if (
        data.discount_mode !== undefined ||
        data.transaction_discount_type !== undefined ||
        data.transaction_discount_value !== undefined
      ) {
        // Discount mode changed but items not resent — just recalc totals
        await recalcTotals(client, id);
      }

      // ── Hub reassignment side effects (same transaction) ──────────────────
      if (hubChanged) {
        // Keep the linked appointment on the same hub (its appointment_code
        // stays frozen by design — codes always reflect the original booking)
        if (appointment_id) {
          await client.query(
            `UPDATE appointments SET hub_id = $1, updated_at = NOW() WHERE id = $2`,
            [data.hub_id, appointment_id]
          );
        }
        // Keep an existing customer invoice's hub display/scoping in sync
        await client.query(
          `UPDATE customer_invoices SET hub_id = $1, updated_at = NOW() WHERE estimate_id = $2`,
          [data.hub_id, id]
        );
        // Redo estimate moved away from the at-fault hub → company bears cost
        if (claimId && data.confirm_cost_bearer_company) {
          await client.query(
            `UPDATE warranty_claims SET cost_bearer = 'company', updated_at = NOW()
              WHERE id = $1 AND cost_bearer = 'hub'`,
            [claimId]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (hubChanged) {
      logActivity({
        userId: req.user?.id, userName: req.user?.name,
        action: 'estimate_hub_reassigned', entity: 'estimate', entityId: id,
        description: `Hub reassigned ${oldHubName} → ${newHubName}${deletedPiId ? ` (PI-${String(deletedPiId).padStart(6, '0')} deleted for regeneration)` : ''}`,
      });
      getIO().emit('invalidate', { topic: 'appointments' });
      getIO().emit('invalidate', { topic: 'purchase_invoices' });
    }

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({
      item: estimate,
      ...(hubChanged ? {
        hub_reassigned: { from: oldHubName, to: newHubName },
        pi_deleted: deletedPiId ? `PI-${String(deletedPiId).padStart(6, '0')}` : null,
      } : {}),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/submit — Hub submits for company review
// ─────────────────────────────────────────────────────────────────────────────
function submitEstimate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertEstimateHub(req, id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    const { status } = cur.rows[0];
    if (!['draft', 'revision_requested'].includes(status)) {
      return res.status(409).json({
        error: `Only draft or revision_requested estimates can be submitted. Current status: '${status}'.`,
      });
    }

    // Must have at least 1 item
    const itemCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM estimate_items WHERE estimate_id = $1`,
      [id]
    );
    if (itemCount.rows[0].cnt === 0) {
      return res.status(400).json({ error: 'Estimate must have at least one item before submitting.' });
    }

    await pool.query(
      `UPDATE estimates SET status = 'pending_company_review', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);

    // Auto-advance appointment status
    await advanceAppointmentStatus(estimate.appointment_id, 'estimate-submitted');

    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/company-approve — Company approves → sent_to_customer
// ─────────────────────────────────────────────────────────────────────────────
function companyApprove(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    await _assertEstimateHub(req, id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    if (cur.rows[0].status !== 'pending_company_review') {
      return res.status(409).json({
        error: `Only estimates in 'pending_company_review' can be approved. Current status: '${cur.rows[0].status}'.`,
      });
    }

    await pool.query(
      `UPDATE estimates
       SET status = 'sent_to_customer', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, id]
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);

    // Auto-advance appointment status
    await advanceAppointmentStatus(estimate.appointment_id, 'estimate-approved');

    // ── Tell the customer their estimate is ready ──────────────────────────
    //
    // HERE, not on submit. Submitting sets 'pending_company_review' — the hub
    // has proposed a price and Spinoto has not checked it. Messaging then would
    // send the customer a figure nobody approved, and link them to a page that
    // correctly refuses to show an unreviewed estimate. This endpoint is where
    // the estimate literally becomes 'sent_to_customer'.
    //
    // Fired directly rather than through advanceAppointmentStatus, and with
    // entityType 'estimate' — the same pattern invoice_ready already uses.
    // A status-triggered send always loads the APPOINTMENT context, which has
    // no grand_total and no estimate token, so estimate_amount and
    // estimate_link would both come back undefined and the dispatcher would
    // refuse to queue. That is why this template never sent.
    //
    // Which template(s) fire is the 'estimate.sent' automation rows
    // (Settings → WhatsApp → Automations, migration 151).
    // fireWhatsAppEventDetached owns the connection, transaction and logging;
    // failures are swallowed there — a messaging problem must not make an
    // approved estimate look unapproved.
    await fireWhatsAppEventDetached(pool, {
      event: 'estimate.sent',
      entityId: id,
      // An estimate is sent to the customer once. A retried request that
      // reached here twice produces one message.
      dedupeKey: `sent:${id}`,
    });

    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/company-revise — Company requests revision
// ─────────────────────────────────────────────────────────────────────────────
function companyRevise(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = companyReviseSchema.parse(req.body);

    await _assertEstimateHub(req, id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    if (cur.rows[0].status !== 'pending_company_review') {
      return res.status(409).json({
        error: `Only estimates in 'pending_company_review' can be sent back for revision. Current status: '${cur.rows[0].status}'.`,
      });
    }

    const fields = [`status = 'revision_requested'`, `updated_at = NOW()`];
    const params = [];

    if (data.notes !== undefined) {
      params.push(data.notes);
      fields.push(`notes = $${params.length}`);
    }

    params.push(id);
    await pool.query(
      `UPDATE estimates SET ${fields.join(', ')} WHERE id = $${params.length}`,
      params
    );

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimates/:id/customer-approval — Company marks customer approvals
// ─────────────────────────────────────────────────────────────────────────────
function customerApproval(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = customerApprovalSchema.parse(req.body);

    await _assertEstimateHub(req, id);

    const cur = await pool.query(`SELECT id, status FROM estimates WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    const allowedStatuses = ['sent_to_customer', 'partially_approved', 'fully_approved', 'work_in_progress'];
    if (!allowedStatuses.includes(cur.rows[0].status)) {
      return res.status(409).json({
        error: `Customer approvals can only be recorded when status is one of: ${allowedStatuses.join(', ')}. Current status: '${cur.rows[0].status}'.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The per-item write, the work_status reset and the status derivation all
      // moved to services/estimateApproval.service.js. Not for tidiness: the
      // customer's own approval link now runs the SAME function, so an estimate
      // ends up in identical state whether an advisor ticked the boxes here or
      // the customer did it from their phone. Two implementations of "what do
      // these items make this estimate" is how those two views drift apart.
      await applyItemApprovals(client, id, data.approvals);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const row = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [id]);
    const estimate = row.rows[0];
    estimate.items = await _getItems(id);
    return res.json({ item: estimate });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/estimates/:id/items/:itemId/work-status — Hub updates item work status
// ─────────────────────────────────────────────────────────────────────────────
function updateItemWorkStatus(req, res, next) {
  handle(req, res, next, async () => {
    const estimateId = idParam.parse(req.params.id);
    const itemId     = idParam.parse(req.params.itemId);

    const { work_status } = z.object({
      work_status: z.enum(['pending', 'in_progress', 'completed']),
    }).parse(req.body);

    await _assertEstimateHub(req, estimateId);

    // Validate item belongs to this estimate and is customer_approved
    const itemRow = await pool.query(
      `SELECT id, customer_approved FROM estimate_items WHERE id = $1 AND estimate_id = $2`,
      [itemId, estimateId]
    );
    if (itemRow.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    if (!itemRow.rows[0].customer_approved) {
      return res.status(400).json({ error: 'Cannot update work status for a rejected or pending-approval item' });
    }

    // Validate estimate is in a workable state
    const estRow = await pool.query(`SELECT status FROM estimates WHERE id = $1`, [estimateId]);
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });
    const allowedStatuses = ['fully_approved', 'partially_approved', 'work_in_progress', 'work_completed'];
    if (!allowedStatuses.includes(estRow.rows[0].status)) {
      return res.status(400).json({ error: `Work cannot be updated when estimate is in status: ${estRow.rows[0].status}` });
    }

    let newEstStatus;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update the item
      await client.query(
        `UPDATE estimate_items SET work_status = $1, updated_at = NOW() WHERE id = $2`,
        [work_status, itemId]
      );

      // Derive new estimate status from all approved items' work_status
      const allItems = await client.query(
        `SELECT work_status FROM estimate_items WHERE estimate_id = $1 AND customer_approved = true`,
        [estimateId]
      );
      const statuses = allItems.rows.map(r => r.work_status);
      if (statuses.every(s => s === 'completed')) {
        newEstStatus = 'work_completed';
      } else if (statuses.some(s => s === 'in_progress' || s === 'completed')) {
        newEstStatus = 'work_in_progress';
      } else {
        // all pending — revert to approved state
        // check if partially or fully approved
        const approvalCheck = await client.query(
          `SELECT COUNT(*) FILTER (WHERE customer_approved = true)  AS approved_count,
                  COUNT(*) FILTER (WHERE customer_approved = false) AS rejected_count
           FROM estimate_items WHERE estimate_id = $1`,
          [estimateId]
        );
        const { approved_count, rejected_count } = approvalCheck.rows[0];
        newEstStatus = parseInt(rejected_count) > 0 ? 'partially_approved' : 'fully_approved';
      }

      await client.query(
        `UPDATE estimates SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newEstStatus, estimateId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Return updated estimate
    const est = await pool.query(`${EST_SELECT} WHERE e.id = $1`, [estimateId]);
    const items = await _getItems(estimateId);

    // Auto-advance appointment status based on work state
    const apptId = est.rows[0]?.appointment_id;
    if (newEstStatus === 'work_in_progress') {
      await advanceAppointmentStatus(apptId, 'work-in-progress');
    } else if (newEstStatus === 'work_completed') {
      await advanceAppointmentStatus(apptId, 'work-completed');
    }

    return res.json({ item: { ...est.rows[0], items } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/estimates/:id — Super admin only
// Cascade: CI payments → CI items → CI → PI schedule → PI payments → PI items
//          → estimate items → estimate
// Blocked if CI is paid or PI payment_status is paid
// ─────────────────────────────────────────────────────────────────────────────
function deleteEstimate(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Only super admins can delete estimates.' });
    }

    const id = idParam.parse(req.params.id);

    const estRow = await pool.query(`SELECT id FROM estimates WHERE id = $1`, [id]);
    if (!estRow.rows[0]) return res.status(404).json({ error: 'Estimate not found' });

    // Check CI
    const ciRow = await pool.query(
      `SELECT id, status FROM customer_invoices WHERE estimate_id = $1 LIMIT 1`, [id]
    );
    const ci = ciRow.rows[0] || null;
    if (ci && ci.status === 'paid') {
      return res.status(400).json({ error: 'Cannot delete — Customer Invoice is already paid.' });
    }

    // Check ALL PIs (an estimate can have more than one purchase invoice)
    const piRows = await pool.query(
      `SELECT id, payment_status FROM purchase_invoices WHERE estimate_id = $1 ORDER BY id DESC`, [id]
    );
    const pis = piRows.rows;
    if (pis.some(p => p.payment_status === 'paid')) {
      return res.status(400).json({ error: 'Cannot delete — a Purchase Invoice is already paid.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete CI
      if (ci) {
        await client.query(`DELETE FROM customer_invoice_payments WHERE customer_invoice_id = $1`, [ci.id]);
        await client.query(`DELETE FROM customer_invoice_items    WHERE customer_invoice_id = $1`, [ci.id]);
        await client.query(`DELETE FROM customer_invoices          WHERE id = $1`, [ci.id]);
      }

      // Delete ALL PIs linked to this estimate
      for (const pi of pis) {
        await client.query(`DELETE FROM pi_payment_schedule WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM hub_payments         WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM purchase_invoices     WHERE id = $1`, [pi.id]);
      }

      // Delete estimate
      await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [id]);
      await client.query(`DELETE FROM estimates       WHERE id = $1`, [id]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listEstimates,
  getEstimate,
  getEstimatePdf,
  getEstimateByToken,
  createEstimate,
  updateEstimate,
  submitEstimate,
  companyApprove,
  companyRevise,
  customerApproval,
  updateItemWorkStatus,
  deleteEstimate,
  estimateDatePreflight,
  updateEstimateDate,
};
