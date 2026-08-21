'use strict';

/**
 * Booking → CRM appointment.
 *
 * ONE code path, two callers:
 *   · POST /api/integrations/booking-orders   (machine-to-machine webhook)
 *   · POST /api/public/booking/verify-payment (the SPA, after payment)
 *
 * Both go through createBookingAppointment(). It is idempotent on
 * `order_id` — a retry returns the appointment that already exists and
 * never creates a second one.
 *
 * Master-data matching is best effort by design: an unmatched hub, make,
 * model or service never blocks the sync, it lands in the appointment notes
 * so a human can see exactly what the customer typed.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');
const { logActivity } = require('./activityLog.service');
const { generateAppointmentCode } = require('../utils/appointmentCode');
const { generatePublicToken, ensureCustomerIdentity } = require('../utils/publicToken');
const { upsertCustomerVehicle } = require('../utils/customerVehicle');
const { classifyTypeName } = require('./bookingCatalog.service');

// ─────────────────────────────────────────────────────────────────────────────
// Payload contract (BOOKING_WEBHOOK_CONTRACT.md v1.0)
// `.passthrough()` — never break the sync because the sender added a field.
// ─────────────────────────────────────────────────────────────────────────────
const bookingPayloadSchema = z.object({
  order_id: z.string().trim().min(1).max(100),
  event: z.string().optional().default('created'),
  customer: z.object({
    name:    z.string().trim().max(160).optional().nullable(),
    mobile:  z.string().trim().min(7).max(20),
    email:   z.string().trim().max(200).optional().nullable(),
    address: z.string().trim().max(2000).optional().nullable(),
    pincode: z.string().trim().max(10).optional().nullable(),
  }),
  vehicle: z.object({
    registration_no: z.string().trim().max(30).optional().nullable(),
    type:  z.enum(['2W', '4W']).optional().nullable(),
    make:  z.string().trim().max(100).optional().nullable(),
    model: z.string().trim().max(100).optional().nullable(),
    fuel:  z.string().trim().max(30).optional().nullable(),
    // Structured ids when the SPA picked from the CRM catalog — always
    // preferred over the free-text name match below.
    make_id:  z.coerce.number().int().positive().optional().nullable(),
    model_id: z.coerce.number().int().positive().optional().nullable(),
  }).optional().default({}),
  booking: z.object({
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  }),
  hub: z.object({
    crm_hub_code: z.string().trim().max(30).optional().nullable(),
    name: z.string().trim().max(200).optional().nullable(),
  }).optional().default({}),
  location: z.object({
    lat: z.number().optional().nullable(),
    lng: z.number().optional().nullable(),
  }).optional().default({}),
  services: z.array(z.object({
    name:  z.string().trim().max(200),
    price: z.coerce.number().nonnegative().optional().default(0),
    // Set by the public endpoint — skips name matching entirely.
    service_id: z.coerce.number().int().positive().optional().nullable(),
  })).optional().default([]),
  payment: z.object({
    razorpay_order_id:   z.string().trim().max(100).optional().nullable(),
    razorpay_payment_id: z.string().trim().max(100).optional().nullable(),
    amount:              z.coerce.number().nonnegative().optional().nullable(),
  }).optional().default({}),
  utm: z.record(z.string(), z.any()).optional().nullable(),
  source: z.string().trim().max(100).optional().default('booking.spinoto.com'),
}).passthrough();

// ─────────────────────────────────────────────────────────────────────────────
async function findExisting(externalRef) {
  const r = await pool.query(
    `SELECT id, appointment_code FROM appointments WHERE external_ref = $1`,
    [externalRef]
  );
  return r.rows[0] || null;
}

/**
 * vehicle_types rows are free text ('Two-Wheeler', 'Four-Wheeler', 'Car'…),
 * so classify each name in JS rather than guessing with SQL LIKE patterns —
 * a LIKE '%2%' style heuristic silently fails on 'Two-Wheeler'.
 */
async function matchVehicleTypeId(q, typeClass) {
  if (!typeClass) return null;
  const r = await q.query(`SELECT id, name FROM vehicle_types WHERE is_active = TRUE ORDER BY id`);
  const hit = r.rows.find(row => classifyTypeName(row.name) === typeClass);
  return hit ? hit.id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one entry point.
// Returns { replay, appointment_id, appointment_code, matched, unmatched }
// ─────────────────────────────────────────────────────────────────────────────
async function createBookingAppointment(input) {
  const data = bookingPayloadSchema.parse(input);
  const externalRef = `booking:${data.order_id}`;

  const existing = await findExisting(externalRef);
  if (existing) {
    return {
      replay: true,
      appointment_id: existing.id,
      appointment_code: existing.appointment_code,
      matched: {}, unmatched: null,
    };
  }

  const matched = {}, unmatched = {};

  // ── Hub via crm_hub_code ───────────────────────────────────────────────────
  let hubId = null;
  if (data.hub.crm_hub_code) {
    const h = await pool.query(
      `SELECT id, hub_name FROM hubs WHERE hub_code = $1 AND is_active = TRUE`,
      [data.hub.crm_hub_code]
    );
    if (h.rows[0]) { hubId = h.rows[0].id; matched.hub = h.rows[0].hub_name; }
    else unmatched.hub = data.hub.crm_hub_code;
  }

  // ── Vehicle master data: ids first, names only as a fallback ───────────────
  let vehicleTypeId = null, makeId = null, modelId = null;
  let bodyTypeId = null, segmentId = null;

  if (data.vehicle.model_id) {
    const md = await pool.query(
      `SELECT mo.id, mo.name, mo.make_id, mo.body_type_id, mo.segment_id,
              mk.name AS make_name, mk.vehicle_type_id
         FROM vehicle_models mo
         JOIN vehicle_makes mk ON mk.id = mo.make_id
        WHERE mo.id = $1`,
      [data.vehicle.model_id]
    );
    if (md.rows[0]) {
      modelId = md.rows[0].id; makeId = md.rows[0].make_id;
      bodyTypeId = md.rows[0].body_type_id; segmentId = md.rows[0].segment_id;
      vehicleTypeId = md.rows[0].vehicle_type_id;
      matched.model = md.rows[0].name;
      matched.make = md.rows[0].make_name;
    }
  }
  if (!makeId && data.vehicle.make_id) {
    const mk = await pool.query(
      `SELECT id, name, vehicle_type_id FROM vehicle_makes WHERE id = $1`,
      [data.vehicle.make_id]
    );
    if (mk.rows[0]) {
      makeId = mk.rows[0].id; matched.make = mk.rows[0].name;
      vehicleTypeId = vehicleTypeId || mk.rows[0].vehicle_type_id;
    }
  }
  if (!makeId && data.vehicle.make) {
    const m = await pool.query(
      `SELECT id, name, vehicle_type_id FROM vehicle_makes
        WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
      [data.vehicle.make]
    );
    if (m.rows[0]) {
      makeId = m.rows[0].id; matched.make = m.rows[0].name;
      vehicleTypeId = vehicleTypeId || m.rows[0].vehicle_type_id;
      if (data.vehicle.model) {
        const md = await pool.query(
          `SELECT id, name, body_type_id, segment_id FROM vehicle_models
            WHERE make_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [makeId, data.vehicle.model]
        );
        if (md.rows[0]) {
          modelId = md.rows[0].id; matched.model = md.rows[0].name;
          bodyTypeId = md.rows[0].body_type_id; segmentId = md.rows[0].segment_id;
        } else unmatched.model = data.vehicle.model;
      }
    } else unmatched.make = data.vehicle.make;
  }
  if (!vehicleTypeId && data.vehicle.type) {
    vehicleTypeId = await matchVehicleTypeId(pool, data.vehicle.type);
  }
  if (!segmentId && data.vehicle.fuel) {
    const seg = await pool.query(
      `SELECT id FROM segments WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
      [data.vehicle.fuel]
    );
    segmentId = seg.rows[0]?.id || null;
  }

  // ── Services → appointment line items ──────────────────────────────────────
  const svcLines = [];
  const unmatchedServices = [];
  for (const s of data.services) {
    let row = null;
    if (s.service_id) {
      const r = await pool.query(
        `SELECT id, category_id, name FROM services WHERE id = $1 AND is_active = TRUE`, [s.service_id]);
      row = r.rows[0] || null;
    }
    if (!row && s.name) {
      const r = await pool.query(
        `SELECT id, category_id, name FROM services
          WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`, [s.name]);
      row = r.rows[0] || null;
    }
    if (row) svcLines.push({ service_id: row.id, category_id: row.category_id, price: s.price });
    else unmatchedServices.push(`${s.name} (₹${s.price})`);
  }
  if (unmatchedServices.length) unmatched.services = unmatchedServices;
  matched.services = svcLines.length;

  // ── Notes: everything a human needs, including anything unmatched ──────────
  const mapsLink = (data.location.lat != null && data.location.lng != null)
    ? `https://maps.google.com/?q=${data.location.lat},${data.location.lng}` : null;

  const noteLines = [
    `🌐 Online booking ${data.order_id} (${data.source})`,
    data.customer.email ? `Email: ${data.customer.email}` : null,
    data.customer.address
      ? `Address: ${data.customer.address}${data.customer.pincode ? ` — ${data.customer.pincode}` : ''}`
      : null,
    mapsLink ? `Location: ${mapsLink}` : null,
    data.payment.razorpay_payment_id
      ? `Paid online: ₹${data.payment.amount ?? '?'} (Razorpay ${data.payment.razorpay_payment_id})`
      : null,
    unmatchedServices.length ? `Unmatched services: ${unmatchedServices.join(', ')}` : null,
    unmatched.make || unmatched.model
      ? `Vehicle (as typed): ${[data.vehicle.make, data.vehicle.model, data.vehicle.fuel].filter(Boolean).join(' ')}`
      : null,
    !hubId ? '⚠ No hub matched — assign a hub manually.' : null,
    data.utm && Object.keys(data.utm).length ? `UTM: ${JSON.stringify(data.utm)}` : null,
  ].filter(Boolean);

  const totalPrice = svcLines.reduce((s, l) => s + Number(l.price || 0), 0);

  const client = await pool.connect();
  let apptId, apptCode = null;
  try {
    await client.query('BEGIN');

    const defStatus = await client.query(
      `SELECT id FROM appointment_statuses WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`);

    const ins = await client.query(
      `INSERT INTO appointments
         (customer_name, mobile, vehicle_number,
          vehicle_type_id, make_id, model_id, body_type_id, segment_ids,
          hub_id, scheduled_date, scheduled_time, status_id, total_price,
          notes, external_ref, booking_source, public_token, pickup_maps_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        data.customer.name || null, data.customer.mobile,
        data.vehicle.registration_no || null,
        vehicleTypeId, makeId, modelId, bodyTypeId,
        segmentId ? [segmentId] : [],
        hubId, data.booking.date, data.booking.time || null,
        defStatus.rows[0]?.id || null, totalPrice,
        noteLines.join('\n'),
        externalRef, data.source, generatePublicToken(), mapsLink,
      ]
    );
    apptId = ins.rows[0].id;

    // Register the vehicle against the customer, so the Customer page can EDIT
    // it rather than offering to create a second copy. See
    // utils/customerVehicle.js — the plate normalisation there is the part
    // that must not be reinvented here.
    //
    // The values are taken from the same locals the INSERT above used, not
    // re-derived from data.vehicle: those locals are the RESOLVED ids (a
    // booking sends names, which bookingCatalog resolves), and re-deriving
    // them would store a vehicle the appointment does not have.
    await upsertCustomerVehicle(client, data.customer.mobile, {
      vehicle_number:  data.vehicle.registration_no || null,
      vehicle_type_id: vehicleTypeId,
      make_id:         makeId,
      model_id:        modelId,
      segment_id:      segmentId || null,
    });

    await ensureCustomerIdentity(client, data.customer.mobile);

    if (svcLines.length) {
      const vals = svcLines.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(',');
      await client.query(
        `INSERT INTO appointment_services (appointment_id, service_id, category_id, price) VALUES ${vals}`,
        [apptId, ...svcLines.flatMap(l => [l.service_id, l.category_id, l.price])]
      );
    }

    if (hubId) {
      const hubRow = await client.query(`SELECT hub_code FROM hubs WHERE id = $1`, [hubId]);
      if (hubRow.rows[0]?.hub_code) {
        apptCode = await generateAppointmentCode(client, { hubId, hubCode: hubRow.rows[0].hub_code });
        await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [apptCode, apptId]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Unique-violation race (two deliveries at once) → idempotent replay.
    if (err.code === '23505') {
      const again = await findExisting(externalRef);
      if (again) {
        return {
          replay: true,
          appointment_id: again.id,
          appointment_code: again.appointment_code,
          matched: {}, unmatched: null,
        };
      }
    }
    throw err;
  } finally {
    client.release();
  }

  logActivity({
    userId: null, userName: 'Booking Integration',
    action: 'appointment_synced', entity: 'appointment', entityId: apptId,
    description: `Online booking ${data.order_id} → appointment ${apptCode || `#${apptId}`}`
      + `${hubId ? '' : ' (no hub — assign manually)'}`,
  });
  try { getIO().emit('invalidate', { topic: 'appointments' }); } catch { /* socket not up in tests */ }

  return {
    replay: false,
    appointment_id: apptId,
    appointment_code: apptCode,
    matched,
    unmatched: Object.keys(unmatched).length ? unmatched : null,
  };
}

module.exports = { bookingPayloadSchema, createBookingAppointment };
