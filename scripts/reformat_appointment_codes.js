'use strict';
// One-off reformat: appointment_code values generated before the format
// changed from {HUBID}_APT_{MM}-{YY}_{00001} to {HUBID}_APT_{MMYY}_{001}
// need to be rewritten to the new string shape.
//
// Important: this does NOT reassign sequence numbers or touch
// hub_appointment_sequences. Each appointment keeps the exact sequence
// number it already had — e.g. QAH_APT_07-26_00008 (the 8th QAH appointment
// in July 2026) becomes QAH_APT_0726_008, still "the 8th". Only the string
// rendering changes, so hub_appointment_sequences (which tracks counts, not
// display strings) stays untouched and future new appointments keep
// numbering correctly from wherever they already were.
//
// Only touches codes matching the OLD pattern. Anything already in the new
// format, or not matching either shape, is left alone — safe to re-run.
//
//   node backend/scripts/reformat_appointment_codes.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const { buildAppointmentCode } = require('../src/utils/appointmentCode');

const OLD_FORMAT = /^([A-Z0-9]+)_APT_(\d{2})-(\d{2})_(\d+)$/;

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, appointment_code FROM appointments WHERE appointment_code IS NOT NULL`
    );

    let updated = 0, skipped = 0;
    for (const appt of rows) {
      const m = appt.appointment_code.match(OLD_FORMAT);
      if (!m) { skipped++; continue; }

      const [, hubCode, mm, yy, seqStr] = m;
      const year  = 2000 + parseInt(yy, 10);
      const month = parseInt(mm, 10);
      const seq   = parseInt(seqStr, 10);

      const newCode = buildAppointmentCode(hubCode, year, month, seq);
      await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [newCode, appt.id]);
      console.log(`[reformat]  #${appt.id}: ${appt.appointment_code} -> ${newCode}`);
      updated++;
    }

    console.log(`[reformat] Done — ${updated} reformatted, ${skipped} left alone (already new-format or unrecognized).`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[reformat] Fatal:', err.message);
  process.exit(1);
});
