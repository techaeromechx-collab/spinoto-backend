'use strict';

// Job card code format: {hub_code}_JC_{MMYY}_{001}
//   e.g. QAH_JC_0926_001
//
// Deliberately the same shape as the appointment code (utils/appointmentCode.js)
// rather than a second convention. A job card number sits beside an appointment
// code on the same screen and on the same printed sheet; two different formats
// there is a cost paid every single time somebody reads one.
//
// The trailing number resets to 1 at the start of every calendar month and is
// tracked independently per hub (hub_job_card_sequences, migration 189) — two
// hubs never share or interfere with each other's numbering.
//
// Generated once, when the card is opened, and FROZEN. If the appointment is
// later moved to a different hub the code is not regenerated: it keeps
// reflecting the hub the vehicle was actually worked on at. job_cards.hub_id is
// denormalised for exactly this reason.
//
// "Which month" is read in IST, the same fixed +5:30 offset appointmentCode.js
// and payoutSchedule.js use, so calendar-month logic is consistent across the
// app regardless of what timezone the server process happens to run in.

const { istYearMonth } = require('./appointmentCode');

// Atomically claims the next sequence number for (hubId, year, month) and
// returns it. Upsert-and-increment rather than read-then-write, so two job
// cards opened at the same instant for the same hub never get the same number.
async function nextSequence(client, hubId, year, month) {
  const r = await client.query(
    `INSERT INTO hub_job_card_sequences (hub_id, year, month, last_seq, updated_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (hub_id, year, month)
     DO UPDATE SET last_seq = hub_job_card_sequences.last_seq + 1, updated_at = NOW()
     RETURNING last_seq`,
    [hubId, year, month]
  );
  return r.rows[0].last_seq;
}

// Formats the final code string from its parts.
function buildJobCardCode(hubCode, year, month, seq) {
  const mm  = String(month).padStart(2, '0');
  const yy  = String(year).slice(-2);
  const num = String(seq).padStart(3, '0'); // rolls to 4+ digits gracefully past 999
  return `${hubCode}_JC_${mm}${yy}_${num}`;
}

// Claims the next sequence for this hub/month and returns the formatted code in
// one step. Takes a CLIENT, not the pool: the caller is inside the transaction
// that also inserts the card, so a rolled-back card does not burn a number.
async function generateJobCardCode(client, { hubId, hubCode, atDate } = {}) {
  const { year, month } = istYearMonth(atDate);
  const seq = await nextSequence(client, hubId, year, month);
  return buildJobCardCode(hubCode, year, month, seq);
}

module.exports = { nextSequence, buildJobCardCode, generateJobCardCode };
