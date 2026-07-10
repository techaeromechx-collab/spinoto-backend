'use strict';

// Appointment code format: {hub_code}_APT_{MM}-{YY}_{00001}
//   e.g. QAH_APT_07-26_00001
//
// The trailing number resets to 1 at the start of every calendar month, and
// is tracked independently per hub (hub_appointment_sequences table) — two
// hubs never share or interfere with each other's numbering.
//
// Generated once, when a hub is first assigned to an appointment (normally
// at creation). Frozen after that: if the appointment is later reassigned to
// a different hub, its code is NOT regenerated — it keeps reflecting the hub
// it was originally booked under.
//
// "Which month" is always read in IST — same fixed +5:30 offset approach as
// payoutSchedule.js, so calendar-day/month logic is consistent across the
// app regardless of what timezone the server process happens to run in.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istYearMonth(date) {
  const d = new Date(new Date(date || new Date()).getTime() + IST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// Atomically claims the next sequence number for (hubId, year, month) and
// returns it. Uses an upsert-and-increment rather than read-then-write, so
// two appointments created at the same instant for the same hub never get
// the same number.
async function nextSequence(client, hubId, year, month) {
  const r = await client.query(
    `INSERT INTO hub_appointment_sequences (hub_id, year, month, last_seq, updated_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (hub_id, year, month)
     DO UPDATE SET last_seq = hub_appointment_sequences.last_seq + 1, updated_at = NOW()
     RETURNING last_seq`,
    [hubId, year, month]
  );
  return r.rows[0].last_seq;
}

// Formats the final code string from its parts.
function buildAppointmentCode(hubCode, year, month, seq) {
  const mm  = String(month).padStart(2, '0');
  const yy  = String(year).slice(-2);
  const num = String(seq).padStart(5, '0');
  return `${hubCode}_APT_${mm}-${yy}_${num}`;
}

// Claims the next sequence number for this hub/month and returns the full
// formatted code in one step. `atDate` defaults to now; pass an explicit
// date when backfilling historical appointments so the code reflects the
// month the appointment actually happened in, not today.
async function generateAppointmentCode(client, { hubId, hubCode, atDate } = {}) {
  const { year, month } = istYearMonth(atDate);
  const seq = await nextSequence(client, hubId, year, month);
  return buildAppointmentCode(hubCode, year, month, seq);
}

module.exports = { istYearMonth, nextSequence, buildAppointmentCode, generateAppointmentCode };
