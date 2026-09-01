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
const { generatePublicToken, ensureCustomerIdentity, resolveTokenToId } = require('../utils/publicToken');
const { upsertCustomerVehicle } = require('../utils/customerVehicle');
const { hubScopeSql, assertHubOwns } = require('../utils/hubScope');

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
  odometer_km: z.coerce.number().int().nonnegative().optional().nullable(),
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
  odometer_km: z.coerce.number().int().nonnegative().optional().nullable(),
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
    a.public_token,
    a.appointment_code,
    a.lead_id,
    a.customer_name,
    a.mobile,
    (SELECT public_token FROM customer_identities WHERE mobile = a.mobile) AS customer_token,
    a.whatsapp,
    a.vehicle_number,
    a.segment_ids,
    TO_CHAR(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
    a.scheduled_time,
    a.total_price,
    a.notes,
    a.odometer_km,
    a.is_warranty_redo,
    a.warranty_claim_id,
    a.booking_source,
    a.external_ref,
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
    (SELECT e.public_token FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_token,
    (SELECT e.status FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS estimate_status,
    EXISTS (SELECT 1 FROM estimates e WHERE e.appointment_id = a.id)                            AS has_estimate,

    -- Linked customer invoice (for status prerequisite checks)
    (SELECT ci.id     FROM customer_invoices ci
       JOIN estimates e ON e.id = ci.estimate_id
       WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_id,
    (SELECT ci.public_token FROM customer_invoices ci
       JOIN estimates e ON e.id = ci.estimate_id
       WHERE e.appointment_id = a.id ORDER BY ci.id DESC LIMIT 1) AS invoice_token,
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
          assigned_to, created_by, public_token, odometer_km
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22,$23,
          $24,$25,
          $26,$27,$28,$29,$30,$31,
          $32,$33,$34,$35
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
          generatePublicToken(),                 // $34
          data.odometer_km ?? null,              // $35
        ]
      );

      const apptId = ins.rows[0].id;

      // Make sure this mobile number has a customer routing identity
      // (public_token) even if no customer_profiles row is ever created.
      await ensureCustomerIdentity(client, data.mobile);

      // ── Register the vehicle against the customer ───────────────────────
      //
      // Until now this did not happen, and the consequence was confusing in a
      // way that looked like a bug in the Customer page.
      //
      // An appointment stores its vehicle in its OWN columns —
      // vehicle_number, vehicle_type_id, make_id, model_id (migration 021).
      // Nothing wrote a customer_vehicles row. So the Customer page, which
      // merges real vehicles with ones DERIVED from appointments, showed the
      // car with cv_id = null — and pressing Edit on a row with no id cannot
      // update anything, so it fell through to "save this vehicle", creating
      // a second record that looked manually added and left the appointment
      // untouched.
      //
      // Standalone estimates have done this since migration 082
      // (estimates.controller.js). Appointments simply never got the same
      // treatment.
      //
      // Same normalisation as addCustomerVehicle: trim + uppercase and
      // NOTHING more. A differently normalised string here would slip past
      // the (mobile, vehicle_number) unique constraint and give one car two
      // rows — the exact problem this is fixing.
      //
      // DO NOTHING, never DO UPDATE: a vehicle the customer already has on
      // file may carry a colour, a year and notes that an appointment form
      // never asks for, and overwriting those with nulls would quietly
      // destroy data every time a job was booked.
      await upsertCustomerVehicle(client, data.mobile, data);

      // Insert service line items — one multi-row statement instead of a loop
      if (data.services.length > 0) {
        const vals = data.services.map((_, i) =>
          `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(',');
        await client.query(
          `INSERT INTO appointment_services (appointment_id, service_id, category_id, price)
           VALUES ${vals}`,
          [apptId, ...data.services.flatMap(s => [s.service_id, s.category_id || null, s.price])]
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

        /* ── Close the open follow-up ────────────────────────────────────
           This file changed the lead's status for years and never touched
           lead_events — the word did not appear in it once. The row stayed
           is_done = FALSE forever.

           It was invisible rather than harmless: listEvents and pendingCount
           both skip leads sitting in a converts_to_appointment status, so
           nobody saw the orphan. Then you DELETE the appointment, the lead is
           returned to the status it held before (see the un-convert below),
           and a follow-up from six weeks ago reappears at the top of somebody's
           list as overdue — for a call that stopped being owed the moment the
           customer booked.

           OUTSIDE the `if (oldStatusName !== newStatusName)` on purpose. The
           thing that settles the follow-up is the BOOKING, not the status
           transition. A lead already sitting in the converting status still
           has its chase settled by an appointment being made.

           auto_closed = TRUE: nobody completed this follow-up, the reason for
           it went away. Counting it as completed would hand every advisor a
           free on-time tick for each lead they convert — which is precisely
           the leads they are most likely to convert. */
        await client.query(
          `UPDATE lead_events
              SET is_done = TRUE, done_at = NOW(), auto_closed = TRUE
            WHERE lead_id = $1 AND is_done = FALSE`,
          [data.lead_id]
        );
      }

      // Queue the "Appointment Generated" WhatsApp message.
      //
      // INSIDE the transaction, before COMMIT, so the message and the
      // appointment live or die together. A queued message for an appointment
      // that then rolled back would tell a customer about a booking that does
      // not exist.
      //
      // fireWhatsAppEvent savepoints its work and never throws, so nothing
      // here can stop the appointment being created. Which template(s) fire —
      // and whether any do — is the wa_automations row for
      // 'appointment.created' (Settings → WhatsApp → Automations), and the
      // dispatcher still requires the template to be enabled + auto-send.
      await fireWhatsAppEvent(client, {
        event: 'appointment.created',
        entityId: apptId,
        // An appointment is created once, so its identity is enough. A retried
        // request that somehow reached here twice would produce one message.
        dedupeKey: `created:${apptId}`,
      });

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
// GET /api/appointments/calendar?month=YYYY-MM  (or date_from / date_to)
//
// WHY THIS IS NOT JUST listAppointments WITH A BIG LIMIT
// ─────────────────────────────────────────────────────
// listAppointments caps page size at 100. A month grid has to show the WHOLE
// month or its cells lie about what is booked — and a calendar that is
// confidently wrong is worse than no calendar. This is bounded by the DATE
// RANGE instead, which a month already is, so no limit is needed and none is
// accepted. The range itself is capped at 62 days so the endpoint can never be
// asked for a decade.
//
// It also returns twelve columns instead of APPT_SELECT's ~50. A cell shows a
// name, a time, a plate and a status; it has no use for pickup addresses or
// reschedule history. Note there is no `mobile` — a calendar does not need it,
// which keeps this clear of the contact-masking rules entirely.
function listAppointmentsCalendar(req, res, next) {
  handle(req, res, next, async () => {
    const month = (req.query.month || '').trim();
    let dateFrom = (req.query.date_from || '').trim();
    let dateTo   = (req.query.date_to   || '').trim();

    // month=YYYY-MM is the convenient form; the grid also needs the tail of the
    // previous month and the head of the next one, so the caller may widen it
    // with explicit dates instead.
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }
      const [y, m] = month.split('-').map(Number);
      const first = new Date(Date.UTC(y, m - 1, 1));
      const last  = new Date(Date.UTC(y, m, 0));       // day 0 of next month
      dateFrom = first.toISOString().slice(0, 10);
      dateTo   = last.toISOString().slice(0, 10);
    }
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'month, or both date_from and date_to, are required' });
    }
    for (const [label, v] of [['date_from', dateFrom], ['date_to', dateTo]]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: `${label} must be YYYY-MM-DD` });
    }
    if (dateTo < dateFrom) return res.status(400).json({ error: 'date_to is before date_from' });
    const span = (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000;
    if (span > 62) {
      return res.status(400).json({ error: 'Range too wide — the calendar loads at most about two months at a time.' });
    }

    const conditions = [];
    const params = [];

    // Same three-tier scoping as listAppointments, in the same order and for
    // the same reasons. A hub login is pinned to its own hub whatever the query
    // string says — without this the calendar would be a way to read every
    // hub's schedule.
    const hubScope = hubScopeSql(req, params, 'a.hub_id');
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_APPOINTMENT');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (!isAll) {
      params.push([req.user.id]);
      conditions.push(
        /* MINE, by any of the three routes an appointment can belong to me.
           This used to ask ONLY the last one — "is the linked LEAD mine" — and
           that silently assumed every appointment comes from a lead. It does
           not: lead_id is optional on create, so anything raised with the New
           Appointment button stores lead_id = NULL, `l.id = a.lead_id` never
           matches a NULL, and the person who just created it could not see it
           on their own screen. Their appointment was in the database, with
           their id in created_by, filtered out by a clause that never looked
           there.

           a.created_by and a.assigned_to are recorded on every row already.
           Reading them adds nothing to this user's reach beyond appointments
           that are theirs by name — which is what this tier has always meant. */
        `(
          a.created_by  = ANY($${params.length})
          OR a.assigned_to = ANY($${params.length})
          OR EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = a.lead_id
            AND (l.created_by = ANY($${params.length}) OR l.assigned_to = ANY($${params.length}))
          )
        )`
      );
    }

    // Skipped for hub logins, exactly as in the list: hubScope already pinned
    // the hub, and honouring the query string too would let a client widen it.
    const hubIds = req.query.hub_ids || '';
    const hubId  = req.query.hub_id  || '';
    if (!hubScope && hubIds) {
      const ids = hubIds.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`a.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && hubId) {
      params.push(Number(hubId));
      conditions.push(`a.hub_id = $${params.length}`);
    }
    if (req.query.status_id) {
      params.push(Number(req.query.status_id));
      conditions.push(`a.status_id = $${params.length}`);
    }
    if ((req.query.search || '').trim()) {
      params.push(`%${req.query.search.trim().toLowerCase()}%`);
      const n = params.length;
      conditions.push(
        `(LOWER(COALESCE(a.customer_name,'')) LIKE $${n}
          OR a.mobile LIKE $${n}
          OR LOWER(COALESCE(a.vehicle_number,'')) LIKE $${n})`
      );
    }

    params.push(dateFrom);
    conditions.push(`a.scheduled_date >= $${params.length}`);
    params.push(dateTo);
    conditions.push(`a.scheduled_date <= $${params.length}`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Ordered by the schedule, not by booking order: the client groups these
    // into day cells and each cell should read top-to-bottom as the day runs.
    const r = await pool.query(
      `SELECT
         a.id,
         a.public_token,
         TO_CHAR(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
         a.scheduled_time,
         a.customer_name,
         a.vehicle_number,
         a.status_id,
         ast.name     AS status_name,
         ast.color    AS status_color,
         ast.bg_color AS status_bg,
         a.hub_id,
         h.hub_name
       FROM appointments a
       LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
       LEFT JOIN hubs h ON h.id = a.hub_id
       ${where}
       ORDER BY a.scheduled_date ASC, a.scheduled_time ASC NULLS LAST, a.id ASC`,
      params
    );

    res.json({ items: r.rows, date_from: dateFrom, date_to: dateTo, total: r.rowCount });
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
    // Three tiers, and the ORDER MATTERS:
    //
    //   1. Hub-portal login  → their own hub, full stop. Checked FIRST so that
    //      granting a hub user VIEW_APPOINTMENT widens them *within* their hub
    //      rather than across every hub. Before this branch existed a hub login
    //      had only two possible views: nothing at all (the leads fallback below
    //      never matches, because hub users create no leads) or every hub's
    //      appointments. Neither is what a hub partner should see.
    //   2. Super admin / VIEW_APPOINTMENT → everything.
    //   3. Otherwise (e.g. CREATE_APPOINTMENT only) → appointments linked to
    //      leads they created or are assigned to.
    const hubScope = hubScopeSql(req, params, 'a.hub_id');
    const isAll = req.user.is_super_admin || req.user.permissions.has('VIEW_APPOINTMENT');
    if (hubScope) {
      conditions.push(hubScope);
    } else if (!isAll) {
      params.push([req.user.id]);
      conditions.push(
        /* MINE, by any of the three routes an appointment can belong to me.
           This used to ask ONLY the last one — "is the linked LEAD mine" — and
           that silently assumed every appointment comes from a lead. It does
           not: lead_id is optional on create, so anything raised with the New
           Appointment button stores lead_id = NULL, `l.id = a.lead_id` never
           matches a NULL, and the person who just created it could not see it
           on their own screen. Their appointment was in the database, with
           their id in created_by, filtered out by a clause that never looked
           there.

           a.created_by and a.assigned_to are recorded on every row already.
           Reading them adds nothing to this user's reach beyond appointments
           that are theirs by name — which is what this tier has always meant. */
        `(
          a.created_by  = ANY($${params.length})
          OR a.assigned_to = ANY($${params.length})
          OR EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = a.lead_id
            AND (l.created_by = ANY($${params.length}) OR l.assigned_to = ANY($${params.length}))
          )
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
    // Skipped entirely for hub logins — hubScope above already pinned the hub,
    // and honouring the query string as well would let a client widen it.
    if (!hubScope && hubIds) {
      const ids = hubIds.split(',').map(Number).filter(n => !isNaN(n));
      if (ids.length > 0) {
        params.push(ids);
        conditions.push(`a.hub_id = ANY($${params.length}::int[])`);
      }
    } else if (!hubScope && hubId) {
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
    // The hub predicate goes in the JOIN, not a WHERE: this is a LEFT JOIN and
    // the point of the query is that every active status appears, with 0 for
    // the ones this hub has nothing in. In a WHERE clause the NULL side of the
    // join would be filtered out and empty statuses would vanish from the tabs.
    const params = [];
    const hubScope = hubScopeSql(req, params, 'a.hub_id');
    const rows = await pool.query(`
      SELECT
        ast.id, ast.name, ast.color, ast.bg_color,
        COUNT(a.id)::int AS count
      FROM appointment_statuses ast
      LEFT JOIN appointments a
        ON a.status_id = ast.id${hubScope ? ` AND ${hubScope}` : ''}
      WHERE ast.is_active = TRUE
      GROUP BY ast.id
      ORDER BY ast.sort_order NULLS LAST, ast.id
    `, params);
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
    // Scoping the list is not enough — without this, a hub login can read any
    // appointment by walking ids. 404 rather than 403 so the status code isn't
    // an existence oracle. Covers /by-token/:token too: it resolves the token
    // then delegates here.
    assertHubOwns(req, appt, 'hub_id', 'Appointment');
    appt.services = await _getServices(id);
    return res.json({ item: appt });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/appointments/by-token/:token — resolves a public_token (used in
// shareable /appointments/:token URLs) to the numeric id, then delegates to
// the exact same logic as GET /api/appointments/:id.
// ─────────────────────────────────────────────────────────────────────────────
function getAppointmentByToken(req, res, next) {
  handle(req, res, next, async () => {
    const id = await resolveTokenToId(pool, 'appointments', req.params.token);
    if (!id) return res.status(404).json({ error: 'Appointment not found' });
    req.params.id = String(id);
    return getAppointment(req, res, next);
  });
}

/**
 * Hub tenancy guard for the handlers whose own SELECT does not already carry
 * hub_id. One extra round trip, only on hub-portal requests — for staff and
 * super admins hubScope/assertHubOwns are no-ops and this returns immediately.
 * Throws 404 (not 403) so ids can't be enumerated by status code.
 */
async function _assertApptHub(req, id) {
  if (!req.user?.hub_id) return;
  const r = await pool.query(`SELECT hub_id FROM appointments WHERE id = $1`, [id]);
  assertHubOwns(req, r.rows[0], 'hub_id', 'Appointment');
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

    await _assertApptHub(req, id);

    if (await checkIsTerminal(id)) {
      return res.status(400).json({ error: 'Cannot modify a closed, cancelled, or no-show appointment.' });
    }

    // ── What the status was, before we touch it ──────────────────────────
    //
    // Read here rather than inside the transaction because the messaging
    // decision below needs the BEFORE value, and by the time the UPDATE has run
    // there is nothing left to compare against.
    //
    // Only when a status change was actually requested — an ordinary edit that
    // never mentions status_id must not pay for a query it will not use.
    let prevStatusId = null;
    if (data.status_id !== undefined) {
      const prev = await pool.query('SELECT status_id FROM appointments WHERE id = $1', [id]);
      prevStatusId = prev.rows[0]?.status_id ?? null;
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
    if (data.odometer_km !== undefined) { params.push(data.odometer_km); fields.push(`odometer_km         = $${params.length}`); }
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
        // Mobile can be corrected after creation — make sure the new number
        // has a shareable-URL identity too, so customer_token stays populated.
        if (data.mobile !== undefined) {
          await ensureCustomerIdentity(client, data.mobile);
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

    // ── A status changed BY HAND still tells the customer ──────────────────
    //
    // Every other route to a status change goes through advanceAppointmentStatus,
    // which fires whatever template Settings → WhatsApp has pointed at that
    // status. This handler is the exception: it writes status_id straight into
    // its own UPDATE, alongside date, time, notes and everything else, so the
    // helper never ran and the message never went.
    //
    // The result was a status that messaged the customer when the system
    // reached it and stayed silent when a person picked it from the dropdown —
    // same status, same customer, different outcome, for no reason anybody
    // chose.
    //
    // Reusing fireStatusMessages rather than calling advanceAppointmentStatus:
    // that helper would re-run the UPDATE we have just committed, and its
    // IS DISTINCT FROM guard would then find nothing changed and return before
    // messaging. The row is already correct; only the notification is missing.
    //
    // AFTER the commit, and never thrown. The status change is saved either
    // way, and a WhatsApp outage must not turn a successful edit into an error.
    if (data.status_id !== undefined && data.status_id !== prevStatusId) {
      pool.query(
        'SELECT slug FROM appointment_statuses WHERE id = $1 AND is_system = TRUE',
        [data.status_id]
      )
        // Only system statuses carry a slug. A custom status added in Master
        // Data has none, cannot be a trigger, and is not an error — there is
        // simply nothing configured to fire.
        .then(r => r.rows[0]?.slug && fireStatusMessages(id, r.rows[0].slug))
        .catch(err =>
          console.error(`[whatsapp] status message for appt #${id} failed:`, err.message));
    }

    const row = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    const appt = row.rows[0];
    appt.services = await _getServices(id);

    // ── Tell the customer their appointment moved ──────────────────────────
    //
    // Fired here rather than through advanceAppointmentStatus, for two reasons
    // that both make a SECOND reschedule silent:
    //
    //   1. That helper updates WHERE status_id IS DISTINCT FROM the new one and
    //      returns early when nothing changed. An appointment already sitting
    //      in 'rescheduled' is exactly that case, so moving it a second time
    //      would never reach the messaging step at all.
    //
    //   2. Its dedupe key is the transition ('status:rescheduled'), and the
    //      unique index on wa_messages is
    //      (template_key, entity_type, entity_id, dedupe_key). One appointment
    //      would therefore produce one reschedule message, ever.
    //
    // Rescheduling twice is ordinary. So the key is the NEW SLOT: a retried
    // request carries the same date and time and collapses to one message,
    // while a genuine second move produces a different key and sends again.
    //
    // AFTER the commit, and never thrown — a messaging failure must not undo a
    // reschedule that has already been saved, and the customer's date has
    // changed whether or not the message goes out.
    if (isRescheduling) {
      // fireWhatsAppEventDetached owns the connection/transaction/logging the
      // hand-rolled block here used to. The templates come from the
      // 'appointment.rescheduled' automation rows (migration 151).
      await fireWhatsAppEventDetached(pool, {
        event: 'appointment.rescheduled',
        entityId: id,
        dedupeKey: `reschedule:${appt.scheduled_date || ''}T${appt.scheduled_time || ''}`,
      });
    }

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
// The messaging half of that helper, on its own. Used where the status row
// has ALREADY been written and only the notification is outstanding.
const { fireStatusMessages } = require('../helpers/advanceAppointmentStatus');
const { fireWhatsAppEvent, fireWhatsAppEventDetached } = require('../services/whatsappAutomations.service');

async function markVehiclePicked(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (await checkIsTerminal(id)) {
      return res.status(400).json({ error: 'Cannot modify a closed, cancelled, or no-show appointment.' });
    }
    const r = await pool.query(`SELECT id, hub_id, pickup_required FROM appointments WHERE id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    assertHubOwns(req, r.rows[0], 'hub_id', 'Appointment');
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
    const r = await pool.query(`SELECT id, hub_id, pickup_required FROM appointments WHERE id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    assertHubOwns(req, r.rows[0], 'hub_id', 'Appointment');
    if (!r.rows[0].pickup_required) {
      return res.status(400).json({ error: 'This appointment does not have pickup enabled' });
    }
    await advanceAppointmentStatus(id, 'at-workshop');
    const full = await pool.query(`${APPT_SELECT} WHERE a.id = $1`, [id]);
    full.rows[0].services = await _getServices(id);
    res.json({ item: full.rows[0] });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Appointment deletion (DELETE_APPOINTMENT permission)
//
// An appointment anchors a whole chain: services → estimate → PI → CI →
// claims. Deletion cascades through all of it — but is HARD-BLOCKED the
// moment any money has moved (CI customer payments or PI hub payments).
// Real jobs get CANCELLED; deletion is for junk/test/duplicate entries.
// ─────────────────────────────────────────────────────────────────────────────

// Collects everything hanging off an appointment — used by both the preview
// endpoint (the frontend warning popup) and the delete guards.
async function _collectAppointmentChain(apptId) {
  const est = (await pool.query(
    `SELECT id, status, grand_total, warranty_claim_id FROM estimates WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1`,
    [apptId]
  )).rows[0] || null;

  let pi = null, ci = null, claims = [];
  if (est) {
    pi = (await pool.query(
      `SELECT id, status, payment_status, COALESCE(amount_paid,0) AS amount_paid, grand_total
         FROM purchase_invoices WHERE estimate_id = $1 ORDER BY id DESC LIMIT 1`, [est.id]
    )).rows[0] || null;
    ci = (await pool.query(
      `SELECT ci.id, ci.status, ci.grand_total, COALESCE(ci.amount_paid,0) AS amount_paid,
              (SELECT COUNT(*)::int FROM invoice_payment_lines p WHERE p.customer_invoice_id = ci.id) AS payment_count
         FROM customer_invoices ci WHERE ci.estimate_id = $1 ORDER BY ci.id DESC LIMIT 1`, [est.id]
    )).rows[0] || null;
    if (ci) {
      claims = (await pool.query(
        `SELECT id, claim_code, status, claim_type, redo_appointment_id
           FROM warranty_claims WHERE customer_invoice_id = $1`, [ci.id]
      )).rows;
    }
  }
  return { est, pi, ci, claims };
}

// GET /api/appointments/:id/delete-preview — what would be deleted, and any
// blockers. Drives the confirmation popup.
function deletePreview(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const appt = (await pool.query(
      `SELECT a.id, a.hub_id, a.appointment_code, a.lead_id, a.is_warranty_redo, a.warranty_claim_id,
              (SELECT COUNT(*)::int FROM appointments a2 WHERE a2.lead_id = a.lead_id AND a2.id <> a.id) AS other_appointments
         FROM appointments a WHERE a.id = $1`, [id]
    )).rows[0];
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    assertHubOwns(req, appt, 'hub_id', 'Appointment');

    const { est, pi, ci, claims } = await _collectAppointmentChain(id);

    const blockers = [];
    if (ci && (parseFloat(ci.amount_paid) > 0 || ci.payment_count > 0)) {
      blockers.push(`Customer invoice CI-${String(ci.id).padStart(6, '0')} has ${ci.payment_count} payment(s) totalling ₹${parseFloat(ci.amount_paid).toFixed(2)}.`);
    }
    if (pi && parseFloat(pi.amount_paid) > 0) {
      blockers.push(`Hub payout of ₹${parseFloat(pi.amount_paid).toFixed(2)} was already made on PI-${String(pi.id).padStart(6, '0')}.`);
    }

    res.json({
      appointment: { id: appt.id, code: appt.appointment_code, is_warranty_redo: appt.is_warranty_redo },
      estimate: est ? { id: est.id, status: est.status, grand_total: est.grand_total } : null,
      purchase_invoice: pi ? { id: pi.id, code: `PI-${String(pi.id).padStart(6, '0')}`, status: pi.status } : null,
      customer_invoice: ci ? { id: ci.id, code: `CI-${String(ci.id).padStart(6, '0')}`, status: ci.status } : null,
      claims: claims.map(c => ({ id: c.id, code: c.claim_code, status: c.status })),
      lead_revert: !!(appt.lead_id && appt.other_appointments === 0),
      redo_claim_reset: appt.is_warranty_redo && appt.warranty_claim_id ? true : false,
      blockers,
      deletable: blockers.length === 0,
    });
  });
}

// DELETE /api/appointments/:id
function deleteAppointment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const appt = (await pool.query(
      `SELECT id, hub_id, appointment_code, lead_id, is_warranty_redo, warranty_claim_id FROM appointments WHERE id = $1`, [id]
    )).rows[0];
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    assertHubOwns(req, appt, 'hub_id', 'Appointment');

    const { est, pi, ci, claims } = await _collectAppointmentChain(id);

    // ── Hard blocks: money has moved ──
    if (ci && (parseFloat(ci.amount_paid) > 0 || ci.payment_count > 0)) {
      return res.status(409).json({
        error: `CI-${String(ci.id).padStart(6, '0')} has customer payments (₹${parseFloat(ci.amount_paid).toFixed(2)}) — this job has financial history. Cancel the appointment instead of deleting it, or delete the payments first.`,
      });
    }
    if (pi && parseFloat(pi.amount_paid) > 0) {
      return res.status(409).json({
        error: `A hub payout of ₹${parseFloat(pi.amount_paid).toFixed(2)} was already made on PI-${String(pi.id).padStart(6, '0')} — this job has financial history. Cancel the appointment instead of deleting it.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Claims made against this job's CI: unhook any redo jobs they
      //    spawned (those live on OTHER appointments), then delete the claims.
      for (const c of claims) {
        await client.query(`UPDATE appointments SET warranty_claim_id = NULL WHERE warranty_claim_id = $1`, [c.id]);
        await client.query(`UPDATE estimates    SET warranty_claim_id = NULL WHERE warranty_claim_id = $1`, [c.id]);
      }
      if (ci) {
        await client.query(`DELETE FROM warranty_claims WHERE customer_invoice_id = $1`, [ci.id]);
      }

      // 2) If THIS appointment is a warranty-redo job, reset its claim so a
      //    fresh redo can be created (resolved/approved → approved, links cleared).
      if (appt.warranty_claim_id) {
        await client.query(
          `UPDATE warranty_claims
              SET redo_appointment_id = NULL, redo_estimate_id = NULL,
                  status = CASE WHEN status = 'resolved' THEN 'approved' ELSE status END,
                  updated_at = NOW()
            WHERE id = $1`, [appt.warranty_claim_id]);
      }

      // 3) CI (no payments — guaranteed above)
      if (ci) {
        await client.query(`DELETE FROM customer_invoice_payments WHERE customer_invoice_id = $1`, [ci.id]);
        await client.query(`DELETE FROM customer_invoice_items    WHERE customer_invoice_id = $1`, [ci.id]);
        await client.query(`DELETE FROM customer_invoices         WHERE id = $1`, [ci.id]);
      }

      // 4) PI (unpaid — guaranteed above)
      if (pi) {
        await client.query(`DELETE FROM pi_payment_schedule    WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM hub_payments           WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = $1`, [pi.id]);
        await client.query(`DELETE FROM purchase_invoices      WHERE id = $1`, [pi.id]);
      }

      // 5) Estimate
      if (est) {
        await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [est.id]);
        await client.query(`DELETE FROM estimates      WHERE id = $1`, [est.id]);
      }

      // 6) The appointment itself + its satellites
      await client.query(`DELETE FROM appointment_services     WHERE appointment_id = $1`, [id]);
      await client.query(`DELETE FROM appointment_reminder_log WHERE appointment_id = $1`, [id]);
      await client.query(`DELETE FROM appointments             WHERE id = $1`, [id]);

      /* 7) Lead: if this was the lead's ONLY appointment, un-convert it and
            log it on the lead timeline.

         ── WHERE IT GOES BACK TO ────────────────────────────────────────────
         Two tiers, and the order matters.

         FIRST, back where it actually was. Converting the lead wrote a
         status_changed row whose old_value is the status it held the moment
         before — 'Follow-Up - Details Sent', or wherever the advisor had got
         to. That is the honest destination, and it is already recorded; using
         a fixed bucket instead throws away a fact the timeline is holding.

         SECOND, the default status, only when the first cannot answer: the
         lead was created already converted so there is no earlier status, or
         the status it came from has since been deleted. That is what a default
         is FOR — the net, not the first choice.

         The recovered name is checked against lead_statuses before it is used.
         An old_value naming a status somebody deleted last month would put the
         lead on a status no filter, colour or board column recognises, which is
         worse than the generic bucket. */
      if (appt.lead_id) {
        const others = await client.query(
          `SELECT COUNT(*)::int AS n FROM appointments WHERE lead_id = $1`, [appt.lead_id]);
        if (others.rows[0].n === 0) {
          const back = await client.query(
            `SELECT ls.name
               FROM lead_activities la
               JOIN lead_statuses  ls
                 ON ls.name = la.old_value AND ls.is_active
              WHERE la.lead_id = $1
                AND la.type = 'status_changed'
                AND la.old_value IS NOT NULL
                -- The transition INTO the converting status, not any earlier
                -- one. Ordered newest first and taken one at a time, so a lead
                -- converted twice returns to where the LAST conversion found
                -- it.
                AND EXISTS (SELECT 1 FROM lead_statuses c
                             WHERE c.name = la.new_value AND c.converts_to_appointment)
              ORDER BY la.created_at DESC
              LIMIT 1`,
            [appt.lead_id]);

          const target = back.rows[0]?.name || (await client.query(
            `SELECT name FROM lead_statuses WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`
          )).rows[0]?.name || null;

          if (target) {
            await client.query(`UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2`,
              [target, appt.lead_id]);

            /* ── And give it back a follow-up ────────────────────────────
               This is the hole the booking-side close above opened.

               The lead is returned to the status it held before it converted,
               and that status is almost always one that carries
               needs_follow_up — you convert a lead OUT of "Call Unanswered -
               Attempt 2" or "Follow-Up - General", so that is where it lands
               coming back. Meanwhile its follow-up was closed when the
               appointment was booked. So without this, deleting an appointment
               puts a lead into a chase status with nothing chasing it, and it
               is invisible: the Follow-up list is built from OPEN lead_events
               rows, so a lead with none simply is not there.

               Note that the UPDATE above writes leads.status directly and so
               walks straight past the needs_follow_up guard in
               leads.controller.js. That guard is the right shape for a request
               a person made; this is a consequence of one, and refusing it
               would mean refusing to delete the appointment.

               Due TODAY, not on the old date. The original due date belonged
               to a conversation that has since been overtaken twice — the
               customer booked, and then the booking was cancelled. Reviving it
               would put a months-old date at the top of somebody's overdue
               list, which is the exact stale-reminder bug the booking-side
               close was added to stop. Today is honest: this lead needs a call
               now, because something just fell through.

               ON CONFLICT is not needed — the booking closed everything open —
               but the guard is: if a follow-up was somehow scheduled while the
               appointment stood, two open rows would put the lead in the list
               twice. */
            const needsChase = await client.query(
              `SELECT 1 FROM lead_statuses
                WHERE name = $1 AND needs_follow_up = TRUE AND is_active = TRUE`, [target]);

            if (needsChase.rows[0]) {
              const already = await client.query(
                `SELECT 1 FROM lead_events WHERE lead_id = $1 AND is_done = FALSE LIMIT 1`,
                [appt.lead_id]);

              if (!already.rows[0]) {
                await client.query(
                  `INSERT INTO lead_events (lead_id, status_name, due_date, due_at, note, created_by)
                   VALUES ($1, $2, CURRENT_DATE, NOW(), $3, $4)`,
                  [appt.lead_id, target,
                   `Appointment ${appt.appointment_code || `#${id}`} was deleted — lead returned to ${target}`,
                   req.user.id]
                );
              }
            }
          }
        }
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, new_value, note, created_by)
           VALUES ($1, 'status_changed', 'Appointment deleted', $2, $3)`,
          [appt.lead_id,
           `Appointment ${appt.appointment_code || `#${id}`} was permanently deleted${others.rows[0].n === 0 ? ' — lead returned to pipeline' : ''}`,
           req.user.id]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'appointment_deleted', entity: 'appointment', entityId: id,
      description: `Deleted appointment ${appt.appointment_code || `#${id}`}${est ? ` incl. estimate #${est.id}` : ''}${pi ? `, PI-${String(pi.id).padStart(6, '0')}` : ''}${ci ? `, CI-${String(ci.id).padStart(6, '0')}` : ''}${claims.length ? `, ${claims.length} claim(s)` : ''}`,
    });

    res.status(204).end();
  });
}

module.exports = {
  listAppointmentsCalendar,
  createAppointment,
  listAppointments,
  getStats,
  getAppointment,
  getAppointmentByToken,
  updateAppointment,
  markVehiclePicked,
  markAtWorkshop,
  deletePreview,
  deleteAppointment,
};
