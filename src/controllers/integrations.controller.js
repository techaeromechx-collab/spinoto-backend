'use strict';

/**
 * Integrations controller — inbound sync from external systems.
 *
 * POST /api/integrations/booking-orders
 *   Called by the booking backend's outbox worker when a PAID order is
 *   created on booking.spinoto.com (contract: booking/API_CONTRACT.md +
 *   BOOKING_WEBHOOK_CONTRACT.md). Creates a first-class CRM appointment.
 *
 *   · Idempotent on order_id (external_ref) — retries return the existing
 *     appointment, never a duplicate.
 *   · Best-effort master-data matching (hub by crm_hub_code, vehicle/services
 *     by name) — unmatched values land in the appointment notes, nothing is
 *     ever lost and nothing blocks the sync.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');
const { logActivity } = require('../services/activityLog.service');
const { generateAppointmentCode } = require('../utils/appointmentCode');
const { generatePublicToken, ensureCustomerIdentity } = require('../utils/publicToken');

const payloadSchema = z.object({
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
  })).optional().default([]),
  payment: z.object({
    razorpay_order_id:   z.string().trim().max(100).optional().nullable(),
    razorpay_payment_id: z.string().trim().max(100).optional().nullable(),
    amount:              z.coerce.number().nonnegative().optional().nullable(),
  }).optional().default({}),
  utm: z.record(z.string(), z.any()).optional().nullable(),
  source: z.string().trim().max(100).optional().default('booking.spinoto.com'),
}).passthrough(); // tolerate extra fields — never break the sync on additions

function bookingOrders(req, res, next) {
  Promise.resolve().then(async () => {
    const data = payloadSchema.parse(req.body);
    const externalRef = `booking:${data.order_id}`;

    // ── Idempotency: replayed webhook → return the existing appointment ────
    const existing = await pool.query(
      `SELECT id, appointment_code FROM appointments WHERE external_ref = $1`,
      [externalRef]
    );
    if (existing.rows[0]) {
      return res.status(200).json({
        ok: true, replay: true,
        appointment_id: existing.rows[0].id,
        appointment_code: existing.rows[0].appointment_code,
      });
    }

    const matched = {}, unmatched = {};

    // ── Hub via crm_hub_code mapping ───────────────────────────────────────
    let hubId = null;
    if (data.hub.crm_hub_code) {
      const h = await pool.query(
        `SELECT id, hub_name FROM hubs WHERE hub_code = $1 AND is_active = TRUE`,
        [data.hub.crm_hub_code]
      );
      if (h.rows[0]) { hubId = h.rows[0].id; matched.hub = h.rows[0].hub_name; }
      else unmatched.hub = data.hub.crm_hub_code;
    }

    // ── Vehicle master-data: best-effort name matching ─────────────────────
    let vehicleTypeId = null, makeId = null, modelId = null;
    if (data.vehicle.type) {
      const vt = await pool.query(
        `SELECT id FROM vehicle_types WHERE is_active = TRUE AND (
           ($1 = '2W' AND (LOWER(name) LIKE '%bike%' OR LOWER(name) LIKE '%scoot%' OR LOWER(name) LIKE '%2%'))
        OR ($1 = '4W' AND (LOWER(name) LIKE '%car%' OR LOWER(name) LIKE '%4%'))
         ) LIMIT 1`,
        [data.vehicle.type]
      );
      vehicleTypeId = vt.rows[0]?.id || null;
    }
    if (data.vehicle.make) {
      const m = await pool.query(
        `SELECT id, name FROM vehicle_makes WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
        [data.vehicle.make]
      );
      if (m.rows[0]) {
        makeId = m.rows[0].id; matched.make = m.rows[0].name;
        if (data.vehicle.model) {
          const md = await pool.query(
            `SELECT id, name FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
            [makeId, data.vehicle.model]
          );
          if (md.rows[0]) { modelId = md.rows[0].id; matched.model = md.rows[0].name; }
          else unmatched.model = data.vehicle.model;
        }
      } else unmatched.make = data.vehicle.make;
    }

    // ── Services: name match → appointment service lines ───────────────────
    const svcLines = [];               // { service_id, category_id, price }
    const unmatchedServices = [];
    for (const s of data.services) {
      const r = await pool.query(
        `SELECT id, category_id, name FROM services WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
        [s.name]
      );
      if (r.rows[0]) svcLines.push({ service_id: r.rows[0].id, category_id: r.rows[0].category_id, price: s.price });
      else unmatchedServices.push(`${s.name} (₹${s.price})`);
    }
    if (unmatchedServices.length) unmatched.services = unmatchedServices;
    matched.services = svcLines.length;

    // ── Notes: everything a human needs, incl. anything unmatched ──────────
    const noteLines = [
      `🌐 Online booking ${data.order_id} (${data.source})`,
      data.customer.address ? `Address: ${data.customer.address}${data.customer.pincode ? ` — ${data.customer.pincode}` : ''}` : null,
      (data.location.lat != null && data.location.lng != null)
        ? `Location: https://maps.google.com/?q=${data.location.lat},${data.location.lng}` : null,
      data.payment.razorpay_payment_id
        ? `Paid online: ₹${data.payment.amount ?? '?'} (Razorpay ${data.payment.razorpay_payment_id})` : null,
      unmatchedServices.length ? `Unmatched services: ${unmatchedServices.join(', ')}` : null,
      unmatched.make ? `Vehicle (as typed): ${[data.vehicle.make, data.vehicle.model, data.vehicle.fuel].filter(Boolean).join(' ')}` : null,
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
            vehicle_type_id, make_id, model_id,
            hub_id, scheduled_date, scheduled_time, status_id, total_price,
            notes, external_ref, booking_source, public_token,
            pickup_maps_link)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          data.customer.name || null, data.customer.mobile,
          data.vehicle.registration_no || null,
          vehicleTypeId, makeId, modelId,
          hubId, data.booking.date, data.booking.time || null,
          defStatus.rows[0]?.id || null, totalPrice,
          noteLines.join('\n'),
          externalRef, data.source, generatePublicToken(),
          (data.location.lat != null && data.location.lng != null)
            ? `https://maps.google.com/?q=${data.location.lat},${data.location.lng}` : null,
        ]
      );
      apptId = ins.rows[0].id;

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
      // Unique-violation race (double delivery hitting simultaneously) →
      // fall back to idempotent replay behavior.
      if (err.code === '23505') {
        const again = await pool.query(
          `SELECT id, appointment_code FROM appointments WHERE external_ref = $1`, [externalRef]);
        if (again.rows[0]) {
          return res.status(200).json({
            ok: true, replay: true,
            appointment_id: again.rows[0].id,
            appointment_code: again.rows[0].appointment_code,
          });
        }
      }
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: null, userName: 'Booking Integration',
      action: 'appointment_synced', entity: 'appointment', entityId: apptId,
      description: `Online booking ${data.order_id} → appointment ${apptCode || `#${apptId}`}${hubId ? '' : ' (no hub — assign manually)'}`,
    });
    getIO().emit('invalidate', { topic: 'appointments' });

    res.status(201).json({
      ok: true,
      appointment_id: apptId,
      appointment_code: apptCode,
      matched,
      unmatched: Object.keys(unmatched).length ? unmatched : null,
    });
  }).catch((err) => {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ') });
    }
    next(err);
  });
}

module.exports = { bookingOrders };
