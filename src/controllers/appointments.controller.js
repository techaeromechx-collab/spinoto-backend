'use strict';

/**
 * Appointments controller
 *
 * Endpoints:
 *   POST   /api/appointments            — create appointment (from lead conversion or direct)
 *   GET    /api/appointments            — list with filters
 *   GET    /api/appointments/stats      — counts per status (for dashboard)
 *   GET    /api/appointments/:id        — full detail with services
 *   PATCH  /api/appointments/:id        — update status / reschedule
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { generateAppointmentCode } = require('../utils/appointmentCode');

// ─── Hub schedule validator ───────────────────────────────────────────────────
// Returns { status, code, error } if the scheduled slot violates hub hours/days,
// or null if everything is fine (or hub has no hours configured).
async function checkHubSchedule(hubId, scheduledDate, scheduledTime) {
  if (!hubId || !scheduledDate) return null;

  const hubRow = await pool.query(
    `SELECT hub_name, open_time, close_time, working_days FROM hubs WHERE id = $1`,
    [hubId]
  );
  const hub = hubRow.rows[0];
  if (!hub) return null;

  const hubName = hub.hub_name;

  // ── Working day check ────────────────────────────────────────────────────
  if (hub.working_days) {
    const days = hub.working_days.split(',').map(d => d.trim().toUpperCase());
    const DAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const FULL_DAY = { SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday' };

    // Parse as local date to avoid UTC-offset day shift
    const [y, m, d] = scheduledDate.split('-').map(Number);
    const dayAbbr = DAY_ABBR[new Date(y, m - 1, d).getDay()];

    if (!days.includes(dayAbbr)) {
      const workingList = days.map(d => FULL_DAY[d] || d).join(', ');
      return {
        status: 422,
        code: 'HUB_CLOSED_DAY',
        error: `${hubName} is closed on ${FULL_DAY[dayAbbr] || dayAbbr}s. Working days are: ${workingList}.`,
      };
    }
  }

  // ── Operating hours check ────────────────────────────────────────────────
  if (hub.open_time && hub.close_time && scheduledTime) {
    const toMins = t => {
      const [h, m] = t.slice(0, 5).split(':').map(Number);
      return h * 60 + m;
    };
    const fmt12 = t => {
      const [h, m] = t.slice(0, 5).split(':').map(Number);
      const ampm = h >= 12 ? 'PM' : 'AM';
      return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
    };

    const apptMins = toMins(scheduledTime);
    const openMins = toMins(hub.open_time);
    const closeMins = toMins(hub.close_time);

    if (apptMins < openMins || apptMins >= closeMins) {
      return {
        status: 422,
        code: 'HUB_OUTSIDE_HOURS',
        error: `${hubName} operates ${fmt12(hub.open_time)} – ${fmt12(hub.close_time)}. The selected time (${fmt12(scheduledTime)}) is outside operating hours.`,
      };
    }
  }

  return null; // all good
}

// ─── Validators ───────────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  lead_id: z.coerce.number().int().positive().optional().nullable(),
  assigned_to: z.coerce.number().int().positive().optional().nullable(),
  customer_name: z.string().trim().max(160).optional().nullable(),
  // Fix #21: validate mobile format (digits, spaces, dashes, +; 7-15 chars after stripping)
  mobile: z.string().trim().min(1).max(20).regex(
    /^\+?[\d\s\-]{7,20}$/,
    'Mobile must be 7–20 digits and may include +, spaces, or dashes'
  ),
  whatsapp: z.string().trim().max(20).optional().nullable(),
  vehicle_number: z.string().trim().max(30).optional().nullable(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  make_id: z.coerce.number().int().positive().optional().nullable(),
  model_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id: z.coerce.number().int().positive().optional().nullable(),
  segment_ids: z.array(z.number().int()).optional().default([]),
  cc_category_id: z.coerce.number().int().positive().optional().nullable(),
  hub_id: z.coerce.number().int().positive().optional().nullable(),
  scheduled_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  scheduled_time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM').optional().nullable(),
  status_id: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
  pickup_required: z.boolean().optional().default(false),
  pickup_address_line1: z.string().trim().max(200).optional().nullable(),
  pickup_address_line2: z.string().trim().max(200).optional().nullable(),
  pickup_city: z.string().trim().max(100).optional().nullable(),
  pickup_pincode: z.string().trim().max(10).optional().nullable(),
  pickup_maps_link: z.string().trim().max(500).optional().nullable(),
  pickup_scheduled_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pickup date must be YYYY-MM-DD').optional().nullable(),
  pickup_scheduled_time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pickup time must be HH:MM').optional().nullable(),
  drop_required: z.boolean().optional().default(false),
  drop_address_line1: z.string().trim().max(200).optional().nullable(),
  drop_address_line2: z.string().trim().max(200).optional().nullable(),
  drop_city: z.string().trim().max(100).optional().nullable(),
  drop_pincode: z.string().trim().max(10).optional().nullable(),
  drop_maps_link: z.string().trim().max(500).optional().nullable(),
  services: z.array(z.object({
    service_id: z.coerce.number().int().positive(),
    category_id: z.coerce.number().int().positive().optional().nullable(),
    price: z.coerce.number().nonnegative(),
  })).optional().default([]),
}).refine(d => !d.pickup_required || (d.pickup_address_line1 && d.pickup_address_line1.trim().length > 0), {
  message: 'Pickup address (line 1) is required when pickup is enabled',
  path: ['pickup_address_line1'],
}).refine(d => !d.drop_required || (d.drop_address_line1 && d.drop_address_line1.trim().length > 0), {
  message: 'Drop address (line 1) is required when drop is enabled',
  path: ['drop_address_line1'],
});

const updateSchema = z.object({
  status_id: z.coerce.number().int().positive().optional().nullable(),
  scheduled_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scheduled_time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
  hub_id: z.coerce.number().int().positive().optional().nullable(),
  vehicle_number: z.string().trim().max(30).optional().nullable(),
  cancellation_reason: z.string().trim().max(500).optional().nullable(),
  pickup_required: z.boolean().optional(),
  pickup_address_line1: z.string().trim().max(200).optional().nullable(),
  pickup_address_line2: z.string().trim().max(200).optional().nullable(),
  pickup_city: z.string().trim().max(100).optional().nullable(),
  pickup_pincode: z.string().trim().max(10).optional().nullable(),
  pickup_maps_link: z.string().trim().max(500).optional().nullable(),
  pickup_timestamp: z.string().datetime().optional().nullable(),
  pickup_scheduled_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  pickup_scheduled_time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  drop_required: z.boolean().optional(),
  drop_address_line1: z.string().trim().max(200).optional().nullable(),
  drop_address_line2: z.string().trim().max(200).optional().nullable(),
  drop_city: z.string().trim().max(100).optional().nullable(),
  drop_pincode: z.string().trim().max(10).optional().nullable(),
  drop_maps_link: z.string().trim().max(500).optional().nullable(),
  reschedule_reason: z.string().trim().max(200).optional().nullable(),
  reschedule_notes: z.string().trim().max(1000).optional().nullable(),
  // These are set by the server on reschedule — not accepted from client
  // original_scheduled_date, original_scheduled_time, rescheduled_by, rescheduled_at
  // Customer & vehicle fields for full edit
  customer_name: z.string().trim().max(200).optional().nullable(),
  mobile: z.string().trim().max(20).optional().nullable(),
  whatsapp: z.string().trim().max(20).optional().nullable(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  make_id: z.coerce.number().int().positive().optional().nullable(),
  model_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id: z.coerce.number().int().positive().optional().nullable(),
  cc_category_id: z.coerce.number().int().positive().optional().nullable(),
  segment_ids: z.array(z.coerce.number().int().positive()).optional(),
  // Fix #9: allow updating service line items
  services: z.array(z.object({
    service_id: z.coerce.number().int().positive(),
    category_id: z.coerce.number().int().positive().optional().nullable(),
    price: z.coerce.number().nonnegative(),
  })).optional(),
});

// ─── Error handler ────────────────────────────────────────────────────────────

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
      }
      next(err);
    });
}

// ─── Full SELECT fragment ─────────────────────────────────────────────────────

const APPT_SELECT = `
  SELECT
    a.id,
    a.appointment_code,
    a.lead_id,
    a.customer_name,
    a.mobile,
    a.whatsapp,
    a.vehicle_number,
    a.segment_ids,
    TO_CHAR(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
    a.scheduled_time,
    a.total_price,
    a.notes,
    a.cancellation_reason,
    a.pickup_required,
    a.pickup_address_line1,
    a.pickup_address_line2,
    a.pickup_city,
    a.pickup_pincode,
    a.pickup_maps_link,
    a.pickup_timestamp,
    TO_CHAR(a.pickup_scheduled_date, 'YYYY-MM-DD') AS pickup_scheduled_date,
    a.pickup_scheduled_time,
    a.drop_required,
    a.drop_address_line1,
    a.drop_address_line2,
    a.drop_city,
    a.drop_pincode,
    a.drop_maps_link,
    a.reschedule_reason,
    a.reschedule_notes,
    a.original_scheduled_date,
    a.original_scheduled_time,
    a.rescheduled_at,
    ru.id   AS rescheduled_by_id,
    ru.name AS rescheduled_by_name,
    a.created_at,
    a.updated_at,

    -- Vehicle info
    vt.id   AS vehicle_type_id,   vt.name  AS vehicle_type_name,
    mk.id   AS make_id,           mk.name  AS make_name,
    md.id   AS model_id,          md.name  AS model_name,
    bt.id   AS body_type_id,      bt.name  AS body_type_name,
    cc.id   AS cc_category_id,    cc.name  AS cc_category_name,
    (SELECT COALESCE(array_agg(sg.name ORDER BY sg.name), '{}')
       FROM segments sg WHERE sg.id = ANY(a.segment_ids))  AS segment_names,

    -- Hub
    h.id    AS hub_id,            h.hub_name,

    -- Status
    ast.id  AS status_id,
    ast.name     AS status_name,
    ast.color    AS status_color,
    ast.bg_color AS status_bg,

    -- Assigned agent
    au.id   AS assigned_to_id,
    au.name AS assigned_to_name,

    -- Creator
    u.id    AS created_by_id,
    u.name  AS created_by_name,

    -- Linked estimate (used to lock fields in edit mode + status prerequisite checks)
    (SELECT e.id     FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_id,
    (SELECT e.status FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_status,
    EXISTS (SELECT 1 FROM estimates e WHERE e.appointment_id = a.id)                            AS has_estimate,

    -- Linked customer invoice (for status prerequisite checks)
    (SELECT ci.id     FROM customer_invoices ci
       JOIN estimates e ON e.id = ci.estimate_id
       WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_id,
    (SELECT ci.status FROM customer_invoices ci
       JOIN estimates e ON e.id = ci.estimate_id
       WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_status,

    -- Financial totals
    (SELECT e.grand_total FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_total,
    (SELECT ci.grand_total FROM customer_invoices ci WHERE ci.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_total

  FROM appointments a
  LEFT JOIN vehicle_types     vt  ON vt.id  = a.vehicle_type_id
  LEFT JOIN vehicle_makes     mk  ON mk.id  = a.make_id
  LEFT JOIN vehicle_models    md  ON md.id  = a.model_id
  LEFT JOIN body_types        bt  ON bt.id  = a.body_type_id
  LEFT JOIN cc_categories     cc  ON cc.id  = a.cc_category_id
  LEFT JOIN hubs              h   ON h.id   = a.hub_id
  LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
  LEFT JOIN users             u   ON u.id   = a.created_by
  LEFT JOIN users             au  ON au.id  = a.assigned_to
  LEFT JOIN users             ru  ON ru.id  = a.rescheduled_by
`;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/appointments — Create
// ─────────────────────────────────────────────────────────────────────────────
function createAppointment(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);

    // Resolve default status if not provided
    let statusId = data.status_id;
    if (!statusId) {
      const defRow = await pool.query(
        `SELECT id FROM appointment_statuses WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`
      );
      statusId = defRow.rows[0]?.id || null;
    }

    const totalPrice = data.services.reduce((sum, s) => sum + Number(s.price), 0);

    // If converting from a lead and no assigned_to sent, inherit from the lead
    let assignedTo = data.assigned_to || null;
    if (data.lead_id && !assignedTo) {
      const leadRow = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [data.lead_id]);
      assignedTo = leadRow.rows[0]?.assigned_to || null;
    }

    // Fix #22: guard against duplicate lead conversion
    if (data.lead_id) {
      const dupCheck = await pool.query(
        `SELECT id FROM appointments WHERE lead_id = $1 LIMIT 1`,
        [data.lead_id]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({
          error: `Lead #${data.lead_id} has already been converted to appointment #${dupCheck.rows[0].id}.`,
          existing_appointment_id: dupCheck.rows[0].id,
        });
      }
    }

    // Hub operating hours / working day validation
    if (data.hub_id) {
      const hubErr = await checkHubSchedule(data.hub_id, data.scheduled_date, data.scheduled_time);
      if (hubErr) return res.status(hubErr.status).json({ error: hubErr.error, code: hubErr.code });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO appointments (
          lead_id, customer_name, mobile, whatsapp,
          vehicle_number, vehicle_type_id, make_id, model_id,
          body_type_id, segment_ids, cc_category_id,
          hub_id, scheduled_date, scheduled_time,
          status_id, total_price, notes,
          pickup_required, pickup_address_line1, pickup_address_line2, pickup_city, pickup_pincode, pickup_maps_link,
          pickup_scheduled_date, pickup_scheduled_time,
          drop_required, drop_address_line1, drop_address_line2, drop_city, drop_pincode, drop_maps_link,
          assigned_to, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22,$23,
          $24,$25,
          $26,$27,$28,$29,$30,$31,
          $32,$33
        ) RETURNING id`,
        [
          data.lead_id || null,           // $1
          data.customer_name || null,           // $2
          data.mobile,                           // $3
          data.whatsapp || null,           // $4
          data.vehicle_number || null,           // $5
          data.vehicle_type_id || null,          // $6
          data.make_id || null,          // $7
          data.model_id || null,          // $8
          data.body_type_id || null,          // $9
          data.segment_ids,                      // $10
          data.cc_category_id || null,          // $11
          data.hub_id || null,          // $12
          data.scheduled_date,                   // $13
          data.scheduled_time || null,          // $14
          statusId,                              // $15
          totalPrice,                            // $16
          data.notes || null,          // $17
          data.pickup_required ?? false,         // $18
          data.pickup_address_line1 || null,     // $19
          data.pickup_address_line2 || null,     // $20
          data.pickup_city || null,     // $21
          data.pickup_pincode || null,     // $22
          data.pickup_maps_link || null,     // $23
          data.pickup_scheduled_date || null,    // $24
          data.pickup_scheduled_time || null,    // $25
          data.drop_required ?? false,         // $26
          data.drop_address_line1 || null,     // $27
          data.drop_address_line2 || null,     // $28
          data.drop_city || null,     // $29
          data.drop_pincode || null,     // $30
          data.drop_maps_link || null,     // $31
          assignedTo,                            // $32
          req.user.id,                           // $33
        ]
      );

      const apptId = ins.rows[0].id;

      // Insert service line items
      for (const svc of data.services) {
        await client.query(
          `INSERT INTO appointment_services (appointment_id, service_id, category_id, price)
           VALUES ($1, $2, $3, $4)`,
          [apptId, svc.service_id, svc.category_id || null, svc.price]
        );
      }

      // Human-readable appointment code — only possible once a hub is known.
      // Generated once here (or later in updateAppointment, if no hub is set
      // yet at creation time) and frozen forever after that — see
      // utils/appointmentCode.js.
      if (data.hub_id) {
        const hubRow = await client.query(`SELECT hub_code FROM hubs WHERE id = $1`, [data.hub_id]);
        const hubCode = hubRow.rows[0]?.hub_code;
        if (hubCode) {
          const code = await generateAppointmentCode(client, { hubId: data.hub_id, hubCode });
          await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [code, apptId]);
        }
      }

      // Auto-update lead status + log activity when appointment is created from a lead
      if (data.lead_id) {
        // Log the appointment creation on the lead timeline
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, new_value, note, created_by)
           VALUES ($1, 'appointment_created', $2, $3, $4)`,
          [data.lead_id, `Appointment #${apptId}`, `Scheduled on ${data.scheduled_date}`, req.user.id]
        );

        // Update leads.status (plain text column) to the "converts_to_appointment" status name
        const convertStatus = await client.query(
          `SELECT name FROM lead_statuses WHERE converts_to_appointment = TRUE AND is_active = TRUE ORDER BY sort_order ASC NULLS LAST LIMIT 1`
        );
        if (convertStatus.rows[0]) {
          const newStatusName = convertStatus.rows[0].name;

          // Capture current status text before changing
          const prevLead = await client.query(`SELECT status FROM leads WHERE id = $1`, [data.lead_id]);
          const oldStatusName = prevLead.rows[0]?.status || null;

          // Only update if status is actually changing
          if (oldStatusName !== newStatusName) {
            await client.query(
              `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2`,
              [newStatusName, data.lead_id]
            );

            // Log the status change to the lead's activity timeline
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
               VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
              [data.lead_id, oldStatusName, newStatusName, `Auto-updated on appointment booking`, req.user.id]
            );
          }
        }
      }

      await client.query('COMMIT');

      // Return full record
      const row = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [apptId]);
      const appt = row.rows[0];
      appt.services = await _getServices(apptId);

      logActivity({ userId: req.user?.id, userName: req.user?.name, action: 'CREATE', entity: 'appointment', entityId: apptId, description: `Created appointment for ${data.customer_name || data.mobile} on ${data.scheduled_date}` });
      return res.status(201).json({ item: appt });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/appointments — List
// ─────────────────────────────────────────────────────────────────────────────
function listAppointments(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const statusId = req.query.status_id || '';
    const hubId = req.query.hub_id || '';
    const hubIds = req.query.hub_ids || '';
    const vehicleType = req.query.vehicle_type_id || '';
    const dateFrom = req.query.date_from || '';
    const dateTo = req.query.date_to || '';
    const createdById = req.query.created_by_id || '';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    // ── User scoping ──────────────────────────────────────────────────────────
    // Super admins and users with VIEW_APPOINTMENT see all.
    // Others (e.g. CREATE_APPOINTMENT only) see appointments linked to their leads.
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_APPOINTMENT');
    if (!isAll) {
      params.push([req.user.id]);
      conditions.push(
        `EXISTS (
          SELECT 1 FROM leads l
          WHERE l.id = a.lead_id
          AND (l.created_by = ANY($${params.length}) OR l.assigned_to = ANY($${params.length}))
        )`
      );
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const n = params.length;
      conditions.push(
        `(LOWER(COALESCE(a.customer_name,'')) LIKE $${n}
          OR a.mobile LIKE $${n}
          OR LOWER(COALESCE(a.vehicle_number,'')) LIKE $${n})`
      );
    }
    if (hubIds) {
      const ids = hubIds.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`a.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (hubId) {
      params.push(Number(hubId));
      conditions.push(`a.hub_id = $${params.length}`);
    }
    if (vehicleType) {
      params.push(Number(vehicleType));
      conditions.push(`a.vehicle_type_id = $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`a.scheduled_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`a.scheduled_date <= $${params.length}`);
    }
    if (createdById) {
      params.push(Number(createdById));
      conditions.push(`a.created_by = $${params.length}`);
    }

    // Snapshot BEFORE the status filter — per-status tab counts must ignore
    // the active status filter so the numbers stay stable when a tab is picked.
    const countConditions = [...conditions];
    const countParams = [...params];

    if (statusId) {
      params.push(Number(statusId));
      conditions.push(`a.status_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countWhere = countConditions.length ? `WHERE ${countConditions.join(' AND ')}` : '';

    const [dataRes, countRes, statusCountsRes] = await Promise.all([
      pool.query(
        `${APPT_SELECT} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM appointments a ${where}`, params),
      pool.query(
        `SELECT a.status_id, COUNT(*)::int AS count
         FROM appointments a ${countWhere}
         GROUP BY a.status_id`,
        countParams
      ),
    ]);

    return res.json({
      items: dataRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
      status_counts: statusCountsRes.rows, // [{ status_id, count }]
      page,
      limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/appointments/stats — Status counts
// ─────────────────────────────────────────────────────────────────────────────
function getStats(req, res, next) {
  handle(req, res, next, async () => {
    const rows = await pool.query(`
      SELECT
        ast.id, ast.name, ast.color, ast.bg_color,
        COUNT(a.id)::int AS count
      FROM appointment_statuses ast
      LEFT JOIN appointments a ON a.status_id = ast.id
      WHERE ast.is_active = TRUE
      GROUP BY ast.id
      ORDER BY ast.sort_order NULLS LAST, ast.id
    `);
    return res.json({ items: rows.rows });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/appointments/:id — Detail
// ─────────────────────────────────────────────────────────────────────────────
function getAppointment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const row = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    const appt = row.rows[0];
    appt.services = await _getServices(id);
    return res.json({ item: appt });
  });
}

async function checkIsTerminal(id) {
  const currentAppt = await pool.query(
    `SELECT ast.slug FROM appointments a
     LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
     WHERE a.id = $1`,
    [id]
  );
  return currentAppt.rows[0] && ['closed', 'cancelled', 'no-show'].includes(currentAppt.rows[0].slug);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/appointments/:id — Update
// ─────────────────────────────────────────────────────────────────────────────
function updateAppointment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    if (await checkIsTerminal(id)) {
      return res.status(400).json({ error: 'Cannot modify a closed, cancelled, or no-show appointment.' });
    }

    if (data.status_id !== undefined) {
      const targetStatusRow = await pool.query(
        'SELECT sort_order, name FROM appointment_statuses WHERE id = $1',
        [data.status_id]
      );
      const targetSort = targetStatusRow.rows[0]?.sort_order;

      if (targetSort !== undefined) {
        const apptDetailsRow = await pool.query(`
          SELECT 
            (SELECT e.status FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_status,
            (SELECT ci.id FROM customer_invoices ci JOIN estimates e ON e.id = ci.estimate_id WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_id,
            (SELECT ci.status FROM customer_invoices ci JOIN estimates e ON e.id = ci.estimate_id WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_status
          FROM appointments a
          WHERE a.id = $1
        `, [id]);

        const apptInfo = apptDetailsRow.rows[0];
        if (apptInfo) {
          const estExists = !!apptInfo.estimate_status;
          const estApproved = estExists && ['approved', 'customer_approved', 'work_in_progress', 'work_completed'].includes(apptInfo.estimate_status);
          const invExists = !!apptInfo.invoice_id;
          const invApproved = invExists && ['approved', 'partially_paid', 'paid'].includes(apptInfo.invoice_status);

          // Rule 1: If Estimate is approved, block moving to status before 'estimate-approved' (sort_order < 16)
          if (estApproved && targetSort < 16) {
            return res.status(400).json({ error: `Cannot move status back to '${targetStatusRow.rows[0].name}' because the estimate is already approved.` });
          }

          // Rule 2: If Invoice is generated, block moving to status before 'invoice-generated' (sort_order < 21)
          if (invExists && targetSort < 21) {
            return res.status(400).json({ error: `Cannot move status back to '${targetStatusRow.rows[0].name}' because the invoice has already been generated.` });
          }

          // Rule 3: If Invoice is approved, block moving to status before 'invoice-approved' (sort_order < 22)
          if (invApproved && targetSort < 22) {
            return res.status(400).json({ error: `Cannot move status back to '${targetStatusRow.rows[0].name}' because the invoice is already approved.` });
          }
        }
      }
    }

    const fields = [];
    const params = [];

    if (data.status_id !== undefined) { params.push(data.status_id); fields.push(`status_id           = $${params.length}`); }
    if (data.scheduled_date !== undefined) { params.push(data.scheduled_date); fields.push(`scheduled_date      = $${params.length}`); }
    if (data.scheduled_time !== undefined) { params.push(data.scheduled_time); fields.push(`scheduled_time      = $${params.length}`); }
    if (data.notes !== undefined) { params.push(data.notes); fields.push(`notes               = $${params.length}`); }
    if (data.hub_id !== undefined) { params.push(data.hub_id); fields.push(`hub_id              = $${params.length}`); }
    if (data.vehicle_number !== undefined) { params.push(data.vehicle_number); fields.push(`vehicle_number      = $${params.length}`); }
    if (data.cancellation_reason !== undefined) { params.push(data.cancellation_reason); fields.push(`cancellation_reason = $${params.length}`); }
    if (data.pickup_required !== undefined) { params.push(data.pickup_required); fields.push(`pickup_required      = $${params.length}`); }
    if (data.pickup_address_line1 !== undefined) { params.push(data.pickup_address_line1); fields.push(`pickup_address_line1 = $${params.length}`); }
    if (data.pickup_address_line2 !== undefined) { params.push(data.pickup_address_line2); fields.push(`pickup_address_line2 = $${params.length}`); }
    if (data.pickup_city !== undefined) { params.push(data.pickup_city); fields.push(`pickup_city          = $${params.length}`); }
    if (data.pickup_pincode !== undefined) { params.push(data.pickup_pincode); fields.push(`pickup_pincode       = $${params.length}`); }
    if (data.pickup_maps_link !== undefined) { params.push(data.pickup_maps_link); fields.push(`pickup_maps_link     = $${params.length}`); }
    if (data.pickup_timestamp !== undefined) { params.push(data.pickup_timestamp); fields.push(`pickup_timestamp     = $${params.length}`); }
    if (data.pickup_scheduled_date !== undefined) { params.push(data.pickup_scheduled_date); fields.push(`pickup_scheduled_date = $${params.length}`); }
    if (data.pickup_scheduled_time !== undefined) { params.push(data.pickup_scheduled_time); fields.push(`pickup_scheduled_time = $${params.length}`); }
    if (data.drop_required !== undefined) { params.push(data.drop_required); fields.push(`drop_required        = $${params.length}`); }
    if (data.drop_address_line1 !== undefined) { params.push(data.drop_address_line1); fields.push(`drop_address_line1   = $${params.length}`); }
    if (data.drop_address_line2 !== undefined) { params.push(data.drop_address_line2); fields.push(`drop_address_line2   = $${params.length}`); }
    if (data.drop_city !== undefined) { params.push(data.drop_city); fields.push(`drop_city            = $${params.length}`); }
    if (data.drop_pincode !== undefined) { params.push(data.drop_pincode); fields.push(`drop_pincode         = $${params.length}`); }
    if (data.drop_maps_link !== undefined) { params.push(data.drop_maps_link); fields.push(`drop_maps_link       = $${params.length}`); }
    if (data.reschedule_reason !== undefined) { params.push(data.reschedule_reason); fields.push(`reschedule_reason    = $${params.length}`); }
    if (data.reschedule_notes !== undefined) { params.push(data.reschedule_notes); fields.push(`reschedule_notes     = $${params.length}`); }
    // Customer & vehicle fields
    if (data.customer_name !== undefined) { params.push(data.customer_name); fields.push(`customer_name   = $${params.length}`); }
    if (data.mobile !== undefined) { params.push(data.mobile); fields.push(`mobile          = $${params.length}`); }
    if (data.whatsapp !== undefined) { params.push(data.whatsapp); fields.push(`whatsapp        = $${params.length}`); }
    if (data.vehicle_type_id !== undefined) { params.push(data.vehicle_type_id); fields.push(`vehicle_type_id = $${params.length}`); }
    if (data.make_id !== undefined) { params.push(data.make_id); fields.push(`make_id         = $${params.length}`); }
    if (data.model_id !== undefined) { params.push(data.model_id); fields.push(`model_id        = $${params.length}`); }
    if (data.body_type_id !== undefined) { params.push(data.body_type_id); fields.push(`body_type_id    = $${params.length}`); }
    if (data.cc_category_id !== undefined) { params.push(data.cc_category_id); fields.push(`cc_category_id  = $${params.length}`); }
    if (data.segment_ids !== undefined) { params.push(data.segment_ids); fields.push(`segment_ids     = $${params.length}`); }

    // When date/time is changing, capture the original values + who rescheduled + when
    const isRescheduling = data.scheduled_date !== undefined || data.scheduled_time !== undefined;
    if (isRescheduling && data.reschedule_reason !== undefined) {
      const orig = await pool.query(
        `SELECT scheduled_date, scheduled_time FROM appointments WHERE id = $1`, [id]
      );
      if (orig.rows[0]) {
        const origDate = orig.rows[0].scheduled_date
          ? new Date(orig.rows[0].scheduled_date).toISOString().slice(0, 10)
          : null;
        const origTime = orig.rows[0].scheduled_time || null;
        params.push(origDate); fields.push(`original_scheduled_date = $${params.length}`);
        params.push(origTime); fields.push(`original_scheduled_time = $${params.length}`);
        params.push(req.user.id); fields.push(`rescheduled_by          = $${params.length}`);
        params.push(new Date()); fields.push(`rescheduled_at          = $${params.length}`);
      }
    }

    // Auto-set status to "rescheduled" when date or time is changed (and caller didn't explicitly set a status)
    if (isRescheduling && data.status_id === undefined) {
      const currentAppt = await pool.query(
        `SELECT s.slug FROM appointments a
         LEFT JOIN appointment_statuses s ON s.id = a.status_id
         WHERE a.id = $1`, [id]
      );
      const currentSlug = currentAppt.rows[0]?.slug;
      if (!currentSlug || ['scheduled', 'rescheduled'].includes(currentSlug)) {
        const rescRow = await pool.query(
          `SELECT id FROM appointment_statuses WHERE slug = 'rescheduled' LIMIT 1`
        );
        if (rescRow.rows[0]) {
          params.push(rescRow.rows[0].id);
          fields.push(`status_id = $${params.length}`);
        }
      }
    }

    const hasServiceUpdate = data.services !== undefined;
    if (!fields.length && !hasServiceUpdate) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    // Hub schedule validation when date, time, or hub is being rescheduled
    const isHubRescheduling = data.scheduled_date !== undefined || data.scheduled_time !== undefined || data.hub_id !== undefined;
    if (isHubRescheduling) {
      // Fetch current values to fill in whatever isn't being changed
      const cur = await pool.query(
        `SELECT hub_id, scheduled_date, scheduled_time FROM appointments WHERE id = $1`,
        [id]
      );
      if (cur.rows[0]) {
        const effectiveHub = data.hub_id ?? cur.rows[0].hub_id;
        const effectiveDate = data.scheduled_date ?? (cur.rows[0].scheduled_date
          ? new Date(cur.rows[0].scheduled_date).toISOString().slice(0, 10)
          : null);
        const effectiveTime = data.scheduled_time ?? cur.rows[0].scheduled_time;

        const hubErr = await checkHubSchedule(effectiveHub, effectiveDate, effectiveTime);
        if (hubErr) return res.status(hubErr.status).json({ error: hubErr.error, code: hubErr.code });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (fields.length) {
        params.push(id);
        const r = await client.query(
          `UPDATE appointments SET ${fields.join(', ')}, updated_at = NOW()
           WHERE id = $${params.length} RETURNING id`,
          params
        );
        if (!r.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Appointment not found' });
        }
      } else {
        // Confirm appointment exists even if only services are changing
        const exists = await client.query(`SELECT id FROM appointments WHERE id = $1`, [id]);
        if (!exists.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Appointment not found' });
        }
      }

      // If a hub is being set on this appointment and it never got an
      // appointment_code (it had no hub at creation time), generate one now
      // — anchored to today's date, not the appointment's original creation
      // date. Once set, this never runs again for this appointment, even if
      // the hub is later changed again — see utils/appointmentCode.js.
      if (data.hub_id !== undefined && data.hub_id) {
        const cur = await client.query(
          `SELECT appointment_code FROM appointments WHERE id = $1`, [id]
        );
        if (cur.rows[0] && !cur.rows[0].appointment_code) {
          const hubRow = await client.query(`SELECT hub_code FROM hubs WHERE id = $1`, [data.hub_id]);
          const hubCode = hubRow.rows[0]?.hub_code;
          if (hubCode) {
            const code = await generateAppointmentCode(client, { hubId: data.hub_id, hubCode });
            await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [code, id]);
          }
        }
      }

      // Fix #9: replace services if provided
      if (hasServiceUpdate) {
        await client.query(`DELETE FROM appointment_services WHERE appointment_id = $1`, [id]);
        let total = 0;
        for (const svc of data.services) {
          await client.query(
            `INSERT INTO appointment_services (appointment_id, service_id, category_id, price)
             VALUES ($1, $2, $3, $4)`,
            [id, svc.service_id, svc.category_id || null, svc.price]
          );
          total += Number(svc.price);
        }
        await client.query(
          `UPDATE appointments SET total_price = $1, updated_at = NOW() WHERE id = $2`,
          [total, id]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const row = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    const appt = row.rows[0];
    appt.services = await _getServices(id);
    return res.json({ item: appt });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — fetch services for one appointment
// ─────────────────────────────────────────────────────────────────────────────
async function _getServices(apptId) {
  const r = await pool.query(
    `SELECT
       aps.id, aps.price,
       s.id   AS service_id,   s.name  AS service_name,
       s.customer_rate,        s.gst_percent, s.sac_code,
       sc.id  AS category_id,  sc.name AS category_name
     FROM appointment_services aps
     JOIN services s          ON s.id  = aps.service_id
     LEFT JOIN service_categories sc ON sc.id = aps.category_id
     WHERE aps.appointment_id = $1
     ORDER BY aps.id`,
    [apptId]
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/appointments/:id/vehicle-picked  — manual pickup flow step 1
// POST /api/appointments/:id/at-workshop     — manual pickup flow step 2
// ─────────────────────────────────────────────────────────────────────────────
const advanceAppointmentStatus = require('../helpers/advanceAppointmentStatus');

async function markVehiclePicked(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (await checkIsTerminal(id)) {
      return res.status(400).json({ error: 'Cannot modify a closed, cancelled, or no-show appointment.' });
    }
    const r = await pool.query(`SELECT id, pickup_required FROM appointments WHERE id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    if (!r.rows[0].pickup_required) {
      return res.status(400).json({ error: 'This appointment does not have pickup enabled' });
    }
    await advanceAppointmentStatus(id, 'vehicle-picked');
    const full = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    full.rows[0].services = await _getServices(id);
    res.json({ item: full.rows[0] });
  } catch (err) { next(err); }
}

async function markAtWorkshop(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (await checkIsTerminal(id)) {
      return res.status(400).json({ error: 'Cannot modify a closed, cancelled, or no-show appointment.' });
    }
    const r = await pool.query(`SELECT id, pickup_required FROM appointments WHERE id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    if (!r.rows[0].pickup_required) {
      return res.status(400).json({ error: 'This appointment does not have pickup enabled' });
    }
    await advanceAppointmentStatus(id, 'at-workshop');
    const full = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    full.rows[0].services = await _getServices(id);
    res.json({ item: full.rows[0] });
  } catch (err) { next(err); }
}

module.exports = {
  createAppointment,
  listAppointments,
  getStats,
  getAppointment,
  updateAppointment,
  markVehiclePicked,
  markAtWorkshop,
};
