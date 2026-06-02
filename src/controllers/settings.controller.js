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

module.exports = { getCompany, upsertCompany };
