'use strict';
// Follow-on fix for the hub_code parenthesis bug (see fix_broken_hub_codes.js).
// hubs.hub_code has already been corrected (e.g. "TM(" -> "TMS"), but
// appointment_code is frozen forever once generated, so appointments created
// while a hub's code was still broken are still carrying the old broken
// prefix — e.g. "TM(_APT_07-26_00001" instead of "TMS_APT_0726_001".
//
// This joins each appointment to its hub, compares the code's prefix against
// the hub's CURRENT hub_code, and rebuilds any mismatch: same sequence
// number, corrected prefix, new string format — in one step. Codes whose
// prefix already matches the hub's current code are left untouched, so this
// is safe to re-run and also doubles as a final format sweep (handles old
// dash-format and new no-dash-format alike).
//
//   node backend/scripts/fix_broken_appointment_codes.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');
const { buildAppointmentCode } = require('../src/utils/appointmentCode');

const OLD_SHAPE = /^(.+?)_APT_(\d{2})-(\d{2})_(\d+)$/;   // HUB_APT_MM-YY_NNNNN
const NEW_SHAPE = /^(.+?)_APT_(\d{2})(\d{2})_(\d+)$/;    // HUB_APT_MMYY_NNN

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT a.id, a.appointment_code, h.hub_code AS current_hub_code
       FROM appointments a
       JOIN hubs h ON h.id = a.hub_id
       WHERE a.appointment_code IS NOT NULL AND h.hub_code IS NOT NULL`
    );

    let fixed = 0, skipped = 0;
    for (const appt of rows) {
      const m = appt.appointment_code.match(OLD_SHAPE) || appt.appointment_code.match(NEW_SHAPE);
      if (!m) {
        console.log(`[fix]  #${appt.id}: "${appt.appointment_code}" — unrecognized shape, leaving alone`);
        skipped++;
        continue;
      }

      const [, prefix, mm, yy, seqStr] = m;
      if (prefix === appt.current_hub_code) { skipped++; continue; } // prefix already correct

      const year  = 2000 + parseInt(yy, 10);
      const month = parseInt(mm, 10);
      const seq   = parseInt(seqStr, 10);
      const newCode = buildAppointmentCode(appt.current_hub_code, year, month, seq);

      await client.query(`UPDATE appointments SET appointment_code = $1 WHERE id = $2`, [newCode, appt.id]);
      console.log(`[fix]  #${appt.id}: ${appt.appointment_code} -> ${newCode}`);
      fixed++;
    }

    console.log(`[fix] Done — ${fixed} fixed, ${skipped} left alone (prefix already correct, or unrecognized).`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[fix] Fatal:', err.message);
  process.exit(1);
});
