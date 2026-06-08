'use strict';

/**
 * Settings controller
 *
 * GET  /api/settings/company   — fetch company details (any authenticated user)
 * PUT  /api/settings/company   — update company details (super admin only)
 */

const { z }    = require('zod');
const { pool } = require('../config/db');

// ─── Validator ────────────────────────────────────────────────────────────────
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
});

// ─── GET /api/settings/company ────────────────────────────────────────────────
async function getCompany(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT company_name, address_line1, address_line2, city, state,
              pincode, phone, email, gstin, updated_at
       FROM company_settings WHERE id = 1 LIMIT 1`
    );
    if (rows.length === 0) {
      // Return empty object if table row not seeded yet
      return res.json({
        company_name: '', address_line1: '', address_line2: '',
        city: '', state: '', pincode: '', phone: '', email: '', gstin: '',
      });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('[settings] getCompany error:', err);
    return res.status(500).json({ error: 'Failed to fetch company settings.' });
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
    const { rows } = await pool.query(
      `INSERT INTO company_settings
         (id, company_name, address_line1, address_line2, city, state,
          pincode, phone, email, gstin, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
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
         updated_at    = NOW()
       RETURNING company_name, address_line1, address_line2, city, state,
                 pincode, phone, email, gstin, updated_at`,
      [d.company_name, d.address_line1, d.address_line2, d.city, d.state,
       d.pincode, d.phone, d.email, d.gstin]
    );
    return res.json({ item: rows[0], message: 'Company settings saved.' });
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
  if (!req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Only super admins can update alert settings.' });
  }

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

module.exports = { getCompany, upsertCompany, getAlertSettings, upsertAlertSettings };
