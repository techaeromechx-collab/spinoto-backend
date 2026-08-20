'use strict';

/**
 * Settings controller
 *
 * GET  /api/settings/company   — fetch company details (any authenticated user)
 * PUT  /api/settings/company   — update company details (super admin only)
 */

const { z }    = require('zod');
const path     = require('path');
const fs       = require('fs');
const { pool } = require('../config/db');
const { uploadToImageKit, deleteFromImageKit } = require('../utils/imagekit');
const { getTheme } = require('../templates/invoiceThemes/registry');
const { istToday } = require('../utils/invoiceDate');
const { logActivity } = require('../services/activityLog.service');
// buildDocument / qrDataUri / publicDocumentUrl / qrEnabled are no longer
// needed here: renderHtml owns document building, asset inlining and the QR.
const { loadCompany, pageSizeFor, renderHtml } = require('../utils/renderDocument');
const {
  DOC_TYPES, VALID_THEMES: VALID_INVOICE_THEMES,
  documentConfigSchema, resolveDocumentConfig, resolveFullConfig,
} = require('../utils/documentConfig');

function imagekitEnabled() {
  return !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT);
}

function assetDiskPath(fileUrl, dir) {
  return path.join(__dirname, '../../uploads', dir, path.basename(fileUrl));
}
const logoDiskPath = (u) => assetDiskPath(u, 'company-logo');

function safeUnlink(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ─── Validator ────────────────────────────────────────────────────────────────
// VALID_INVOICE_THEMES / documentConfigSchema now live in
// utils/documentConfig.js (imported above) so the theme list and the config
// validator have a single home shared with the templates.

const companySchema = z.object({
  company_name:  z.string().trim().max(200).default(''),
  address_line1: z.string().trim().max(300).default(''),
  address_line2: z.string().trim().max(300).default(''),
  city:          z.string().trim().max(100).default(''),
  state:         z.string().trim().max(100).default(''),
  pincode:       z.string().trim().max(10).default(''),
  phone:         z.string().trim().max(20).default(''),
  email:         z.string().trim().max(200).default(''),
  gstin:         z.string().trim().max(20).default(''),
  invoice_theme: z.enum(VALID_INVOICE_THEMES).default('simple'),
  invoice_accent_color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Accent color must be a hex code like #4f46e5').default('#4f46e5'),
  // Optional: a client that doesn't know about display config (or is only
  // saving company details) simply omits it and the stored config is left
  // untouched — see the COALESCE in upsertCompany.
  document_config: documentConfigSchema,
});

// ─── GET /api/settings/company ────────────────────────────────────────────────
async function getCompany(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT company_name, address_line1, address_line2, city, state,
              pincode, phone, email, gstin, invoice_theme,
              invoice_accent_color, logo_url, signature_url, document_config, updated_at
       FROM company_settings WHERE id = 1 LIMIT 1`
    );
    if (rows.length === 0) {
      // Return empty object if table row not seeded yet
      return res.json({
        company_name: '', address_line1: '', address_line2: '',
        city: '', state: '', pincode: '', phone: '', email: '', gstin: '',
        invoice_theme: 'simple', invoice_accent_color: '#4f46e5', logo_url: null, signature_url: null,
        document_config: resolveFullConfig(null),
      });
    }
    // A hub login gets the identity block only.
    //
    // It needs this: on the hub's own sales invoice the company is the Bill To
    // party, so the name, address and GSTIN belong on their screen — the PDF
    // already prints them. It does NOT need document_config, which carries the
    // company's bank details, nor the theme/logo settings it cannot change.
    // Narrowing here rather than widening the route keeps the settings surface
    // staff-only by default.
    if (req.user?.hub_id) {
      const { company_name, address_line1, address_line2, city, state, pincode, phone, email, gstin } = rows[0];
      return res.json({ company_name, address_line1, address_line2, city, state, pincode, phone, email, gstin });
    }

    // Always hand back a fully-resolved config for ALL THREE document types
    // (defaults merged in) so the settings UI can bind checkboxes directly
    // without null-checking every flag.
    return res.json({ ...rows[0], document_config: resolveFullConfig(rows[0].document_config) });
  } catch (err) {
    console.error('[settings] getCompany error:', err);
    return res.status(500).json({ error: 'Failed to fetch company settings.' });
  }
}

// ─── PUT /api/settings/company/document-config ────────────────────────────────
//
// The Invoice Settings tab's save. Writes ONLY the document config and the
// accent colour.
//
// It exists because that tab used to save through PUT /settings/company, which
// takes the entire company object — company_name, gstin, address. That was
// harmless while the tab was super-admin-only, but it makes the permission
// MANAGE_DOCUMENT_SETTINGS impossible to grant safely: anyone who could change
// a theme could also change the GSTIN printed on every invoice.
//
// Narrow endpoint, narrow permission. Company identity stays on the old route
// behind the super-admin check.
const documentConfigOnlySchema = z.object({
  invoice_accent_color: z.string().trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Accent color must be a hex code like #4f46e5')
    .optional(),
  document_config: documentConfigSchema,
});

/**
 * PUT /api/settings/advance-rate — the GST rate on advance receipts.
 *
 * ── WHY THIS IS NOT A FIELD ON PUT /company ────────────────────────────────
 * That endpoint is gated on MANAGE_MASTER_DATA, which is held by whoever
 * maintains services, locations and vehicles. This value is the tax rate
 * PRINTED ON A CUSTOMER-FACING TAX DOCUMENT, and it belongs with the gateway
 * settings for the same reason the security brief keeps refunds and credentials
 * there: getting it wrong is a compliance problem, not a typo.
 *
 * Same shape as upsertDocumentConfig directly above — a narrow endpoint with
 * its own permission, rather than widening a broad one.
 *
 * ── NULL IS A FEATURE, NOT AN EMPTY FIELD ──────────────────────────────────
 * Setting it to NULL switches taking-payment-with-no-job off entirely: the
 * endpoint refuses and the Take Payment button stops rendering
 * (advances.service.accountCreditRate). That is a genuine kill switch and until
 * now it could only be reached with SQL. So null is accepted explicitly rather
 * than treated as "field omitted" — which is why the schema below distinguishes
 * the two.
 */
const advanceRateSchema = z.object({
  // .nullable() BEFORE .optional() matters: nullable alone would reject an
  // absent key, and optional alone would reject an explicit null — and null is
  // the case this endpoint exists to make reachable.
  //
  // The range mirrors the database constraint company_advance_rate_range
  // (NULL OR between 0 and 100) so the two cannot drift apart.
  advance_default_gst_rate: z.coerce.number().min(0).max(100).nullable().optional(),
});

async function upsertAdvanceRate(req, res) {
  const parsed = advanceRateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.errors[0]?.message || 'Validation error.' });
  }
  // `in` rather than a truthiness check: 0 is a legitimate rate (an exempt
  // category) and null is the kill switch. Both are falsy.
  if (!('advance_default_gst_rate' in parsed.data)) {
    return res.status(422).json({ error: 'No rate supplied.' });
  }
  const rate = parsed.data.advance_default_gst_rate;

  try {
    const { rows } = await pool.query(
      `UPDATE company_settings
          SET advance_default_gst_rate = $1, updated_at = NOW()
        WHERE id = 1
      RETURNING advance_default_gst_rate`,
      [rate]);
    if (!rows[0]) return res.status(404).json({ error: 'Company settings not found.' });

    const saved = rows[0].advance_default_gst_rate;
    console.log(`[settings] advance GST rate set to ${saved === null ? 'NULL (feature off)' : saved + '%'}`
      + ` by user ${req.user?.id}`);
    res.json({
      enabled: saved !== null && saved !== undefined,
      gst_rate: saved === null || saved === undefined ? null : Number(saved),
    });
  } catch (err) {
    // The CHECK constraint is the backstop if the Zod range is ever widened.
    if (err.code === '23514') {
      return res.status(422).json({ error: 'The rate must be between 0 and 100.' });
    }
    throw err;
  }
}

async function upsertDocumentConfig(req, res) {
  const parsed = documentConfigOnlySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.errors[0]?.message || 'Validation error.' });
  }
  const d = parsed.data;

  // Resolved to a complete object before storing, so the blob is never partial
  // — same contract as upsertCompany.
  const configParam = d.document_config === undefined
    ? null
    : JSON.stringify(resolveFullConfig(d.document_config));

  try {
    // COALESCE on both: omitting either field leaves the stored value alone
    // rather than blanking it.
    const { rows } = await pool.query(
      `UPDATE company_settings
          SET document_config      = COALESCE($1::jsonb, document_config),
              invoice_accent_color = COALESCE($2, invoice_accent_color),
              updated_at           = NOW()
        WHERE id = 1
      RETURNING company_name, address_line1, address_line2, city, state,
                pincode, phone, email, gstin, invoice_theme,
                invoice_accent_color, logo_url, signature_url, document_config, updated_at`,
      [configParam, d.invoice_accent_color ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Company settings not found.' });
    const item = { ...rows[0], document_config: resolveFullConfig(rows[0].document_config) };
    return res.json({ item, message: 'Document settings saved.' });
  } catch (err) {
    console.error('[settings] upsertDocumentConfig error:', err);
    return res.status(500).json({ error: 'Failed to save document settings.' });
  }
}

// ─── Books lock (SPEC_backdated_customer_invoice.md, phase 2) ─────────────────
//
// The only mechanism that can stop a backdated invoice landing in a GST period
// already filed. Deliberately its own endpoint and its own permission
// (MANAGE_BOOKS_LOCK) rather than part of the company or document settings:
// the person who closes the books is usually not the person who edits a theme,
// and PUT /company would let them rewrite the GSTIN on the way past.

const booksLockSchema = z.object({
  // null clears the lock. Explicit null is meaningful here, so `.nullable()`
  // rather than treating undefined and null the same.
  books_locked_through: z.string().trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'books_locked_through must be YYYY-MM-DD')
    .nullable().optional(),
  backdate_max_days: z.coerce.number().int()
    .min(0, 'Window cannot be negative.')
    .max(3650, 'Window cannot exceed 10 years.')
    .optional(),
});

// Postgres 42703 = undefined_column. Every endpoint added by migrations 099
// and 100 depends on columns that don't exist until those are applied, and a
// bare 500 makes that look like a code fault rather than a pending migration.
// Naming it saves the next person the debugging session.
const MIGRATION_HINT =
  'The accounting period columns are missing. Apply migration ' +
  '100_invoice_backdating.sql (and 099_invoice_date.sql if not already applied).';

function isMissingColumn(err) {
  return err?.code === '42703';
}

async function getBooksLock(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT books_locked_through::text AS books_locked_through,
              books_locked_at, backdate_max_days,
              (SELECT name FROM users u WHERE u.id = cs.books_locked_by) AS books_locked_by_name
         FROM company_settings cs ORDER BY id LIMIT 1`
    );
    return res.json(rows[0] || {
      books_locked_through: null, books_locked_at: null,
      backdate_max_days: 30, books_locked_by_name: null,
    });
  } catch (err) {
    console.error('[settings] getBooksLock error:', err);
    if (isMissingColumn(err)) return res.status(503).json({ error: MIGRATION_HINT, code: 'MIGRATION_PENDING' });
    return res.status(500).json({ error: 'Failed to load accounting period settings.' });
  }
}

async function upsertBooksLock(req, res) {
  const parsed = booksLockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.errors[0]?.message || 'Validation error.' });
  }
  const d = parsed.data;

  // A lock date in the future would retroactively invalidate invoices the
  // system has already issued today, which is never what anyone means.
  if (d.books_locked_through && d.books_locked_through > istToday()) {
    return res.status(422).json({ error: 'Cannot close the books through a future date.' });
  }

  try {
    const clearing = d.books_locked_through === null;
    const { rows } = await pool.query(
      // ORDER BY id LIMIT 1 to match how every reader resolves the row
      // (estimates/customer_invoices/purchase_invoices all use that form). The
      // writer used `WHERE id = 1`; with a second settings row ever present the
      // lock would be written to one row and read from another — a books lock
      // that silently doesn't apply.
      `UPDATE company_settings
          SET books_locked_through = CASE WHEN $4 THEN NULL
                                          ELSE COALESCE($1::date, books_locked_through) END,
              books_locked_by      = CASE WHEN $1::date IS NULL AND NOT $4 THEN books_locked_by
                                          ELSE $2 END,
              books_locked_at      = CASE WHEN $1::date IS NULL AND NOT $4 THEN books_locked_at
                                          ELSE NOW() END,
              backdate_max_days    = COALESCE($3, backdate_max_days),
              updated_at           = NOW()
        WHERE id = (SELECT id FROM company_settings ORDER BY id LIMIT 1)
      RETURNING books_locked_through::text AS books_locked_through,
                books_locked_at, backdate_max_days,
                (SELECT name FROM users u WHERE u.id = company_settings.books_locked_by) AS books_locked_by_name`,
      [d.books_locked_through ?? null, req.user?.id || null,
       d.backdate_max_days ?? null, clearing]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Company settings not found.' });

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'company_settings',
      entityId: 1,
      description: clearing
        ? 'Cleared the accounting period lock'
        : `Books locked through ${rows[0].books_locked_through}` +
          (d.backdate_max_days != null ? `; backdating window set to ${d.backdate_max_days} days` : ''),
    });

    return res.json({ item: rows[0], message: 'Accounting period settings saved.' });
  } catch (err) {
    console.error('[settings] upsertBooksLock error:', err);
    if (isMissingColumn(err)) return res.status(503).json({ error: MIGRATION_HINT, code: 'MIGRATION_PENDING' });
    return res.status(500).json({ error: 'Failed to save accounting period settings.' });
  }
}

// ─── PUT /api/settings/company ────────────────────────────────────────────────
async function upsertCompany(req, res) {
  // Super-admin guard
  if (!req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Only super admins can update company settings.' });
  }

  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.errors[0]?.message || 'Validation error.' });
  }

  const d = parsed.data;
  try {
    // Note: logo_url/logo_file_id are deliberately NOT written here — they're
    // only ever set by the dedicated POST/DELETE /api/settings/company/logo
    // endpoints, so a routine "save company details" call can never
    // accidentally wipe out (or requires re-sending) the uploaded logo.
    //
    // document_config gets the same protection via a different mechanism: it's
    // optional in the schema, and a NULL param COALESCEs to the stored value.
    // That means the "Manage Business" tab (which knows nothing about invoice
    // display settings and doesn't send them) can't blank out the config that
    // the Document Settings tab wrote. When it IS sent it's resolved to a
    // complete object first, so the stored blob is never partial — the client
    // always holds a fully-resolved config, so a config PUT is a full replace.
    const configParam = d.document_config === undefined
      ? null
      : JSON.stringify(resolveFullConfig(d.document_config));

    const { rows } = await pool.query(
      `INSERT INTO company_settings
         (id, company_name, address_line1, address_line2, city, state,
          pincode, phone, email, gstin, invoice_theme, invoice_accent_color,
          document_config, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               COALESCE($12::jsonb, '{}'::jsonb), NOW())
       ON CONFLICT (id) DO UPDATE SET
         company_name  = EXCLUDED.company_name,
         address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2,
         city          = EXCLUDED.city,
         state         = EXCLUDED.state,
         pincode       = EXCLUDED.pincode,
         phone         = EXCLUDED.phone,
         email         = EXCLUDED.email,
         gstin         = EXCLUDED.gstin,
         invoice_theme = EXCLUDED.invoice_theme,
         invoice_accent_color = EXCLUDED.invoice_accent_color,
         document_config = COALESCE($12::jsonb, company_settings.document_config),
         updated_at    = NOW()
       RETURNING company_name, address_line1, address_line2, city, state,
                 pincode, phone, email, gstin, invoice_theme,
                 invoice_accent_color, logo_url, signature_url, document_config, updated_at`,
      [d.company_name, d.address_line1, d.address_line2, d.city, d.state,
       d.pincode, d.phone, d.email, d.gstin, d.invoice_theme, d.invoice_accent_color,
       configParam]
    );
    const item = { ...rows[0], document_config: resolveFullConfig(rows[0].document_config) };
    return res.json({ item, message: 'Company settings saved.' });
  } catch (err) {
    console.error('[settings] upsertCompany error:', err);
    return res.status(500).json({ error: 'Failed to save company settings.' });
  }
}

// ─── Default alert settings ───────────────────────────────────────────────────
const DEFAULT_ALERT_SETTINGS = {
  no_activity_hours:        2,
  inactive_lead_days:       7,
  daily_target_hour:        18,
  escalation_overdue_days:  3,
  escalation_missed_count:  2,
  work_start_hour:          9,
  work_end_hour:            18,
};

// ─── GET /api/settings/alert ──────────────────────────────────────────────────
async function getAlertSettings(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT alert_settings FROM company_settings WHERE id = 1 LIMIT 1`
    );
    const saved = rows[0]?.alert_settings || {};
    return res.json({ ...DEFAULT_ALERT_SETTINGS, ...saved });
  } catch (err) {
    console.error('[settings] getAlertSettings error:', err);
    return res.status(500).json({ error: 'Failed to fetch alert settings.' });
  }
}

// ─── PUT /api/settings/alert ──────────────────────────────────────────────────
async function upsertAlertSettings(req, res) {
  // Authorisation is the route's requirePermission('MANAGE_REMINDERS').
  //
  // The inline is_super_admin check that used to sit here has been removed
  // deliberately: it would have overruled the permission, so a user who was
  // granted MANAGE_REMINDERS could open the tab and then get a 403 on save.
  // Super admins still pass, because they bypass every permission check.
  const body = req.body || {};
  // Merge with defaults — only accept known keys, coerce to int
  const merged = { ...DEFAULT_ALERT_SETTINGS };
  for (const key of Object.keys(DEFAULT_ALERT_SETTINGS)) {
    if (body[key] !== undefined) {
      const val = parseInt(body[key], 10);
      if (!isNaN(val) && val > 0) merged[key] = val;
    }
  }

  try {
    await pool.query(
      `INSERT INTO company_settings (id, alert_settings, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET
         alert_settings = EXCLUDED.alert_settings,
         updated_at     = NOW()`,
      [JSON.stringify(merged)]
    );
    return res.json({ ok: true, alert_settings: merged });
  } catch (err) {
    console.error('[settings] upsertAlertSettings error:', err);
    return res.status(500).json({ error: 'Failed to save alert settings.' });
  }
}

// ─── POST /api/settings/company/logo ──────────────────────────────────────────
// multer (memoryStorage if ImageKit is configured, else diskStorage into
// uploads/company-logo/) processes the file BEFORE this handler runs — same
// pattern as hub_documents.controller.js's uploadDocument.
async function uploadLogo(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Clean up whatever logo was previously set before saving the new one
    const existing = await pool.query(
      `SELECT logo_url, logo_file_id FROM company_settings WHERE id = 1 LIMIT 1`
    );
    const old = existing.rows[0];
    if (old?.logo_url) {
      if (old.logo_file_id) {
        await deleteFromImageKit(old.logo_file_id);
      } else {
        safeUnlink(logoDiskPath(old.logo_url));
      }
    }

    let logoUrl    = null;
    let logoFileId = null;

    if (imagekitEnabled()) {
      const result = await uploadToImageKit(req.file.buffer, req.file.originalname, 'company-logo');
      logoUrl    = result.url;
      logoFileId = result.fileId;
      if (req.file.path) safeUnlink(req.file.path);
    } else {
      logoUrl = `/uploads/company-logo/${req.file.filename}`;
    }

    const { rows } = await pool.query(
      `INSERT INTO company_settings (id, logo_url, logo_file_id, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         logo_url      = EXCLUDED.logo_url,
         logo_file_id  = EXCLUDED.logo_file_id,
         updated_at    = NOW()
       RETURNING logo_url`,
      [logoUrl, logoFileId]
    );
    return res.status(201).json({ logo_url: rows[0].logo_url });
  } catch (err) {
    if (req.file?.path) safeUnlink(req.file.path);
    if (err.name === 'CircuitBreakerOpenError' || err.name === 'CircuitBreakerBusyError' || err.name === 'CircuitBreakerTimeoutError') {
      return res.status(err.status || 503).json({ error: 'Logo storage is temporarily unavailable. Please try again shortly.' });
    }
    console.error('[settings] uploadLogo error:', err);
    return res.status(500).json({ error: 'Failed to upload logo.' });
  }
}

// ─── POST /api/settings/company/invoice-theme-preview ─────────────────────────
// Renders a theme against a fixed, realistic SAMPLE document — not a real row —
// so the settings page can show a genuine live preview (real HTML from the same
// render() used for actual PDFs, not a mockup) without needing an existing
// document to point at. Returns raw HTML so the frontend can drop it straight
// into an <iframe srcDoc=...>.
//
// POST rather than GET because the body carries the caller's UNSAVED config —
// the whole point is previewing toggles before committing them, and the config
// is far too big for a query string. theme/color/config/docType all fall back
// to saved values when omitted.
//
// The samples are deliberately built so EVERY toggle visibly changes something:
// a free line, batch/mfg/exp dates, a discount, a second GST rate, price
// history, PO number, e-way bill, custom field/column values and an
// outstanding balance. A toggle that produced no visible change would read as
// a broken switch.
const SAMPLE_ITEMS = [
  {
    id: 1, item_type: 'service', description: 'Engine Oil Change (Synthetic)',
    item_description: 'Castrol EDGE 5W-30, 3.5 L + filter',
    quantity: 1, customer_rate: 1200, hub_rate: 960, commission_percent: 20,
    gst_percent: 18, gst_amount: 216, total_inc_gst: 1416, total_payable: 1133,
    hsn_sac: '2710', discount_amount: 0,
    batch_no: 'BT-4471', mfg_date: '2026-01-12', exp_date: '2029-01-12',
    is_free: false, customer_approved: true,
    price_history: [{ rate: 1100, date: '2025-11-08' }],
  },
  {
    id: 2, item_type: 'part', description: 'Air Filter Replacement',
    item_description: 'OEM part, 15,000 km service interval',
    quantity: 1, customer_rate: 450, hub_rate: 360, commission_percent: 20,
    gst_percent: 18, gst_amount: 81, total_inc_gst: 531, total_payable: 425,
    hsn_sac: '8421', discount_amount: 50,
    batch_no: 'BT-9920', mfg_date: '2025-09-30', exp_date: '2030-09-30',
    is_free: false, customer_approved: true,
  },
  {
    id: 3, item_type: 'part', description: 'Brake Pad (Front)',
    quantity: 1, customer_rate: 700, hub_rate: 560, commission_percent: 20,
    gst_percent: 5, gst_amount: 35, total_inc_gst: 735, total_payable: 588,
    hsn_sac: '8708', discount_amount: 0, batch_no: 'BT-1180',
    is_free: false, customer_approved: true,
  },
  {
    id: 4, item_type: 'service', description: 'Wheel Alignment Check',
    quantity: 1, customer_rate: 0, hub_rate: 0, commission_percent: 0,
    gst_percent: 0, gst_amount: 0, total_inc_gst: 0, total_payable: 0,
    hsn_sac: '9987', discount_amount: 0, is_free: true, customer_approved: true,
  },
];

const SAMPLE_BASE = {
  id: 1042,
  customer_name: 'Ramesh Kumar', mobile: '9876543210',
  vehicle_number: 'GJ01AB1234', make_name: 'Maruti', model_name: 'Swift',
  body_type_name: 'Hatchback',
  hub_name: 'Spinoto Gota', hub_full_name: 'Gota Motors Pvt Ltd', hub_gst: '24AAAAA0000A1Z5',
  is_b2b: false, b2b_gst_number: null,
  status: 'approved',
  // Pickup job, so the preview shows the Address block under BILL TO exactly
  // as a real pickup document would. pickup_required is what gates it — see
  // documentAdapter.pickupAddress.
  pickup_required: true,
  pickup_address_line1: '12 Shilp Epitome, Flat 402',
  pickup_address_line2: 'Near Aristo Crest, Gota',
  pickup_city: 'Ahmedabad',
  pickup_pincode: '382481',
  po_number: 'PO-2026-0147', eway_bill_number: 'EWB-3417-8890',
  subtotal_ex_gst: 2350, total_gst: 332, grand_total: 2682,
  amount_paid: 1000, balance: 1682, party_balance: 4230,
  // Part of amount_paid, not on top of it — 400 advance + 600 payments = 1000.
  // Without a sample advance the theme picker shows the toggle having no effect
  // while somebody is deciding whether to turn it on.
  advance_applied: 400, advance_vouchers: 'ADV-2026-27-000042',
  rate_mode: 'tech_rate',
  notes: 'Vehicle collected after 6 PM.',
  created_at: new Date().toISOString(),
  // The theme preview must exercise the same field the real document prints,
  // otherwise a change to the printed date silently isn't previewed. Plain
  // 'YYYY-MM-DD', matching what the ::text cast in CI_SELECT/PI_SELECT returns.
  invoice_date: new Date().toLocaleDateString('en-CA'), // en-CA formats as YYYY-MM-DD
  payments: [{ paid_at: new Date().toISOString(), method: 'upi', amount: 1000, reference_no: 'UPI-8842' }],
  hub_payments: [],
};

// Values for user-defined fields/columns are injected per request, because
// their ids only exist in the caller's config.
function sampleRowFor(cfg) {
  // public_token matters: renderHtml only generates a QR when the document has
  // one, and without it the preview would silently lose the QR block and
  // misrepresent how much room the layout needs.
  const row = { public_token: 'sample-token', ...SAMPLE_BASE, items: SAMPLE_ITEMS.map(i => ({ ...i })) };
  const TEXT = ['Sample', 'Example', 'Demo'];

  row.custom_fields = {};
  (cfg.custom_fields || []).forEach((f, i) => {
    if (f.enabled !== false) row.custom_fields[f.id] = `${TEXT[i % TEXT.length]} value`;
  });
  (cfg.custom_columns || []).forEach((c, i) => {
    if (c.enabled === false) return;
    row.items.forEach((it, n) => {
      it.custom_values = { ...(it.custom_values || {}), [c.id]: n === 0 ? TEXT[i % TEXT.length] : '-' };
    });
  });
  return row;
}

async function previewInvoiceTheme(req, res) {
  try {
    const company = await loadCompany();

    // Accept overrides from body (POST) or query (GET thumbnails).
    const src = { ...(req.query || {}), ...(req.body || {}) };

    const docType = DOC_TYPES.includes(src.docType) ? src.docType : 'customer_invoice';

    // An invalid config must not 500 the preview — fall back to the saved one
    // so the picker keeps rendering while the user is mid-edit.
    const parsed = documentConfigSchema.safeParse(src.config);
    const rawConfig = (parsed.success && parsed.data !== undefined) ? parsed.data : company.document_config;

    // The preview always renders the admin view: it's only reachable from the
    // super-admin settings page, and showing the hub-limited view there would
    // misrepresent what the admin's own printed copy looks like.
    const cfg = resolveDocumentConfig(rawConfig, docType, 'admin');

    const themeKey = VALID_INVOICE_THEMES.includes(src.theme) ? src.theme : cfg.theme;
    const color = (typeof src.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.color))
      ? src.color
      : (company.invoice_accent_color || '#4f46e5');

    const previewCompany = { ...company, invoice_accent_color: color };
    const theme = getTheme(themeKey);

    // Rendered through the SAME renderHtml the PDF endpoints use, rather than
    // calling theme.render directly.
    //
    // This used to build the document and call the theme itself, which meant it
    // skipped renderHtml's asset inlining — so an uploaded signature or logo
    // stayed a relative "/uploads/..." URL. The preview iframe uses srcDoc, and
    // a srcDoc frame resolves relative URLs against the PARENT page, i.e. the
    // frontend origin — where /uploads isn't served. The image 404'd silently
    // and the signature never appeared, even though the PDF was fine.
    //
    // (The built-in /logo.svg kept working and hid the bug, because the
    // frontend does serve that one.)
    //
    // Sharing the one path means anything added to renderHtml — inlining, QR,
    // whatever comes next — reaches the preview automatically.
    const pageSize = pageSizeFor(theme, cfg);
    // renderHtml returns { html, doc }; the preview only needs the markup.
    const { html } = await renderHtml(docType, sampleRowFor(cfg), previewCompany, cfg, theme, {
      baseUrl: req.get('origin') || req.get('referer'),
    });

    // The pane sizes its iframe from this — it can't infer the sheet from the
    // HTML, and duplicating the theme-vs-global precedence rule in the frontend
    // would be a second place to keep in sync. Exposed for CORS in server.js.
    res.set('X-Page-Size', pageSize);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('[settings] previewInvoiceTheme error:', err);
    return res.status(500).send('<p style="font-family:sans-serif;color:#dc2626;padding:20px">Failed to render preview.</p>');
  }
}


// ─── POST / DELETE /api/settings/company/signature ────────────────────────────
// The authorised-signatory image (a signature or a rubber stamp), printed
// above the signatory line when a document's show_signature toggle is on.
//
// Deliberately a mirror of the logo endpoints rather than a shared generic
// "asset" endpoint: the two have different lifecycles and permissions could
// diverge later, and the duplication is small and obvious. Same dual-mode
// storage — ImageKit when configured, local disk otherwise.
async function uploadSignature(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const existing = await pool.query(
      `SELECT signature_url, signature_file_id FROM company_settings WHERE id = 1 LIMIT 1`
    );
    const old = existing.rows[0];
    if (old?.signature_url) {
      if (old.signature_file_id) await deleteFromImageKit(old.signature_file_id);
      else safeUnlink(assetDiskPath(old.signature_url, 'company-signature'));
    }

    let url = null, fileId = null;
    if (imagekitEnabled()) {
      const result = await uploadToImageKit(req.file.buffer, req.file.originalname, 'company-signature');
      url = result.url; fileId = result.fileId;
      if (req.file.path) safeUnlink(req.file.path);
    } else {
      url = `/uploads/company-signature/${req.file.filename}`;
    }

    const { rows } = await pool.query(
      `INSERT INTO company_settings (id, signature_url, signature_file_id, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         signature_url     = EXCLUDED.signature_url,
         signature_file_id = EXCLUDED.signature_file_id,
         updated_at        = NOW()
       RETURNING signature_url`,
      [url, fileId]
    );
    return res.status(201).json({ signature_url: rows[0].signature_url });
  } catch (err) {
    if (req.file?.path) safeUnlink(req.file.path);
    if (String(err.name).startsWith('CircuitBreaker')) {
      return res.status(err.status || 503).json({ error: 'Image storage is temporarily unavailable. Please try again shortly.' });
    }
    console.error('[settings] uploadSignature error:', err);
    return res.status(500).json({ error: 'Failed to upload signature.' });
  }
}

async function deleteSignature(req, res) {
  try {
    const existing = await pool.query(
      `SELECT signature_url, signature_file_id FROM company_settings WHERE id = 1 LIMIT 1`
    );
    const old = existing.rows[0];
    if (old?.signature_url) {
      if (old.signature_file_id) await deleteFromImageKit(old.signature_file_id);
      else safeUnlink(assetDiskPath(old.signature_url, 'company-signature'));
    }
    await pool.query(
      `UPDATE company_settings SET signature_url = NULL, signature_file_id = NULL, updated_at = NOW() WHERE id = 1`
    );
    return res.status(204).end();
  } catch (err) {
    console.error('[settings] deleteSignature error:', err);
    return res.status(500).json({ error: 'Failed to remove signature.' });
  }
}

// ─── GET /api/settings/gst-states ─────────────────────────────────────────────
// The GST state-code list, for the Place of Supply selector. Static data, but
// served from the backend so the code table has exactly one home
// (utils/gstStates.js) shared by the tax logic and the UI.
function listGstStates(req, res) {
  const { STATE_CODES } = require('../utils/gstStates');
  return res.json({
    items: Object.entries(STATE_CODES).map(([code, name]) => ({ code, name })),
  });
}

// ─── DELETE /api/settings/company/logo ────────────────────────────────────────
async function deleteLogo(req, res) {
  try {
    const existing = await pool.query(
      `SELECT logo_url, logo_file_id FROM company_settings WHERE id = 1 LIMIT 1`
    );
    const old = existing.rows[0];
    if (old?.logo_url) {
      if (old.logo_file_id) {
        await deleteFromImageKit(old.logo_file_id);
      } else {
        safeUnlink(logoDiskPath(old.logo_url));
      }
    }
    await pool.query(
      `UPDATE company_settings SET logo_url = NULL, logo_file_id = NULL, updated_at = NOW() WHERE id = 1`
    );
    return res.status(204).end();
  } catch (err) {
    console.error('[settings] deleteLogo error:', err);
    return res.status(500).json({ error: 'Failed to remove logo.' });
  }
}

module.exports = {
  upsertAdvanceRate, getCompany, upsertCompany, upsertDocumentConfig, listGstStates, uploadSignature, deleteSignature, getAlertSettings, upsertAlertSettings, uploadLogo, deleteLogo, previewInvoiceTheme, getBooksLock, upsertBooksLock };
