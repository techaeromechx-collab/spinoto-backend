'use strict';

/**
 * Register a vehicle against a customer, from a record that mentions one.
 *
 * ── WHY THIS IS A SHARED HELPER AND NOT THREE COPIES ────────────────────────
 *
 * Four places create a record carrying a vehicle: the appointment controller,
 * the public booking service, warranty claims, and standalone estimates. The
 * estimate one has written customer_vehicles since migration 082; the other
 * three never did, which is the whole bug this fixes.
 *
 * Adding the same twenty lines to three more files would have produced four
 * copies of one rule, and the rule is exactly the kind that rots when
 * duplicated: normalise the plate the same way EVERY time, or the unique
 * constraint stops catching duplicates and one car quietly becomes two rows.
 *
 * ── THE NORMALISATION IS THE LOAD-BEARING PART ──────────────────────────────
 *
 * trim + uppercase. Nothing more, ever.
 *
 * That is what addCustomerVehicle does, so it is what everything else must do.
 * It is tempting to also strip spaces — 'GJ 01 AB 1234' and 'GJ01AB1234' are
 * the same car to a human, and the system does treat them as different plates
 * on write. That is a real pre-existing wrinkle and it is NOT fixed here:
 * stripping spaces in this one helper while addCustomerVehicle keeps them
 * would make the two disagree about what a duplicate is, which is worse than
 * the wrinkle. (Reads already cope — the customer lookup strips punctuation
 * when matching. Only writes are strict.)
 *
 * ── WHY ON CONFLICT DO NOTHING, AND NOT DO UPDATE ───────────────────────────
 *
 * A customer_vehicles row can carry colour, year and notes. An appointment
 * form never asks for any of them. DO UPDATE would overwrite that detail with
 * nulls every time a job was booked for a car already on file — silently
 * destroying data on the happy path, which is the worst place to put it.
 *
 * So the rule is: this helper CREATES a vehicle that was not known before, and
 * never edits one that was. Editing is the Customer page's job.
 *
 * ── FAILURE IS NOT FATAL, AND A try/catch ALONE WOULD NOT ACHIEVE THAT ──────
 *
 * Registering the vehicle is a convenience. The appointment is what the
 * customer is waiting for, and it must not be lost because a lookup table
 * disagreed about something.
 *
 * But callers pass their OPEN TRANSACTION, and a failed statement inside a
 * transaction aborts the whole thing — every subsequent query returns
 * "current transaction is aborted, commands ignored until end of transaction
 * block". So catching the error changes nothing: the appointment INSERT is
 * already doomed, and the caller's own error handling then reports a failure
 * it did not cause.
 *
 * Hence the SAVEPOINT. It marks a point the transaction can be rewound to,
 * so a failure here undoes only this statement and the caller carries on with
 * a working transaction. This is the difference between "we tried and it did
 * not matter" and "we tried and it cost the customer their booking".
 */

/**
 * @param client   an open pg client, inside the caller's transaction
 * @param mobile   the customer's number, as stored on the parent record
 * @param v        anything carrying vehicle_number / vehicle_type_id /
 *                 make_id / model_id / segment_ids
 * @returns {Promise<boolean>} true when a row was created
 */
async function upsertCustomerVehicle(client, mobile, v) {
  const raw = v && v.vehicle_number;
  if (!mobile || !raw) return false;

  const plate = String(raw).trim().toUpperCase();
  if (!plate) return false;

  // segment_ids is an array on appointments and estimates, a scalar nowhere.
  // customer_vehicles holds a single segment_id, so the first is taken — the
  // same choice the Customer page's own display makes, (a.segment_ids)[1].
  const segment = Array.isArray(v.segment_ids) ? (v.segment_ids[0] ?? null)
                : (v.segment_id ?? null);

  await client.query('SAVEPOINT reg_vehicle');
  try {
    const r = await client.query(
      `INSERT INTO customer_vehicles
         (mobile, vehicle_number, vehicle_type_id, make_id, model_id, segment_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mobile, vehicle_number) DO NOTHING
       RETURNING id`,
      [
        mobile,
        plate,
        v.vehicle_type_id || null,
        v.make_id         || null,
        v.model_id        || null,
        segment,
      ]
    );
    await client.query('RELEASE SAVEPOINT reg_vehicle');
    return r.rowCount > 0;
  } catch (err) {
    // Rewind to before the INSERT, leaving the caller's transaction usable.
    // Logged, never silent: a helper that fails invisibly is one nobody
    // discovers has stopped working.
    await client.query('ROLLBACK TO SAVEPOINT reg_vehicle').catch(() => {});
    console.error('[customerVehicle] could not register', plate, 'for', mobile, '—', err.message);
    return false;
  }
}

module.exports = { upsertCustomerVehicle };
