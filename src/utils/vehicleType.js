'use strict';

/**
 * Work out a vehicle's TYPE when nobody chose one.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The lead form offers make and model without forcing a type. A lead saved that
 * way passes the blank to its appointment, the appointment to the customer
 * invoice, and the Hub Revenue report ends up with a job it cannot bucket —
 * "Not set", ₹4,949, on a Maruti Ertiga. It was found as a reporting bug and it
 * was never a reporting bug; the type was missing three tables upstream.
 *
 * ── Why a make is enough to answer it ────────────────────────────────────────
 * vehicle_makes.vehicle_type_id is set for every make in the system. A make is
 * itself a statement about the type: Maruti Suzuki builds 4W, Hero builds 2W.
 * So a row that knows its make already knows its type — nothing here is a
 * guess, it is a join that was never made.
 *
 * ── Why it belongs in a util rather than in one controller ───────────────────
 * services/bookingAppointment.service.js has done exactly this since public
 * bookings were built, which is precisely why bookings never had the problem
 * and CRM-entered leads did. Putting it here means the lead form, the
 * appointment form, the API and any importer added later all get the same
 * answer instead of three controllers each remembering separately.
 *
 * ── What it will NOT do ──────────────────────────────────────────────────────
 * It never overrides a type somebody chose. It never invents one when there is
 * no make or model to derive from — a blank stays a blank, because a wrong type
 * is worse than an absent one: it silently moves revenue into the wrong bucket
 * where nobody will ever question it.
 */

/**
 * @param {object} db      pool or an in-transaction client
 * @param {object} v       { vehicle_type_id, make_id, model_id } — any may be absent
 * @returns {Promise<number|null>} the type to store
 */
async function resolveVehicleTypeId(db, v = {}) {
  // Already decided. Return it untouched — including the case where the caller
  // deliberately passed a type that disagrees with the make, which is theirs
  // to make and not ours to correct.
  if (v.vehicle_type_id) return Number(v.vehicle_type_id) || null;

  // The model first: it names a make, and the make names the type. Asking via
  // the model also covers a payload that carries a model and no make, which
  // the 2W path in the lead form produces (models are searchable there before
  // a make is picked).
  if (v.model_id) {
    const r = await db.query(
      `SELECT mk.vehicle_type_id
         FROM vehicle_models mo
         JOIN vehicle_makes  mk ON mk.id = mo.make_id
        WHERE mo.id = $1`,
      [v.model_id]
    );
    if (r.rows[0]?.vehicle_type_id) return r.rows[0].vehicle_type_id;
  }

  if (v.make_id) {
    const r = await db.query(
      `SELECT vehicle_type_id FROM vehicle_makes WHERE id = $1`,
      [v.make_id]
    );
    if (r.rows[0]?.vehicle_type_id) return r.rows[0].vehicle_type_id;
  }

  return null;
}

module.exports = { resolveVehicleTypeId };
