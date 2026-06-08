/**
 * Hubs (Aggregator) controller
 *
 * vehicle_class values: '2W' | '4W' | 'both' (standardised across all tables)
 */

const { z } = require('zod');
const { pool } = require('../config/db');

// ─── Validators ────────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();

const VEHICLE_CLASSES = ['2W', '4W', 'both'];

// TIME format validator: HH:MM (24-hour)
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

// GST number format: 15-character alphanumeric (Indian GST)
const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Base object — kept as ZodObject so .partial() works for PATCH
const baseHubSchema = z.object({
  hub_name:           z.string().trim().min(1).max(150),
  person_name:        z.string().trim().min(1).max(120),
  contact_number:     z.string().trim().regex(/^\d{10}$/, 'Contact number must be exactly 10 digits'),
  owner_name:         z.string().trim().max(120).optional().nullable(),
  owner_mobile:       z.string().trim().regex(/^\d{10}$/, 'Owner mobile must be exactly 10 digits').optional().nullable(),
  state_id:           z.coerce.number().int().positive(),
  city_id:            z.coerce.number().int().positive(),
  area_id:            z.coerce.number().int().positive(),
  rm_user_id:         z.coerce.number().int().positive(),
  vehicle_class:      z.enum(['2W', '4W', 'both']),
  is_active:          z.boolean().optional().default(true),
  notes:              z.string().trim().max(2000).optional().nullable(),
  open_time:          z.string().trim().regex(timeRegex, 'Open time must be HH:MM').optional().nullable(),
  close_time:         z.string().trim().regex(timeRegex, 'Close time must be HH:MM').optional().nullable(),
  working_days:       z.string().trim().max(100).optional().nullable(),
  // ── New fields ──
  has_gst:            z.boolean().optional().default(false),
  gst_number:         z.string().trim().optional().nullable(),
  tech_rate_service:  z.coerce.number().min(0).max(100).optional().nullable(),
  tech_rate_parts:    z.coerce.number().min(0).max(100).optional().nullable(),
  commission_percent:   z.coerce.number().min(0).max(100).optional().nullable(),
  payout_terms:         z.enum(['weekly','fortnightly','net_30','net_60','net_90','net_180','net_365','custom']).optional().default('net_30'),
  payout_cycle_days:    z.coerce.number().int().min(1).max(3650).optional().nullable(),
  // ── Migration 030: new operational & bank fields ──
  bank_account_number:  z.string().trim().max(30).optional().nullable(),
  bank_ifsc:            z.string().trim().max(11).optional().nullable(),
  bank_name:            z.string().trim().max(150).optional().nullable(),
  account_holder_name:  z.string().trim().max(150).optional().nullable(),
  vehicle_capacity:     z.coerce.number().int().min(0).optional().nullable(),
  workshop_area_sqft:   z.coerce.number().min(0).optional().nullable(),
  no_of_mechanics:      z.coerce.number().int().min(0).optional().nullable(),
});

// createSchema adds the cross-field GST refine on top
const createSchema = baseHubSchema.refine(
  d => !(d.has_gst && d.gst_number && !gstRegex.test(d.gst_number.trim().toUpperCase())),
  { message: 'Invalid GST number format (e.g. 27AAPFU0939F1ZV)', path: ['gst_number'] }
);

// updateSchema stays a plain ZodObject so .partial() is available
const updateSchema = baseHubSchema.partial();

// Service/category mapping schema for bulk save
const serviceMappingSchema = z.object({
  category_ids: z.array(z.coerce.number().int().positive()),
  services: z.array(z.object({
    service_id:  z.coerce.number().int().positive(),
    category_id: z.coerce.number().int().positive(),
  })),
});

// ─── Error handler ──────────────────────────────────────────────────────────────

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A HUB with that name already exists' });
      }
      if (err.code === '23503') {
        return res.status(409).json({ error: 'Invalid reference — check state, city, area or RM user' });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
}

// ─── Helper: translate HUB vehicle_class for service queries ──────────────────
// All tables now use '2W'/'4W'/'both' — pass through directly; 'both' = no filter
function hubVcToSvcVc(hubVc) {
  if (hubVc === '2W' || hubVc === '4W') return hubVc;
  return null; // 'both' → no filter, fetch all
}

// ─── Shared SELECT fragment (full detail) ──────────────────────────────────────

const HUB_SELECT = `
  SELECT
    h.id,
    h.hub_name,
    h.person_name,
    h.contact_number,
    h.owner_name,
    h.owner_mobile,
    h.vehicle_class,
    h.state_id,
    s.name  AS state_name,
    h.city_id,
    c.name  AS city_name,
    h.area_id,
    a.name  AS area_name,
    h.rm_user_id,
    u.name    AS rm_name,
    u.mobile  AS rm_mobile,
    h.is_active,
    h.notes,
    h.open_time,
    h.close_time,
    h.working_days,
    h.has_gst,
    h.gst_number,
    h.tech_rate_service,
    h.tech_rate_parts,
    h.commission_percent,
    h.payout_terms,
    h.payout_cycle_days,
    h.bank_account_number,
    h.bank_ifsc,
    h.bank_name,
    h.account_holder_name,
    h.vehicle_capacity,
    h.workshop_area_sqft,
    h.no_of_mechanics,
    h.verification_status,
    h.verified_by,
    vb.name  AS verified_by_name,
    h.verified_at,
    h.rejection_reason,
    h.created_by,
    cb.name AS created_by_name,
    h.created_at,
    h.updated_at
  FROM hubs h
  JOIN states s ON s.id = h.state_id
  JOIN cities c ON c.id = h.city_id
  JOIN areas  a ON a.id = h.area_id
  JOIN users  u ON u.id = h.rm_user_id
  LEFT JOIN users cb ON cb.id = h.created_by
  LEFT JOIN users vb ON vb.id = h.verified_by
`;

// ─── List SELECT (includes mapping counts + name previews) ─────────────────────

const HUB_SELECT_LIST = `
  SELECT
    h.id,
    h.hub_name,
    h.person_name,
    h.contact_number,
    h.owner_name,
    h.owner_mobile,
    h.vehicle_class,
    h.state_id,
    s.name  AS state_name,
    h.city_id,
    c.name  AS city_name,
    h.area_id,
    a.name  AS area_name,
    h.rm_user_id,
    u.name    AS rm_name,
    u.mobile  AS rm_mobile,
    h.is_active,
    h.open_time,
    h.close_time,
    h.working_days,
    h.has_gst,
    h.gst_number,
    h.tech_rate_service,
    h.tech_rate_parts,
    h.commission_percent,
    h.payout_terms,
    h.payout_cycle_days,
    h.bank_account_number,
    h.bank_ifsc,
    h.bank_name,
    h.account_holder_name,
    h.vehicle_capacity,
    h.workshop_area_sqft,
    h.no_of_mechanics,
    h.verification_status,
    h.rejection_reason,
    h.created_at,

    (SELECT COUNT(*)::int
       FROM hub_category_mappings hcm
       WHERE hcm.hub_id = h.id) AS total_categories,

    (SELECT COUNT(*)::int
       FROM hub_service_mappings hsm
       WHERE hsm.hub_id = h.id) AS total_services,

    (SELECT STRING_AGG(sc.name, ', ' ORDER BY sc.name)
       FROM hub_category_mappings hcm
       JOIN service_categories sc ON sc.id = hcm.category_id
       WHERE hcm.hub_id = h.id) AS category_names_preview,

    (SELECT STRING_AGG(sv.name, ', ' ORDER BY sv.name)
       FROM hub_service_mappings hsm
       JOIN services sv ON sv.id = hsm.service_id
       WHERE hsm.hub_id = h.id) AS service_names_preview

  FROM hubs h
  JOIN states s ON s.id = h.state_id
  JOIN cities c ON c.id = h.city_id
  JOIN areas  a ON a.id = h.area_id
  JOIN users  u ON u.id = h.rm_user_id
`;

// ─── CRUD Controllers ──────────────────────────────────────────────────────────

/**
 * GET /api/hubs
 * Query params: search, state_id, city_id, area_id, rm_user_id, vehicle_class, is_active, page, limit
 */
function listHubs(req, res, next) {
  handle(req, res, next, async () => {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = ['h.deleted_at IS NULL'];
    const params = [];

    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      conditions.push(`(h.hub_name ILIKE $${params.length} OR h.person_name ILIKE $${params.length} OR h.contact_number ILIKE $${params.length})`);
    }
    if (req.query.state_id) {
      params.push(idParam.parse(req.query.state_id));
      conditions.push(`h.state_id = $${params.length}`);
    }
    if (req.query.city_id) {
      params.push(idParam.parse(req.query.city_id));
      conditions.push(`h.city_id = $${params.length}`);
    }
    if (req.query.area_id) {
      params.push(idParam.parse(req.query.area_id));
      conditions.push(`h.area_id = $${params.length}`);
    }
    if (req.query.rm_user_id) {
      params.push(idParam.parse(req.query.rm_user_id));
      conditions.push(`h.rm_user_id = $${params.length}`);
    }
    if (req.query.vehicle_class && VEHICLE_CLASSES.includes(req.query.vehicle_class)) {
      params.push(req.query.vehicle_class);
      conditions.push(`h.vehicle_class = $${params.length}`);
    }
    if (req.query.is_active !== undefined && req.query.is_active !== '') {
      params.push(req.query.is_active === 'true');
      conditions.push(`h.is_active = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await pool.query(`SELECT COUNT(*) FROM hubs h ${where}`, params);
    const total    = parseInt(countRes.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await pool.query(
      `${HUB_SELECT_LIST} ${where} ORDER BY h.created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ items: dataRes.rows, total, page, limit });
  });
}

/**
 * GET /api/hubs/:id
 */
function getHub(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${HUB_SELECT} WHERE h.id = $1 AND h.deleted_at IS NULL`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });
    res.json({ item: r.rows[0] });
  });
}

/**
 * POST /api/hubs
 */
function createHub(req, res, next) {
  handle(req, res, next, async () => {
    const data      = createSchema.parse(req.body);
    const createdBy = req.user?.id || null;

    const rmCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_active = TRUE',
      [data.rm_user_id]
    );
    if (rmCheck.rowCount === 0) {
      return res.status(400).json({ error: 'Selected RM is not an active user' });
    }

    // If has_gst is false, always clear gst_number
    const hasGst    = data.has_gst ?? false;
    const gstNumber = hasGst ? (data.gst_number || null) : null;

    // New hubs always start pending + inactive — must be verified before activation
    const r = await pool.query(
      `INSERT INTO hubs
         (hub_name, person_name, contact_number, owner_name, owner_mobile,
          state_id, city_id, area_id, rm_user_id, vehicle_class,
          is_active, notes, open_time, close_time, working_days,
          has_gst, gst_number, tech_rate_service, tech_rate_parts,
          commission_percent, payout_terms, payout_cycle_days,
          bank_account_number, bank_ifsc, bank_name, account_holder_name,
          vehicle_capacity, workshop_area_sqft, no_of_mechanics,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       RETURNING id`,
      [
        data.hub_name, data.person_name, data.contact_number,
        data.owner_name   || null, data.owner_mobile  || null,
        data.state_id, data.city_id, data.area_id, data.rm_user_id,
        data.vehicle_class, false, data.notes || null, // is_active always false on creation — must verify first
        data.open_time    || null, data.close_time    || null,
        data.working_days || null,
        hasGst, gstNumber,
        data.tech_rate_service  ?? null,
        data.tech_rate_parts    ?? null,
        data.commission_percent ?? null,
        data.payout_terms       ?? 'net_30',
        data.payout_cycle_days  ?? null,
        data.bank_account_number || null,
        data.bank_ifsc           || null,
        data.bank_name           || null,
        data.account_holder_name || null,
        data.vehicle_capacity    ?? null,
        data.workshop_area_sqft  ?? null,
        data.no_of_mechanics     ?? null,
        createdBy,
      ]
    );

    const full = await pool.query(`${HUB_SELECT} WHERE h.id = $1`, [r.rows[0].id]);
    res.status(201).json({ item: full.rows[0] });
  });
}

/**
 * PATCH /api/hubs/:id
 */
function updateHub(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    const exists = await pool.query(
      'SELECT id, verification_status FROM hubs WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (exists.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });

    // If the hub was rejected, editing it resets it to pending for re-review
    const wasRejected = exists.rows[0].verification_status === 'rejected';

    // Prevent activating a hub that hasn't been verified
    if (data.is_active === true && exists.rows[0].verification_status !== 'verified') {
      return res.status(400).json({
        error: `Cannot activate hub — verification status is "${exists.rows[0].verification_status}". Please verify the hub first.`,
      });
    }

    if (data.rm_user_id) {
      const rmCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [data.rm_user_id]);
      if (rmCheck.rowCount === 0) return res.status(400).json({ error: 'Selected RM is not an active user' });
    }

    // If has_gst is being explicitly set to false, clear gst_number
    const updatingGst = 'has_gst' in data;
    const hasGstVal   = data.has_gst ?? null;
    const gstNumVal   = (updatingGst && data.has_gst === false)
      ? null
      : (data.gst_number ?? null);

    await pool.query(
      `UPDATE hubs SET
         hub_name          = COALESCE($1,  hub_name),
         person_name       = COALESCE($2,  person_name),
         contact_number    = COALESCE($3,  contact_number),
         owner_name        = COALESCE($4,  owner_name),
         owner_mobile      = COALESCE($5,  owner_mobile),
         state_id          = COALESCE($6,  state_id),
         city_id           = COALESCE($7,  city_id),
         area_id           = COALESCE($8,  area_id),
         rm_user_id        = COALESCE($9,  rm_user_id),
         vehicle_class     = COALESCE($10, vehicle_class),
         is_active         = COALESCE($11, is_active),
         notes             = COALESCE($12, notes),
         open_time         = COALESCE($13, open_time),
         close_time        = COALESCE($14, close_time),
         working_days      = COALESCE($15, working_days),
         has_gst           = COALESCE($16, has_gst),
         gst_number        = CASE
                               WHEN $16 = FALSE THEN NULL
                               ELSE COALESCE($17, gst_number)
                             END,
         tech_rate_service    = COALESCE($18, tech_rate_service),
         tech_rate_parts      = COALESCE($19, tech_rate_parts),
         commission_percent   = COALESCE($20, commission_percent),
         payout_terms         = COALESCE($21, payout_terms),
         payout_cycle_days    = COALESCE($22, payout_cycle_days),
         bank_account_number  = COALESCE($23, bank_account_number),
         bank_ifsc            = COALESCE($24, bank_ifsc),
         bank_name            = COALESCE($25, bank_name),
         account_holder_name  = COALESCE($26, account_holder_name),
         vehicle_capacity     = COALESCE($27, vehicle_capacity),
         workshop_area_sqft   = COALESCE($28, workshop_area_sqft),
         no_of_mechanics      = COALESCE($29, no_of_mechanics),
         -- If hub was rejected, reset to pending so it goes back for re-review
         verification_status  = CASE WHEN $31 THEN 'pending' ELSE verification_status END,
         rejection_reason     = CASE WHEN $31 THEN NULL ELSE rejection_reason END,
         updated_at           = NOW()
       WHERE id = $30 AND deleted_at IS NULL`,
      [
        data.hub_name       ?? null,
        data.person_name    ?? null,
        data.contact_number ?? null,
        data.owner_name     ?? null,
        data.owner_mobile   ?? null,
        data.state_id       ?? null,
        data.city_id        ?? null,
        data.area_id        ?? null,
        data.rm_user_id     ?? null,
        data.vehicle_class  ?? null,
        data.is_active      ?? null,
        data.notes          ?? null,
        data.open_time      ?? null,
        data.close_time     ?? null,
        data.working_days   ?? null,
        hasGstVal,
        gstNumVal,
        data.tech_rate_service   ?? null,
        data.tech_rate_parts     ?? null,
        data.commission_percent  ?? null,
        data.payout_terms        ?? null,
        data.payout_cycle_days   ?? null,
        data.bank_account_number ?? null,
        data.bank_ifsc           ?? null,
        data.bank_name           ?? null,
        data.account_holder_name ?? null,
        data.vehicle_capacity    ?? null,
        data.workshop_area_sqft  ?? null,
        data.no_of_mechanics     ?? null,
        id,
        wasRejected,  // $31 — if true, resets verification_status to 'pending'
      ]
    );

    const full = await pool.query(`${HUB_SELECT} WHERE h.id = $1`, [id]);
    res.json({ item: full.rows[0] });
  });
}

/**
 * PATCH /api/hubs/:id/toggle
 * Cannot activate a hub that has not been verified yet.
 */
function toggleHub(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const current = await pool.query(
      'SELECT is_active, verification_status FROM hubs WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });

    const { is_active, verification_status } = current.rows[0];

    // Block activation if hub is not verified
    if (!is_active && verification_status !== 'verified') {
      return res.status(422).json({
        error: `Cannot activate hub — verification status is "${verification_status}". Please verify the hub first.`,
      });
    }

    const r = await pool.query(
      `UPDATE hubs SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING is_active`,
      [id]
    );
    res.json({ is_active: r.rows[0].is_active });
  });
}

/**
 * PATCH /api/hubs/:id/verify
 * Sets verification_status = 'verified'. Hub stays inactive until explicitly toggled.
 */
function verifyHub(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const current = await pool.query(
      'SELECT id, verification_status FROM hubs WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });
    if (current.rows[0].verification_status === 'verified') {
      return res.status(409).json({ error: 'Hub is already verified' });
    }

    const r = await pool.query(
      `UPDATE hubs
         SET verification_status = 'verified',
             rejection_reason    = NULL,
             verified_by         = $1,
             verified_at         = NOW(),
             updated_at          = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING verification_status, verified_at`,
      [req.user.id, id]
    );

    res.json({
      message:             'Hub verified successfully. It can now be activated.',
      verification_status: r.rows[0].verification_status,
      verified_at:         r.rows[0].verified_at,
    });
  });
}

/**
 * PATCH /api/hubs/:id/reject
 * Sets verification_status = 'rejected' with a reason.
 * Body: { reason: string }
 */
function rejectHub(req, res, next) {
  handle(req, res, next, async () => {
    const id     = idParam.parse(req.params.id);
    const reason = (req.body?.reason || '').trim();

    if (!reason) {
      return res.status(400).json({ error: 'A rejection reason is required' });
    }

    const current = await pool.query(
      'SELECT id, verification_status FROM hubs WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });

    const r = await pool.query(
      `UPDATE hubs
         SET verification_status = 'rejected',
             rejection_reason    = $1,
             is_active           = FALSE,
             verified_by         = $2,
             verified_at         = NOW(),
             updated_at          = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING verification_status, rejection_reason`,
      [reason, req.user.id, id]
    );

    res.json({
      message:             'Hub rejected.',
      verification_status: r.rows[0].verification_status,
      rejection_reason:    r.rows[0].rejection_reason,
    });
  });
}

/**
 * DELETE /api/hubs/:id  (soft delete)
 */
function deleteHub(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `UPDATE hubs SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });
    res.status(204).end();
  });
}

// ─── Service Mapping Controllers ───────────────────────────────────────────────

/**
 * GET /api/hubs/:id/services
 *
 * Returns all categories filtered by the hub's vehicle_class.
 * For each category: whether it's mapped (category_mapped).
 * For each service: whether it's mapped (service_mapped).
 *
 * Response:
 *   {
 *     vehicle_class,
 *     hub_name,
 *     categories: [{
 *       id, name, vehicle_class, category_mapped,
 *       services: [{ service_id, name, service_mapped }]
 *     }]
 *   }
 */
function getHubServices(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.id);

    const hubRes = await pool.query(
      'SELECT id, hub_name, vehicle_class FROM hubs WHERE id = $1 AND deleted_at IS NULL',
      [hubId]
    );
    if (hubRes.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });

    const hub   = hubRes.rows[0];
    const svcVc = hubVcToSvcVc(hub.vehicle_class); // null means no filter

    // Fetch categories filtered by vehicle_class
    const catRes = await pool.query(
      `SELECT id, name, vehicle_class
       FROM service_categories
       WHERE is_active = TRUE
         AND ($1::text IS NULL OR vehicle_class = $1 OR vehicle_class = 'both')
       ORDER BY name ASC`,
      [svcVc]
    );

    if (catRes.rowCount === 0) {
      return res.json({ vehicle_class: hub.vehicle_class, hub_name: hub.hub_name, categories: [] });
    }

    const catIds = catRes.rows.map(c => c.id);

    // Fetch all active services for those categories (include vehicle_class so the
    // appointment modal can filter services by the selected vehicle type)
    const svcRes = await pool.query(
      `SELECT s.id AS service_id, s.name, s.category_id, s.vehicle_class
       FROM services s
       WHERE s.category_id = ANY($1)
         AND s.is_active = TRUE
         AND ($2::text IS NULL OR s.vehicle_class = $2 OR s.vehicle_class = 'both')
       ORDER BY s.name ASC`,
      [catIds, svcVc]
    );

    // Fetch existing category mappings for this hub
    const catMapRes = await pool.query(
      'SELECT category_id FROM hub_category_mappings WHERE hub_id = $1',
      [hubId]
    );
    const mappedCatIds = new Set(catMapRes.rows.map(r => r.category_id));

    // Fetch existing service mappings for this hub
    const svcMapRes = await pool.query(
      'SELECT service_id FROM hub_service_mappings WHERE hub_id = $1',
      [hubId]
    );
    const mappedSvcIds = new Set(svcMapRes.rows.map(r => r.service_id));

    // Group services under their categories
    const svcByCategory = new Map();
    for (const svc of svcRes.rows) {
      if (!svcByCategory.has(svc.category_id)) svcByCategory.set(svc.category_id, []);
      svcByCategory.get(svc.category_id).push({
        service_id:     svc.service_id,
        name:           svc.name,
        vehicle_class:  svc.vehicle_class,
        service_mapped: mappedSvcIds.has(svc.service_id),
      });
    }

    // Build final response — only include categories that have at least one service
    const categories = catRes.rows
      .map(cat => ({
        id:              cat.id,
        name:            cat.name,
        vehicle_class:   cat.vehicle_class,
        category_mapped: mappedCatIds.has(cat.id),
        services:        svcByCategory.get(cat.id) || [],
      }))
      .filter(cat => cat.services.length > 0);

    res.json({ vehicle_class: hub.vehicle_class, hub_name: hub.hub_name, categories });
  });
}

/**
 * PUT /api/hubs/:id/services
 *
 * Replaces ALL category and service mappings for the hub atomically.
 * Body: {
 *   category_ids: [number, ...],
 *   services:     [{ service_id, category_id }, ...]
 * }
 */
function saveHubServices(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.id);
    const { category_ids, services } = serviceMappingSchema.parse(req.body);

    const hubRes = await pool.query('SELECT id FROM hubs WHERE id = $1 AND deleted_at IS NULL', [hubId]);
    if (hubRes.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Replace category mappings ────────────────────────────────────────────
      await client.query('DELETE FROM hub_category_mappings WHERE hub_id = $1', [hubId]);
      for (const catId of category_ids) {
        await client.query(
          'INSERT INTO hub_category_mappings (hub_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [hubId, catId]
        );
      }

      // ── Replace service mappings ─────────────────────────────────────────────
      await client.query('DELETE FROM hub_service_mappings WHERE hub_id = $1', [hubId]);
      for (const svc of services) {
        await client.query(
          `INSERT INTO hub_service_mappings (hub_id, service_id, category_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [hubId, svc.service_id, svc.category_id]
        );
      }

      await client.query('COMMIT');

      res.json({
        success:          true,
        total_categories: category_ids.length,
        total_services:   services.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─── Hub Login ────────────────────────────────────────────────────────────────

const bcrypt = require('bcryptjs');

const hubLoginSchema = z.object({
  name:     z.string().trim().min(1).max(120),
  email:    z.string().trim().email(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

// POST /api/hubs/:id/login  — super admin creates a login for a hub
function createHubLogin(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const hubId = idParam.parse(req.params.id);
    const data  = hubLoginSchema.parse(req.body);

    // Make sure hub exists
    const hubCheck = await pool.query('SELECT id, hub_name FROM hubs WHERE id = $1 AND deleted_at IS NULL', [hubId]);
    if (hubCheck.rowCount === 0) return res.status(404).json({ error: 'Hub not found' });

    // Make sure this hub doesn't already have a login user
    const existing = await pool.query('SELECT id, email FROM users WHERE hub_id = $1', [hubId]);
    if (existing.rowCount > 0) {
      return res.status(409).json({
        error: `This hub already has a login (${existing.rows[0].email}). Delete it first.`,
      });
    }

    const hash = await bcrypt.hash(data.password, 10);

    const ins = await pool.query(
      `INSERT INTO users (name, email, password_hash, is_active, is_super_admin, hub_id)
       VALUES ($1, $2, $3, TRUE, FALSE, $4)
       RETURNING id, name, email, hub_id`,
      [data.name, data.email.toLowerCase(), hash, hubId]
    );

    res.status(201).json({
      message: `Hub login created for ${hubCheck.rows[0].hub_name}`,
      user: ins.rows[0],
    });
  });
}

// DELETE /api/hubs/:id/login  — super admin removes the hub login user
function deleteHubLogin(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const hubId = idParam.parse(req.params.id);

    const r = await pool.query('DELETE FROM users WHERE hub_id = $1 RETURNING id, email', [hubId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No login user found for this hub' });

    res.json({ message: `Hub login removed (${r.rows[0].email})` });
  });
}

// GET /api/hubs/logins  — list ALL hub login users (super admin / MANAGE_HUBS only)
function listHubLogins(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.created_at,
              h.id AS hub_id, h.hub_name,
              COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       JOIN hubs h ON h.id = u.hub_id
       LEFT JOIN user_permissions up ON up.user_id = u.id
       WHERE u.hub_id IS NOT NULL
       GROUP BY u.id, h.id
       ORDER BY h.hub_name ASC`
    );
    res.json({ items: r.rows });
  });
}

// GET /api/hubs/:id/login  — check if a hub login exists
function getHubLogin(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const hubId = idParam.parse(req.params.id);
    const r = await pool.query(
      'SELECT id, name, email, is_active, created_at FROM users WHERE hub_id = $1',
      [hubId]
    );
    res.json({ login: r.rows[0] || null });
  });
}

module.exports = {
  listHubs,
  getHub,
  createHub,
  updateHub,
  toggleHub,
  deleteHub,
  verifyHub,
  rejectHub,
  getHubServices,
  saveHubServices,
  createHubLogin,
  deleteHubLogin,
  getHubLogin,
  listHubLogins,
};
