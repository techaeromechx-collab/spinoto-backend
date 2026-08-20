/**
 * Workshops controller — candidate hubs.
 *
 * A Workshop is a garage we are talking to but have not signed. It holds the
 * eleven basics, gets edited and discussed, and is either approved and
 * converted into a Hub or dropped.
 *
 * Nothing here ever writes to `hubs` except convertWorkshop(). That is the
 * point of the module: a prospect we pass on must leave no row in `hubs`, which
 * is referenced by appointments, invoices, payouts and the revenue report.
 *
 * Direct hub creation (POST /api/hubs) is untouched and still starts hubs at
 * verification_status 'pending'. Only conversion writes 'verified'.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { baseHubCode, resolveUniqueCode } = require('../utils/hubCode');
const { uploadToImageKit, deleteFromImageKit } = require('../utils/imagekit');
const fs   = require('fs');
const path = require('path');

function imagekitEnabled() {
  return !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT);
}

// Best-effort. A leftover temp file is untidy; throwing here would fail a
// request whose real work already succeeded.
function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
function diskPath(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith('/uploads/')) return null;
  return path.join(__dirname, '../../', fileUrl.replace(/^\//, ''));
}

// ─── Validators ──────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();
const VEHICLE_CLASSES = ['2W', '4W', 'both'];
const phone = (what) =>
  z.string().trim().regex(/^\d{10}$/, `${what} must be exactly 10 digits`);

// The twelve typed fields. Each maps 1:1 onto a hubs column so conversion is a
// copy, not a translation.
const baseWorkshopSchema = z.object({
  workshop_name:  z.string().trim().min(1).max(150),
  person_name:    z.string().trim().min(1).max(120),
  contact_number: phone('Contact number'),
  owner_name:     z.string().trim().max(120).optional().nullable(),
  owner_mobile:   phone('Owner mobile').optional().nullable(),
  // company_name is NOT here. The registered entity is rarely known while you
  // are still negotiating and always known by the time you sign, so it is
  // asked for in the Convert popup instead.
  state_id:       z.coerce.number().int().positive(),
  city_id:        z.coerce.number().int().positive(),
  area_id:        z.coerce.number().int().positive(),
  vehicle_class:  z.enum(VEHICLE_CLASSES),
  notes:          z.string().trim().max(2000).optional().nullable(),
  // Google Maps share link, captured at the workshop stage because whoever
  // visits the site is the person who has the pin. Copied to hubs.map_url on
  // conversion; it is what fills the Workshop Location line in the appointment
  // WhatsApp message.
  //
  // Not URL-validated beyond a length cap: Maps hands out several shapes
  // (maps.app.goo.gl, google.com/maps/place, plain lat/long) and rejecting an
  // unfamiliar one would block a real link for the sake of tidiness.
  map_url:        z.string().trim().max(500).optional().nullable(),
});

const createSchema = baseWorkshopSchema;
const updateSchema = baseWorkshopSchema.partial();

const rejectSchema = z.object({
  rejection_reason: z.string().trim().min(1, 'A reason is required').max(1000),
});

/**
 * What the Convert popup asks for — the Hub fields a Workshop does not carry.
 *
 * rm_user_id is the only one that is mandatory in the database. The rate fields
 * are nullable on `hubs`, but see the refine below: leaving them all empty is a
 * silent money bug, not a blank field.
 */
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
const gstRegex  = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const convertSchema = z.object({
  rm_user_id:         z.coerce.number().int().positive(),

  // Moved here from the workshop stage.
  company_name:       z.string().trim().max(200).optional().nullable(),

  commission_percent: z.coerce.number().min(0).max(100).optional().nullable(),
  tech_rate_service:  z.coerce.number().min(0).max(100).optional().nullable(),
  tech_rate_parts:    z.coerce.number().min(0).max(100).optional().nullable(),

  payout_terms:       z.enum(['weekly','fortnightly','net_30','net_60','net_90','net_180','net_365','custom'])
                        .optional().default('net_30'),
  payout_cycle_days:  z.coerce.number().int().min(1).max(3650).optional().nullable(),

  // ── The remaining Add HUB fields ──
  open_time:           z.string().trim().regex(timeRegex, 'Open time must be HH:MM').optional().nullable(),
  close_time:          z.string().trim().regex(timeRegex, 'Close time must be HH:MM').optional().nullable(),
  working_days:        z.string().trim().max(100).optional().nullable(),

  vehicle_capacity:    z.coerce.number().int().min(0).optional().nullable(),
  workshop_area_sqft:  z.coerce.number().min(0).optional().nullable(),
  no_of_mechanics:     z.coerce.number().int().min(0).optional().nullable(),

  has_gst:             z.boolean().optional().default(false),
  gst_number:          z.string().trim().optional().nullable(),

  bank_account_number: z.string().trim().max(30).optional().nullable(),
  bank_ifsc:           z.string().trim().max(11).optional().nullable(),
  bank_name:           z.string().trim().max(150).optional().nullable(),
  account_holder_name: z.string().trim().max(150).optional().nullable(),

  // Defaults true: approving the workshop was the review, so the hub is meant
  // to be usable the moment it exists. Still a field, so it can be turned off
  // for a hub that is signed but not opening until next month.
  is_active:           z.boolean().optional().default(true),
}).refine(
  (d) => {
    const commission = d.commission_percent != null && Number(d.commission_percent) > 0;
    const techRates  = d.tech_rate_service != null || d.tech_rate_parts != null;
    return commission || techRates;
  },
  {
    // Not cosmetic validation. purchase_invoices.controller.js reads
    // commission_percent, tech_rate_service and tech_rate_parts off the hub:
    // commission mode wins when commission > 0, otherwise it falls back to
    // tech-rate mode. With all three null it does not error — it picks
    // tech-rate mode with null rates and pays the hub ZERO on every purchase
    // invoice, silently, forever. Refusing here is the only place that costs
    // nothing to fix.
    message: 'Set either a commission % or tech rates — without one the hub is paid ₹0 on every purchase invoice',
    path: ['commission_percent'],
  }
).refine(
  (d) => d.payout_terms !== 'custom' || (d.payout_cycle_days != null && d.payout_cycle_days > 0),
  { message: 'Custom payout terms need a cycle length in days', path: ['payout_cycle_days'] }
).refine(
  (d) => !(d.has_gst && d.gst_number && !gstRegex.test(String(d.gst_number).trim().toUpperCase())),
  { message: 'Invalid GST number format (e.g. 27AAPFU0939F1ZV)', path: ['gst_number'] }
);

// ─── Error handler ───────────────────────────────────────────────────────────

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      // 23505 covers two different unique indexes here, and the messages are
      // not interchangeable: one means "you already logged this workshop", the
      // other means "a hub of that name exists, conversion cannot proceed".
      if (err.code === '23505') {
        if (String(err.constraint || '').includes('hub_name')) {
          return res.status(409).json({ error: 'A HUB with that name already exists — rename the workshop before converting' });
        }
        if (String(err.constraint || '').includes('converted_hub_id')) {
          return res.status(409).json({ error: 'This workshop has already been converted' });
        }
        return res.status(409).json({ error: 'A workshop with that name already exists' });
      }
      if (err.code === '23503') {
        return res.status(409).json({ error: 'Invalid reference — check state, city, area or RM user' });
      }
      // ImageKit circuit breaker tripped, or one call timed out / was rejected
      // over the concurrency limit. A fast, clear "try again" beats a 500, and
      // the half-uploaded temp file goes with it.
      if (err.name === 'CircuitBreakerOpenError' || err.name === 'CircuitBreakerBusyError' || err.name === 'CircuitBreakerTimeoutError') {
        if (req.file?.path) safeUnlink(req.file.path);
        return res.status(err.status || 503).json({ error: 'Photo storage is temporarily unavailable. Please try again shortly.' });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
}

// ─── Shared SELECT ───────────────────────────────────────────────────────────

const WORKSHOP_SELECT = `
  SELECT
    w.id,
    w.workshop_name,
    w.person_name,
    w.contact_number,
    w.owner_name,
    w.owner_mobile,
    w.state_id,  s.name  AS state_name,
    w.city_id,   c.name  AS city_name,
    w.area_id,   a.name  AS area_name,
    w.vehicle_class,
    w.notes,
    w.map_url,
    w.status,
    w.rejection_reason,
    w.approved_by,  ab.name AS approved_by_name,  w.approved_at,
    w.converted_hub_id,
    h.hub_name   AS converted_hub_name,
    h.hub_code   AS converted_hub_code,
    w.converted_by, cb.name AS converted_by_name, w.converted_at,
    w.created_by,   crb.name AS created_by_name,
    w.created_at,
    w.updated_at,
    (SELECT COUNT(*) FROM workshop_photos wp WHERE wp.workshop_id = w.id) AS photo_count
  FROM workshops w
  LEFT JOIN states s   ON s.id  = w.state_id
  LEFT JOIN cities c   ON c.id  = w.city_id
  LEFT JOIN areas  a   ON a.id  = w.area_id
  LEFT JOIN hubs   h   ON h.id  = w.converted_hub_id
  LEFT JOIN users  ab  ON ab.id = w.approved_by
  LEFT JOIN users  cb  ON cb.id = w.converted_by
  LEFT JOIN users  crb ON crb.id = w.created_by
`;

// ─── List ────────────────────────────────────────────────────────────────────

/** GET /api/workshops */
function listWorkshops(req, res, next) {
  handle(req, res, next, async () => {
    const { status, search, state_id, city_id, area_id, vehicle_class } = req.query;
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

    // Built WITHOUT status. The tab counts must answer "how many are approved
    // GIVEN the other filters", so they run over this set — otherwise clicking
    // the Approved tab would drop every other tab to zero and you could never
    // click back.
    //
    // Two arrays rather than one filtered later: the placeholders are numbered
    // by position, so removing a clause from a shared list silently shifts
    // every $n after it onto the wrong value.
    const baseWhere  = ['w.deleted_at IS NULL'];
    const baseParams = [];
    const add = (sql, val) => { baseParams.push(val); baseWhere.push(sql(`$${baseParams.length}`)); };

    if (state_id)      add((p) => `w.state_id = ${p}`,      state_id);
    if (city_id)       add((p) => `w.city_id = ${p}`,       city_id);
    if (area_id)       add((p) => `w.area_id = ${p}`,       area_id);
    if (vehicle_class) add((p) => `w.vehicle_class = ${p}`, vehicle_class);

    if (search && String(search).trim().length >= 2) {
      add((p) => `(w.workshop_name ILIKE ${p} OR w.person_name ILIKE ${p}
                   OR w.contact_number ILIKE ${p})`,
          `%${String(search).trim()}%`);
    }

    const counts = await pool.query(
      `SELECT
         COUNT(*)                                       AS all,
         COUNT(*) FILTER (WHERE w.status = 'draft')     AS draft,
         COUNT(*) FILTER (WHERE w.status = 'approved')  AS approved,
         COUNT(*) FILTER (WHERE w.status = 'rejected')  AS rejected,
         COUNT(*) FILTER (WHERE w.status = 'dropped')   AS dropped,
         COUNT(*) FILTER (WHERE w.status = 'converted') AS converted
       FROM workshops w WHERE ${baseWhere.join(' AND ')}`,
      baseParams
    );

    // The list itself layers the status filter on top.
    const where  = [...baseWhere];
    const params = [...baseParams];
    if (status && status !== 'all') {
      params.push(status);
      where.push(`w.status = $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const totalRes = await pool.query(`SELECT COUNT(*) FROM workshops w ${whereSql}`, params);
    const total    = Number(totalRes.rows[0].count);

    const rows = await pool.query(
      `${WORKSHOP_SELECT} ${whereSql} ORDER BY w.created_at DESC, w.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({ items: rows.rows, total, page, pageSize, counts: counts.rows[0] });
  });
}

/** GET /api/workshops/:id */
function getWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`${WORKSHOP_SELECT} WHERE w.id = $1 AND w.deleted_at IS NULL`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Workshop not found' });

    const photos = await pool.query(
      `SELECT id, file_name, file_url, caption, uploaded_at FROM workshop_photos
        WHERE workshop_id = $1 ORDER BY uploaded_at ASC, id ASC`, [id]
    );
    res.json({ item: { ...r.rows[0], photos: photos.rows } });
  });
}

// ─── Create / update / delete ────────────────────────────────────────────────

/** POST /api/workshops */
function createWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const d = createSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO workshops
         (workshop_name, person_name, contact_number, owner_name, owner_mobile,
          state_id, city_id, area_id, vehicle_class, notes, map_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [d.workshop_name, d.person_name, d.contact_number, d.owner_name || null,
       d.owner_mobile || null, d.state_id, d.city_id,
       d.area_id, d.vehicle_class, d.notes || null, d.map_url || null,
       req.user?.id || null]
    );
    res.status(201).json({ id: r.rows[0].id });
  });
}

/** PATCH /api/workshops/:id */
function updateWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = updateSchema.parse(req.body);

    const cur = await pool.query(
      'SELECT status FROM workshops WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Workshop not found' });

    // A converted workshop is the audit record of what was agreed. Editing it
    // would let the record drift away from the hub it produced.
    if (cur.rows[0].status === 'converted') {
      return res.status(409).json({ error: 'This workshop has been converted and can no longer be edited' });
    }

    const fields = Object.keys(baseWorkshopSchema.shape).filter((k) => d[k] !== undefined);
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const sets   = fields.map((f, i) => `${f} = $${i + 1}`);
    const params = fields.map((f) => (d[f] === '' ? null : d[f]));

    // Editing a rejected workshop answers the rejection, so it goes back into
    // the queue rather than sitting rejected with changed content — the same
    // rule hubs use when a rejected hub is edited.
    if (cur.rows[0].status === 'rejected') {
      sets.push(`status = 'draft'`, `rejection_reason = NULL`);
    }

    params.push(id);
    await pool.query(
      `UPDATE workshops SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL`,
      params
    );
    res.json({ ok: true });
  });
}

/** DELETE /api/workshops/:id — soft */
function deleteWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const cur = await pool.query(
      'SELECT status FROM workshops WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Workshop not found' });
    if (cur.rows[0].status === 'converted') {
      return res.status(409).json({ error: 'A converted workshop cannot be deleted — it is the record of how its hub was created' });
    }
    await pool.query('UPDATE workshops SET deleted_at = NOW() WHERE id = $1', [id]);
    res.json({ ok: true });
  });
}

// ─── Approve / reject / drop ─────────────────────────────────────────────────

/** PATCH /api/workshops/:id/approve */
function approveWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `UPDATE workshops
          SET status = 'approved', rejection_reason = NULL,
              approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL AND status <> 'converted'
        RETURNING id`,
      [id, req.user?.id || null]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Workshop not found, or already converted' });
    res.json({ ok: true });
  });
}

/** PATCH /api/workshops/:id/reject */
function rejectWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const { rejection_reason } = rejectSchema.parse(req.body);
    const r = await pool.query(
      `UPDATE workshops
          SET status = 'rejected', rejection_reason = $3,
              approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL AND status <> 'converted'
        RETURNING id`,
      [id, req.user?.id || null, rejection_reason]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Workshop not found, or already converted' });
    res.json({ ok: true });
  });
}

/** PATCH /api/workshops/:id/drop — went cold, nobody judged it unsuitable */
function dropWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `UPDATE workshops SET status = 'dropped'
        WHERE id = $1 AND deleted_at IS NULL AND status <> 'converted'
        RETURNING id`, [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Workshop not found, or already converted' });
    res.json({ ok: true });
  });
}

// ─── Convert ─────────────────────────────────────────────────────────────────

/**
 * POST /api/workshops/:id/convert
 *
 * Creates the Hub and marks the Workshop converted, in one transaction.
 *
 * Documents are NOT handled here. hub_documents.hub_id is NOT NULL, so they
 * cannot be written before the hub exists; the client uploads them to
 * POST /api/hubs/:id/documents once this returns. That split is deliberate — a
 * hub missing a document is a visible, fixable state, whereas writing files to
 * disk inside a transaction means either orphaned files on rollback or rows
 * pointing at files that were never written.
 */
function convertWorkshop(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = convertSchema.parse(req.body);

    const rm = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [d.rm_user_id]
    );
    if (rm.rowCount === 0) return res.status(400).json({ error: 'Selected RM is not an active user' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE, so two concurrent converts cannot both read 'approved' and
      // both go on to insert a hub. The UNIQUE on converted_hub_id is the
      // backstop; this is what stops the second one wasting a hub row first.
      const wRes = await client.query(
        `SELECT * FROM workshops WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]
      );
      if (wRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Workshop not found' });
      }
      const w = wRes.rows[0];

      if (w.converted_hub_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Already converted to hub #${w.converted_hub_id}` });
      }
      if (w.status !== 'approved') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only an approved workshop can be converted — this one is "${w.status}"` });
      }

      // Same code rule as a directly-created hub. Read inside the transaction
      // so a hub added mid-convert cannot hand us a code that is taken by the
      // time we insert.
      // has_gst off means the number is meaningless. Storing one anyway leaves
      // a GSTIN on a hub that prints as non-GST — the rule hubs.controller
      // already applies on create.
      const hasGst    = d.has_gst ?? false;
      const gstNumber = hasGst ? (d.gst_number || null) : null;

      const codesRes = await client.query('SELECT hub_code FROM hubs WHERE hub_code IS NOT NULL');
      const hubCode  = resolveUniqueCode(
        baseHubCode(w.workshop_name),
        new Set(codesRes.rows.map((r) => r.hub_code))
      );

      // verification_status 'verified' and is_active true: approving the
      // Workshop WAS the review, and hubs.controller blocks activation while a
      // hub is 'pending'. Landing pending would mean Convert produced a hub
      // that silently does nothing until someone finds it and verifies it.
      //
      // This is the ONLY place that writes verification_status at insert.
      // POST /api/hubs is unchanged and still starts every hub at 'pending'.
      const hubRes = await client.query(
        `INSERT INTO hubs
           (hub_name, hub_code, person_name, contact_number, owner_name, owner_mobile,
            company_name, state_id, city_id, area_id, rm_user_id, vehicle_class,
            notes, commission_percent, tech_rate_service, tech_rate_parts,
            payout_terms, payout_cycle_days,
            open_time, close_time, working_days,
            vehicle_capacity, workshop_area_sqft, no_of_mechanics,
            has_gst, gst_number,
            bank_account_number, bank_ifsc, bank_name, account_holder_name,
            is_active, verification_status, verified_by, verified_at, created_by,
            map_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
                 $31, 'verified', $32, NOW(), $32,
                 $33)
         RETURNING id, hub_code`,
        [
          w.workshop_name, hubCode, w.person_name, w.contact_number,
          w.owner_name, w.owner_mobile,
          // From the POPUP now, not the workshop row.
          d.company_name ?? null,
          w.state_id, w.city_id, w.area_id, d.rm_user_id, w.vehicle_class,
          w.notes,
          d.commission_percent ?? null,
          d.tech_rate_service  ?? null,
          d.tech_rate_parts    ?? null,
          d.payout_terms       ?? 'net_30',
          d.payout_cycle_days  ?? null,
          d.open_time    || null,
          d.close_time   || null,
          d.working_days || null,
          d.vehicle_capacity   ?? null,
          d.workshop_area_sqft ?? null,
          d.no_of_mechanics    ?? null,
          hasGst, gstNumber,
          d.bank_account_number || null,
          d.bank_ifsc           || null,
          d.bank_name           || null,
          d.account_holder_name || null,
          d.is_active !== false,
          req.user?.id || null,
          // $33 — from the workshop row, not the popup. Whoever visited the
          // site had the map pin; asking for it again at conversion would be
          // asking the wrong person. Migration 109 warns that omitting this
          // from the copy leaves every converted hub with no location, and the
          // appointment WhatsApp message silently skipped.
          w.map_url ?? null,
        ]
      );
      const hub = hubRes.rows[0];

      await client.query(
        `UPDATE workshops
            SET status = 'converted', converted_hub_id = $2,
                converted_by = $3, converted_at = NOW()
          WHERE id = $1`,
        [id, hub.id, req.user?.id || null]
      );

      await client.query('COMMIT');
      res.status(201).json({ hub_id: hub.id, hub_code: hub.hub_code });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─── Photos ──────────────────────────────────────────────────────────────────

const MAX_PHOTOS = 10;

/** POST /api/workshops/:id/photos */
function uploadPhoto(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const cur = await pool.query(
      'SELECT status FROM workshops WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Workshop not found' });

    const countRes = await pool.query(
      'SELECT COUNT(*) FROM workshop_photos WHERE workshop_id = $1', [id]
    );
    if (Number(countRes.rows[0].count) >= MAX_PHOTOS) {
      return res.status(409).json({ error: `A workshop can hold at most ${MAX_PHOTOS} photos` });
    }

    // ImageKit when configured, local disk otherwise — the same arrangement
    // hub documents use. The first version read a request property that no
    // middleware ever sets, so the ImageKit path always answered 503.
    let fileUrl = null;
    let imagekitFileId = null;

    if (imagekitEnabled()) {
      const result = await uploadToImageKit(req.file.buffer, req.file.originalname, 'workshop-photos');
      fileUrl        = result.url;
      imagekitFileId = result.fileId;
      if (req.file.path) safeUnlink(req.file.path);
    } else {
      fileUrl = `/uploads/workshop-photos/${req.file.filename}`;
    }

    const r = await pool.query(
      `INSERT INTO workshop_photos (workshop_id, file_name, file_url, caption, uploaded_by, imagekit_file_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, file_name, file_url, caption, uploaded_at`,
      [id, req.file.originalname, fileUrl,
       (req.body?.caption || '').trim().slice(0, 200) || null, req.user?.id || null,
       imagekitFileId]
    );
    res.status(201).json({ photo: r.rows[0] });
  });
}

/** DELETE /api/workshops/:id/photos/:photoId */
function deletePhoto(req, res, next) {
  handle(req, res, next, async () => {
    const id      = idParam.parse(req.params.id);
    const photoId = idParam.parse(req.params.photoId);
    const r = await pool.query(
      'DELETE FROM workshop_photos WHERE id = $1 AND workshop_id = $2 RETURNING file_url, imagekit_file_id',
      [photoId, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Photo not found' });

    // Delete the FILE as well as the row. Dropping only the row leaves the
    // image live on the CDN — reachable by anyone holding the URL, and billed
    // for, on behalf of a prospect that may never become anything.
    //
    // Swallowed on failure: the row is already gone, and a CDN hiccup must not
    // report a delete as failed when it succeeded.
    const { file_url, imagekit_file_id } = r.rows[0];
    if (imagekit_file_id) { try { await deleteFromImageKit(imagekit_file_id); } catch { /* orphaned file, not a failure */ } }
    else safeUnlink(diskPath(file_url));

    res.json({ ok: true });
  });
}

module.exports = {
  listWorkshops,
  getWorkshop,
  createWorkshop,
  updateWorkshop,
  deleteWorkshop,
  approveWorkshop,
  rejectWorkshop,
  dropWorkshop,
  convertWorkshop,
  uploadPhoto,
  deletePhoto,
  // exported for tests
  convertSchema,
  createSchema,
  MAX_PHOTOS,
};
