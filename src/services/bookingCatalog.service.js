'use strict';

/**
 * Booking catalog — the master data booking.spinoto.com reads.
 *
 * Two jobs:
 *   1. Turn the CRM's services + pricing rules into the EXACTLY THREE tiers
 *      the landing page sells (Basic / Standard / Comprehensive).
 *   2. Serve the vehicle make/model catalog from vehicle_makes/vehicle_models.
 *
 * Pricing is deliberately NOT reimplemented here — resolvePrice() runs the
 * same specificity-scored query as GET /api/pricing/lookup, with the same
 * weights and the same service→category fallback. If those weights ever
 * change in pricing.controller.js they must change here too (CLAUDE.md
 * invariant #3 says they should never change at all).
 */

const { pool } = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle type: the booking page speaks '2W'/'4W'; vehicle_types is free text
// ('Two-Wheeler', 'Four-Wheeler', 'Commercial', 'Bike', 'Car', …).
// ─────────────────────────────────────────────────────────────────────────────
const TWO_WHEELER_RE = /(^|[^a-z])(2\s*-?\s*w|two[\s-]*wheel|bike|scoot|motorcycle|motorbike)/i;
const FOUR_WHEELER_RE = /(^|[^a-z])(4\s*-?\s*w|four[\s-]*wheel|car\b|sedan|hatch|suv)/i;

/** '2W' | '4W' | null for a vehicle_types.name */
function classifyTypeName(name) {
  const n = String(name || '');
  if (TWO_WHEELER_RE.test(n)) return '2W';
  if (FOUR_WHEELER_RE.test(n)) return '4W';
  return null;
}

/** Cheapest active vehicle_types row matching '2W' or '4W'. Null if none. */
async function resolveVehicleTypeId(q, typeClass) {
  if (typeClass !== '2W' && typeClass !== '4W') return null;
  const r = await q.query(
    `SELECT id, name FROM vehicle_types WHERE is_active = TRUE ORDER BY id`
  );
  const hit = r.rows.find(row => classifyTypeName(row.name) === typeClass);
  return hit ? hit.id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle context — everything the pricing engine can key off, derived from
// whatever little the booking page knows (type + make_id + model_id + fuel).
// ─────────────────────────────────────────────────────────────────────────────
async function resolveVehicleContext(q, { vehicle_type, make_id, model_id, fuel } = {}) {
  const ctx = {
    vehicleTypeId: null, makeId: null, modelId: null,
    bodyTypeId: null, segmentId: null, ccCategoryId: null,
  };

  if (model_id) {
    const m = await q.query(
      `SELECT mo.id, mo.make_id, mo.segment_id, mo.body_type_id, mk.vehicle_type_id
         FROM vehicle_models mo
         JOIN vehicle_makes mk ON mk.id = mo.make_id
        WHERE mo.id = $1 AND mo.is_active = TRUE`,
      [model_id]
    );
    if (m.rows[0]) {
      ctx.modelId = m.rows[0].id;
      ctx.makeId = m.rows[0].make_id;
      ctx.segmentId = m.rows[0].segment_id;
      ctx.bodyTypeId = m.rows[0].body_type_id;
      ctx.vehicleTypeId = m.rows[0].vehicle_type_id;
    }
  }

  if (!ctx.makeId && make_id) {
    const mk = await q.query(
      `SELECT id, vehicle_type_id FROM vehicle_makes WHERE id = $1 AND is_active = TRUE`,
      [make_id]
    );
    if (mk.rows[0]) {
      ctx.makeId = mk.rows[0].id;
      ctx.vehicleTypeId = ctx.vehicleTypeId || mk.rows[0].vehicle_type_id;
    }
  }

  if (!ctx.vehicleTypeId && vehicle_type) {
    ctx.vehicleTypeId = await resolveVehicleTypeId(q, vehicle_type);
  }

  // The booking page asks for fuel by name ("Petrol"); segments is that table.
  if (!ctx.segmentId && fuel) {
    const seg = await q.query(
      `SELECT id FROM segments WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
      [fuel]
    );
    ctx.segmentId = seg.rows[0]?.id || null;
  }

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price resolution — mirrors pricing.controller.js#lookupPrice exactly.
// Returns a Number (inc-GST, per CLAUDE.md invariant #2) or null.
// ─────────────────────────────────────────────────────────────────────────────
const SPECIFICITY_SQL = `
  SELECT p.price
    FROM pricing p
   WHERE p.is_active = TRUE
     AND ($1::int IS NULL OR p.service_id  = $1)
     AND ($2::int IS NULL OR p.category_id = $2)
     AND (p.vehicle_type_id IS NULL OR p.vehicle_type_id = $3)
     AND (p.body_type_id    IS NULL OR p.body_type_id    = $4)
     AND (p.segment_id      IS NULL OR p.segment_id      = $5)
     AND (p.make_id         IS NULL OR p.make_id         = $6)
     AND (p.model_id        IS NULL OR p.model_id        = $7)
     AND (p.cc_category_id  IS NULL OR p.cc_category_id  = $8)
   ORDER BY
     (CASE WHEN p.model_id        IS NOT NULL THEN 64 ELSE 0 END +
      CASE WHEN p.make_id         IS NOT NULL THEN 32 ELSE 0 END +
      CASE WHEN p.segment_id      IS NOT NULL THEN  9 ELSE 0 END +
      CASE WHEN p.body_type_id    IS NOT NULL THEN  8 ELSE 0 END +
      CASE WHEN p.cc_category_id  IS NOT NULL THEN  8 ELSE 0 END +
      CASE WHEN p.vehicle_type_id IS NOT NULL THEN  4 ELSE 0 END) DESC
   LIMIT 1`;

async function resolvePrice(q, { serviceId = null, categoryId = null }, ctx = {}) {
  const args = (svc, cat) => [
    svc, cat,
    ctx.vehicleTypeId || null, ctx.bodyTypeId || null, ctx.segmentId || null,
    ctx.makeId || null, ctx.modelId || null, ctx.ccCategoryId || null,
  ];

  let r = await q.query(SPECIFICITY_SQL, args(serviceId, categoryId));
  if (r.rowCount === 0 && serviceId) {
    // Service rules always win; only fall back to the category when no
    // service-level rule matched at all.
    const svc = await q.query(`SELECT category_id FROM services WHERE id = $1`, [serviceId]);
    const catId = svc.rows[0]?.category_id;
    if (catId) r = await q.query(SPECIFICITY_SQL, args(null, catId));
  }
  return r.rows[0] ? Number(r.rows[0].price) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The three packages, priced for this vehicle.
//
// Price precedence:  pricing rule  →  services.customer_rate  →  fallback_price
// `price_source` is returned so a support person can see which layer answered.
// ─────────────────────────────────────────────────────────────────────────────
async function listBookingPackages(vehicle = {}) {
  const ctx = await resolveVehicleContext(pool, vehicle);

  const { rows } = await pool.query(
    `SELECT bp.slug, bp.title, bp.tagline, bp.features, bp.includes_previous,
            bp.is_popular, bp.fallback_price, bp.sort_order,
            s.id AS service_id, s.name AS service_name, s.category_id,
            s.customer_rate, s.gst_percent, s.description
       FROM booking_packages bp
       JOIN services s ON s.id = bp.service_id AND s.is_active = TRUE
      WHERE bp.is_active = TRUE
      ORDER BY bp.sort_order ASC, bp.id ASC`
  );

  const items = [];
  for (const row of rows) {
    const ruled = await resolvePrice(pool, { serviceId: row.service_id }, ctx);
    let price = ruled;
    let source = 'pricing_rule';
    if (price == null && row.customer_rate != null) {
      price = Number(row.customer_rate); source = 'customer_rate';
    }
    if (price == null && row.fallback_price != null) {
      price = Number(row.fallback_price); source = 'fallback';
    }
    if (price == null) continue; // nothing to sell — don't render a blank card

    items.push({
      // `id` is the landing page's package_id — create-order sends it back.
      id: row.slug,
      service_id: row.service_id,
      name: row.title || row.service_name,
      tagline: row.tagline || undefined,
      price,
      price_source: source,
      gst_percent: row.gst_percent != null ? Number(row.gst_percent) : null,
      popular: row.is_popular || undefined,
      includes_previous: row.includes_previous || null,
      features: Array.isArray(row.features) ? row.features : [],
    });
  }

  return { items, vehicle_context: ctx };
}

/** One package by slug, priced — used server-side by create-order. */
async function getBookingPackage(slug, vehicle = {}) {
  const { items } = await listBookingPackages(vehicle);
  return items.find(p => p.id === slug) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Make / model catalog, grouped the way the booking form's dropdowns want it.
// ─────────────────────────────────────────────────────────────────────────────
async function listVehicleOptions(typeClass) {
  const { rows } = await pool.query(
    `SELECT mk.id   AS make_id,   mk.name AS make_name,
            vt.name AS type_name,
            mo.id   AS model_id,  mo.name AS model_name
       FROM vehicle_makes mk
       JOIN vehicle_types vt ON vt.id = mk.vehicle_type_id AND vt.is_active = TRUE
       LEFT JOIN vehicle_models mo ON mo.make_id = mk.id AND mo.is_active = TRUE
      WHERE mk.is_active = TRUE
      ORDER BY mk.name ASC, mo.name ASC`
  );

  const byMake = new Map();
  for (const r of rows) {
    if (!byMake.has(r.make_id)) {
      byMake.set(r.make_id, {
        id: r.make_id,
        name: r.make_name,
        type_class: classifyTypeName(r.type_name),
        type_name: r.type_name,
        models: [],
      });
    }
    if (r.model_id) byMake.get(r.make_id).models.push({ id: r.model_id, name: r.model_name });
  }

  let makes = [...byMake.values()];
  if (typeClass === '2W' || typeClass === '4W') {
    makes = makes.filter(m => m.type_class === typeClass);
  }
  return { makes };
}

/** Fuel options for the vehicle step — the CRM's `segments` master data. */
async function listFuelOptions() {
  const { rows } = await pool.query(
    `SELECT id, name FROM segments WHERE is_active = TRUE ORDER BY name ASC`
  );
  return { fuels: rows };
}

module.exports = {
  classifyTypeName,
  resolveVehicleTypeId,
  resolveVehicleContext,
  resolvePrice,
  listBookingPackages,
  getBookingPackage,
  listVehicleOptions,
  listFuelOptions,
};
