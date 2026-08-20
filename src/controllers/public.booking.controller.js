'use strict';

/**
 * PUBLIC booking API — the surface booking.spinoto.com talks to.
 *
 * ⚠ EVERY ROUTE HERE IS UNAUTHENTICATED. Anyone on the internet can call it.
 *   The rules that follow are not style preferences, they are the reason this
 *   file is safe to expose:
 *
 *   1. The price is ALWAYS resolved server-side from `package_id`. A client
 *      -sent amount is read for logging and nothing else.
 *   2. Only the PUBLIC Razorpay key_id ever reaches the browser. The secret
 *      stays in the environment and is used solely to sign/verify.
 *   3. verify-payment checks the HMAC-SHA256 signature BEFORE anything is
 *      created. No signature, no appointment.
 *   4. The booking_token (JWT, scope 'booking') is what proves a mobile was
 *      OTP-verified. create-order takes the mobile from the TOKEN, never from
 *      the request body, so a caller cannot book against someone else's number.
 *   5. Rate limiting is applied at the route layer (public.booking.routes.js).
 *
 * Contract: booking/src/api/bookingApi.js + booking/API_CONTRACT.md.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../config/db');
const {
  listBookingPackages, getBookingPackage,
  listVehicleOptions, listFuelOptions,
} = require('../services/bookingCatalog.service');
const { createBookingAppointment } = require('../services/bookingAppointment.service');
// Order creation and signature verification used to live inline in this file.
// They moved to services/gateway/ when invoice payments were added, so there is
// ONE implementation of each rather than two that drift apart — a timing fix
// applied to one copy of a signature check and not the other is exactly the
// kind of bug that survives review. Behaviour here is unchanged: the same mock
// order ids, the same key_id the booking SPA already recognises, the same HMAC.
const { getGateway } = require('../services/gateway');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const OTP_TTL_MIN = Number(process.env.BOOKING_OTP_TTL_MIN || 10);
const OTP_MAX_ATTEMPTS = Number(process.env.BOOKING_OTP_MAX_ATTEMPTS || 5);
const OTP_FIXED = process.env.BOOKING_OTP_FIXED || '1234';
const SMS_WEBHOOK_URL = process.env.SMS_WEBHOOK_URL || '';
const TOKEN_TTL = process.env.BOOKING_TOKEN_TTL || '30m';

// Razorpay credentials are no longer read here. They are read in exactly one
// place — services/gateway/razorpay.adapter.js — which is what keeps the secret
// out of every other file's reach. `RZP_LIVE` became gateway.isConfigured().

// Comma-separated pincode PREFIXES, e.g. "38,39". Empty ⇒ serviceable
// everywhere (the hubs table carries no geography, so there is nothing else
// to gate on — see the note on check-location below).
const SERVICE_PINCODES = (process.env.BOOKING_SERVICE_PINCODES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const MOBILE_RE = /^[6-9]\d{9}$/;

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw Object.assign(new Error('JWT_SECRET is not configured'), { status: 503 });
  return s;
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Express handler wrapper: async errors → next(), status-carrying errors honoured. */
function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        });
      }
      if (err?.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /services — the three packages, priced for this vehicle
// ─────────────────────────────────────────────────────────────────────────────
const vehicleQuerySchema = z.object({
  vehicle_type: z.enum(['2W', '4W']).optional(),
  make_id: z.coerce.number().int().positive().optional(),
  model_id: z.coerce.number().int().positive().optional(),
  fuel: z.string().trim().max(30).optional(),
}).partial();

const getServices = handler(async (req, res) => {
  const q = vehicleQuerySchema.parse(req.query || {});
  const { items } = await listBookingPackages(q);
  // vehicle_context is intentionally NOT returned — internal ids are of no use
  // to the page and leaking the shape of the pricing key set helps nobody.
  res.json({ items });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. GET /vehicle-options — CRM make/model catalog
// ─────────────────────────────────────────────────────────────────────────────
const getVehicleOptions = handler(async (req, res) => {
  const typeClass = req.query?.vehicle_type;
  const [{ makes }, { fuels }] = await Promise.all([
    listVehicleOptions(typeClass === '2W' || typeClass === '4W' ? typeClass : null),
    listFuelOptions(),
  ]);
  // Cache at the edge: this changes when an admin edits master data, which is
  // rare. Short enough that a correction is live within the hour.
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ makes, fuels });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /send-otp
// ─────────────────────────────────────────────────────────────────────────────
function hashOtp(mobile, code) {
  return crypto
    .createHmac('sha256', jwtSecret())          // JWT_SECRET doubles as the pepper
    .update(`${mobile}:${code}`)
    .digest('hex');
}

async function deliverOtp(mobile, code) {
  if (!SMS_WEBHOOK_URL) return false;
  // Generic outbound webhook so any SMS vendor can be plugged in without a
  // code change. Failures are swallowed — a dead vendor must not 500 the page.
  try {
    const r = await fetch(SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobile,
        message: `${code} is your Spinoto verification code. Valid for ${OTP_TTL_MIN} minutes.`,
        template: 'booking_otp',
      }),
    });
    return r.ok;
  } catch (err) {
    console.error('[booking] OTP delivery failed:', err.message);
    return false;
  }
}

const sendOtp = handler(async (req, res) => {
  const { mobile } = z.object({
    mobile: z.string().trim().regex(MOBILE_RE, 'Enter a valid 10-digit mobile number'),
  }).parse(req.body || {});

  const live = Boolean(SMS_WEBHOOK_URL);

  // ── The fixed code must never be reachable on a live server ──────────────
  //
  // Without SMS_WEBHOOK_URL there is no way to deliver a real code, so this
  // endpoint used to fall back to BOOKING_OTP_FIXED — '1234' by default — and
  // say so in a console.warn. A warning is not a control. It scrolls past on
  // boot, and the observable behaviour is a public booking site where anyone
  // can verify anybody's mobile number: enter a number, type 1234, and you are
  // through as them.
  //
  // So in production this now FAILS CLOSED. Nobody can book until SMS is
  // configured, which is the correct trade: a booking form that is temporarily
  // out of order is a bad afternoon, and an OTP that is always '1234' is a
  // security hole with no expiry.
  //
  // The escape hatch is deliberate and deliberately awkward to type. Someone
  // demoing on a production build can set BOOKING_OTP_ALLOW_FIXED=true and
  // will be reminded on every request that they have done so.
  if (!live && process.env.NODE_ENV === 'production') {
    if (process.env.BOOKING_OTP_ALLOW_FIXED !== 'true') {
      console.error(
        '[booking] SMS_WEBHOOK_URL is unset in production — refusing to send a ' +
        'fixed OTP. Set SMS_WEBHOOK_URL, or BOOKING_OTP_ALLOW_FIXED=true if you ' +
        'genuinely intend every code to be BOOKING_OTP_FIXED.'
      );
      return res.status(503).json({
        error: 'OTP delivery is not configured. Please contact us to book.',
      });
    }
    console.warn(
      '[booking] ⚠ BOOKING_OTP_ALLOW_FIXED=true in production — every OTP is ' +
      'the fixed code BOOKING_OTP_FIXED. Anyone can verify any mobile number.'
    );
  }

  const code = live
    ? String(crypto.randomInt(1000, 10000))
    : OTP_FIXED;

  await pool.query(
    `INSERT INTO booking_otps (mobile, code_hash, expires_at, attempts, sent_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, 0, NOW())
     ON CONFLICT (mobile) DO UPDATE
       SET code_hash  = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts   = 0,
           sent_at    = NOW()`,
    [mobile, hashOtp(mobile, code), String(OTP_TTL_MIN)]
  );

  const delivered = live ? await deliverOtp(mobile, code) : false;

  res.json({
    ok: true,
    // dev_mode tells the SPA it may show the "use 1234" hint. It never carries
    // the code itself — a real code must only ever travel over SMS.
    ...(live ? {} : { dev_mode: true }),
    ...(live && !delivered ? { warning: 'SMS delivery is delayed. Please retry in a moment.' } : {}),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /verify-otp → booking_token
// ─────────────────────────────────────────────────────────────────────────────
const verifyOtp = handler(async (req, res) => {
  const { mobile, otp } = z.object({
    mobile: z.string().trim().regex(MOBILE_RE, 'Enter a valid 10-digit mobile number'),
    otp: z.string().trim().regex(/^\d{4,6}$/, 'Enter the code we sent you'),
  }).parse(req.body || {});

  const r = await pool.query(
    `SELECT code_hash, attempts, expires_at FROM booking_otps WHERE mobile = $1`, [mobile]);
  const row = r.rows[0];
  if (!row) throw fail(400, 'Please request a new code.');
  if (new Date(row.expires_at) < new Date()) {
    await pool.query(`DELETE FROM booking_otps WHERE mobile = $1`, [mobile]);
    throw fail(400, 'That code has expired. Please request a new one.');
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    throw fail(429, 'Too many incorrect attempts. Please request a new code.');
  }

  const expected = Buffer.from(row.code_hash, 'utf8');
  const actual = Buffer.from(hashOtp(mobile, otp), 'utf8');
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!ok) {
    await pool.query(`UPDATE booking_otps SET attempts = attempts + 1 WHERE mobile = $1`, [mobile]);
    throw fail(400, 'Incorrect code. Please try again.');
  }

  // Single-use: burn the challenge the moment it succeeds.
  await pool.query(`DELETE FROM booking_otps WHERE mobile = $1`, [mobile]);

  const booking_token = jwt.sign(
    { scope: 'booking', mobile },
    jwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
  res.json({ ok: true, booking_token });
});

/** Throws 401 unless the token is a valid, unexpired booking-scope token. */
function requireBookingToken(token) {
  if (!token) throw fail(401, 'Please verify your mobile number again.');
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret());
  } catch {
    throw fail(401, 'Your session expired. Please verify your mobile number again.');
  }
  if (claims.scope !== 'booking' || !claims.mobile) {
    throw fail(401, 'Please verify your mobile number again.');
  }
  return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. GET /check-location
//
// NOTE ON SCOPE: the `hubs` table carries no latitude/longitude/radius (see
// migrations 016–084 — none add geography), so the radius check described in
// API_CONTRACT.md cannot be run yet. Until hubs gain coordinates this gates on
// a pincode prefix list and returns hub_id: null; the appointment is created
// with no hub and its notes say "assign a hub manually". That is a deliberate,
// visible gap rather than a silent wrong answer.
// ─────────────────────────────────────────────────────────────────────────────
const checkLocation = handler(async (req, res) => {
  const { pincode } = z.object({
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
    pincode: z.string().trim().max(10).optional(),
    vehicle_type: z.enum(['2W', '4W']).optional(),
  }).partial().parse(req.query || {});

  // No list configured ⇒ serviceable everywhere. Ops turns the gate on by
  // setting BOOKING_SERVICE_PINCODES; nobody is locked out by default.
  if (!SERVICE_PINCODES.length) {
    return res.json({ serviceable: true, hub_id: null, hub_name: null, distance_km: null });
  }
  if (!pincode) {
    // GPS-only visitor and we have no geocoder — let them through rather than
    // turning away a customer we probably do serve.
    return res.json({ serviceable: true, hub_id: null, hub_name: null, distance_km: null });
  }

  const serviceable = SERVICE_PINCODES.some(p => pincode.startsWith(p));
  res.json(serviceable
    ? { serviceable: true, hub_id: null, hub_name: null, distance_km: null }
    : { serviceable: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2c. POST /notify-request — "tell me when you cover my area"
// ─────────────────────────────────────────────────────────────────────────────
const notifyRequest = handler(async (req, res) => {
  const body = z.object({
    booking_token: z.string().trim().min(1),
    lat: z.coerce.number().optional().nullable(),
    lng: z.coerce.number().optional().nullable(),
    pincode: z.string().trim().max(10).optional().nullable(),
    vehicle_type: z.enum(['2W', '4W']).optional().nullable(),
    utm: z.record(z.string(), z.any()).optional().nullable(),
  }).parse(req.body || {});

  const { mobile } = requireBookingToken(body.booking_token);

  await pool.query(
    `INSERT INTO booking_waitlist (mobile, lat, lng, pincode, vehicle_type, utm)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [mobile, body.lat ?? null, body.lng ?? null, body.pincode || null,
     body.vehicle_type || null, JSON.stringify(body.utm || {})]
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /create-order
// ─────────────────────────────────────────────────────────────────────────────
const createOrderSchema = z.object({
  booking_token: z.string().trim().min(1),
  customer: z.object({
    name: z.string().trim().min(1).max(160),
    mobile: z.string().trim().max(20).optional().nullable(),   // ignored — token wins
    email: z.string().trim().max(200).optional().nullable(),
    address: z.string().trim().max(2000).optional().nullable(),
    pincode: z.string().trim().max(10).optional().nullable(),
  }),
  location: z.object({
    lat: z.coerce.number().optional().nullable(),
    lng: z.coerce.number().optional().nullable(),
  }).optional().default({}),
  hub_id: z.any().optional().nullable(),                       // ignored — never trusted
  vehicle: z.object({
    registration_no: z.string().trim().max(30).optional().nullable(),
    type: z.enum(['2W', '4W']).optional().nullable(),
    make_id: z.coerce.number().int().positive().optional().nullable(),
    make: z.string().trim().max(100).optional().nullable(),
    model_id: z.coerce.number().int().positive().optional().nullable(),
    model: z.string().trim().max(100).optional().nullable(),
    fuel: z.string().trim().max(30).optional().nullable(),
  }).optional().default({}),
  schedule: z.object({
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
    time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  }),
  package_id: z.string().trim().min(1).max(40),
  utm: z.record(z.string(), z.any()).optional().nullable(),
}).passthrough();

/**
 * Creates a real gateway order, or a mock one when keys are not configured.
 *
 * Now a thin call into the shared adapter. Two contract details the booking SPA
 * depends on are preserved by the adapter and must stay that way:
 *   - mock order ids are `order_mock_<receipt>`
 *   - the mock key_id is `rzp_test_mock`, which the SPA matches on to run its
 *     simulated checkout
 *
 * The adapter takes RUPEES, not paise — the conversion (and its rounding, which
 * matters to the last paisa) lives on the far side of the boundary now.
 */
async function openGatewayOrder({ amountRupees, receipt, notes }) {
  return getGateway().createOrder({ amount: amountRupees, receipt, notes });
}

const createOrder = handler(async (req, res) => {
  const body = createOrderSchema.parse(req.body || {});
  const { mobile } = requireBookingToken(body.booking_token);

  // ── Price SERVER-SIDE from package_id. Any client amount is ignored. ──────
  const pkg = await getBookingPackage(body.package_id, {
    vehicle_type: body.vehicle.type || undefined,
    make_id: body.vehicle.make_id || undefined,
    model_id: body.vehicle.model_id || undefined,
    fuel: body.vehicle.fuel || undefined,
  });
  if (!pkg) throw fail(400, 'That package is no longer available. Please pick another.');
  if (!(pkg.price > 0)) throw fail(409, 'This package is not priced yet. Please call us to book.');

  const amountPaise = Math.round(pkg.price * 100);
  const orderRef = `bk_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  // Snapshot everything the appointment will need. verify-payment reads ONLY
  // from here, so nothing between checkout and confirmation is client-supplied.
  const payload = {
    order_id: orderRef,
    customer: {
      name: body.customer.name,
      mobile,                                   // from the verified token
      email: body.customer.email || null,
      address: body.customer.address || null,
      pincode: body.customer.pincode || null,
    },
    vehicle: {
      registration_no: body.vehicle.registration_no || null,
      type: body.vehicle.type || null,
      make: body.vehicle.make || null,
      model: body.vehicle.model || null,
      fuel: body.vehicle.fuel || null,
      make_id: body.vehicle.make_id || null,
      model_id: body.vehicle.model_id || null,
    },
    booking: { date: body.schedule.date, time: body.schedule.time || null },
    hub: {},                                    // no geography on hubs yet
    location: { lat: body.location.lat ?? null, lng: body.location.lng ?? null },
    services: [{ service_id: pkg.service_id, name: pkg.name, price: pkg.price }],
    utm: body.utm || null,
    source: 'booking.spinoto.com',
  };

  const rzp = await openGatewayOrder({
    amountRupees: pkg.price,
    receipt: orderRef,
    notes: { package: pkg.id, mobile },
  });

  await pool.query(
    `INSERT INTO booking_orders
       (order_ref, mobile, package_slug, amount, currency, payload, razorpay_order_id, status)
     VALUES ($1,$2,$3,$4,'INR',$5,$6,'created')`,
    [orderRef, mobile, pkg.id, pkg.price, JSON.stringify(payload), rzp.id]
  );

  res.json({
    razorpay_order_id: rzp.id,
    key_id: rzp.key_id,          // PUBLIC key only
    amount: amountPaise,
    currency: 'INR',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /verify-payment → the appointment
// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 over "order_id|payment_id", compared in constant time. The
// implementation moved to services/gateway/razorpay.adapter.js; the rule it
// enforces is unchanged and is the reason this public endpoint is safe — no
// signature, no appointment, whatever the browser claims happened.
function signatureValid(orderId, paymentId, signature) {
  return getGateway().verifyPaymentSignature({ orderId, paymentId, signature });
}

const verifyPayment = handler(async (req, res) => {
  const body = z.object({
    razorpay_order_id: z.string().trim().min(1).max(100),
    razorpay_payment_id: z.string().trim().min(1).max(100),
    razorpay_signature: z.string().trim().max(200).optional().nullable(),
  }).parse(req.body || {});

  const r = await pool.query(
    `SELECT * FROM booking_orders WHERE razorpay_order_id = $1`, [body.razorpay_order_id]);
  const order = r.rows[0];
  if (!order) throw fail(404, 'We could not find that order. Please contact support.');

  // Already done → replay the same answer. Safe to retry on a timeout.
  if (order.status === 'synced' && order.appointment_id) {
    const a = await pool.query(
      `SELECT appointment_code FROM appointments WHERE id = $1`, [order.appointment_id]);
    return res.json({
      ok: true, replay: true,
      appointment_id: order.appointment_id,
      appointment_code: a.rows[0]?.appointment_code || null,
    });
  }

  if (!signatureValid(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
    await pool.query(
      `UPDATE booking_orders SET status='failed', error_text=$2 WHERE id=$1`,
      [order.id, 'Signature verification failed']);
    console.error('[booking] signature mismatch on order', body.razorpay_order_id);
    throw fail(400, 'We could not verify that payment. Please contact support.');
  }

  await pool.query(
    `UPDATE booking_orders
        SET status='paid', razorpay_payment_id=$2
      WHERE id=$1`,
    [order.id, body.razorpay_payment_id]);

  // The payload was frozen at create-order — the client cannot influence what
  // gets written here.
  const payload = {
    ...order.payload,
    payment: {
      razorpay_order_id: body.razorpay_order_id,
      razorpay_payment_id: body.razorpay_payment_id,
      amount: Number(order.amount),
    },
  };

  let result;
  try {
    result = await createBookingAppointment(payload);
  } catch (err) {
    await pool.query(
      `UPDATE booking_orders SET status='failed', error_text=$2 WHERE id=$1`,
      [order.id, String(err.message || err).slice(0, 2000)]);
    // The money IS taken — never tell the customer the booking failed outright.
    console.error('[booking] appointment creation failed for', order.order_ref, err);
    throw fail(500, 'Your payment went through but we could not confirm the slot. '
      + 'Our team will call you shortly — reference ' + order.order_ref);
  }

  await pool.query(
    `UPDATE booking_orders SET status='synced', appointment_id=$2, error_text=NULL WHERE id=$1`,
    [order.id, result.appointment_id]);

  res.json({
    ok: true,
    appointment_id: result.appointment_id,
    appointment_code: result.appointment_code,
    order_ref: order.order_ref,
  });
});

module.exports = {
  getServices,
  getVehicleOptions,
  sendOtp,
  verifyOtp,
  checkLocation,
  notifyRequest,
  createOrder,
  verifyPayment,
};
