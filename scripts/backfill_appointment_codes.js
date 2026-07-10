'use strict';
// One-off backfill for migration 084 (human-readable appointment_code).
//
// Run backfill_hub_codes.js FIRST — this script needs every hub to already
// have a hub_code.
//
// Generates appointment_code for every existing appointment that has a hub
// but no code yet, processed per hub in original creation-date order. Uses
// the exact same generateAppointmentCode()/nextSequence() the live app uses,
// so:
//   - codes reflect the month the appointment was actually created in
//     (not today's date)
//   - the hub_appointment_sequences counter table ends up correctly seeded,
//     so the next NEW appointment created after this backfill continues the
//     sequence properly instead of restarting at 00001
//
// Appointments with no hub_id are skipped entirely (no code is possible —
// matches the live behavior: a code only exists once a hub is assigned).
//
// Run once, after backfill_hub_codes.js:
//   node backend/scripts/backfill_appointment_codes.js
//
// Safe to re-run — appointments that already have an appointment_code are
// skipped, and hub_appointment_sequences only advances for the ones that
// still need a code.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const { generateAppointmentCode } = require('../src/utils/appointmentCode');

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows: appts } = await client.query(
      `SELECT a.id, a.hub_id, a.created_at, h.hub_code
       FROM appointments a
       JOIN hubs h ON h.id = a.hub_id
       WHERE a.hub_id IS NOT NULL AND a.appointment_code IS NULL
       ORDER BY a.hub_id ASC, a.created_at ASC`
    );
    console.log(`[backfill] ${appts.length} appointment(s) need a code.`);

    let done = 0, skippedNoHubCode = 0;
    for (const appt of appts) {
      if (!appt.hub_code) {
        console.warn(`[backfill]  SKIP appointment #${appt.id} — hub #${appt.hub_id} has no hub_code yet. Run backfill_hub_codes.js first.`);
        skippedNoHubCode++;
        continue;
      }
      const code = await generateAppointmentCode(client, {
        hubId: appt.hub_id,
        hubCode: appt.hub_code,
        atDate: appt.created_at,
      });
      await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [code, appt.id]);
      done++;
    }

    console.log(`[backfill] Done — ${done} appointment(s) assigned a code${skippedNoHubCode ? `, ${skippedNoHubCode} skipped (missing hub_code)` : ''}.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
