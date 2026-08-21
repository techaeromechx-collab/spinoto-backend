'use strict';

/**
 * A lead status is master data. Its NAME is not a key.
 *
 * ── THE SHAPE OF EVERY BUG THIS GUARDS ──────────────────────────────────────
 *
 * leads.status stores the status NAME as text — migration 013 turned the enum
 * into VARCHAR(100) — and an admin renames statuses on a settings screen. So
 * every `status === 'Appointment Scheduled'` in this codebase is a rule that
 * works until somebody edits master data, and then stops working with no error,
 * no log and nothing on screen to say so.
 *
 * It is not hypothetical. Six of these were found already broken, and had been
 * since the day they shipped:
 *
 *   ['won', 'converted', 'closed won']
 *
 * Not one of those three has ever been a status in this system. The "Lead
 * Converted 🎉" alert had never fired. Three Smart Alerts thought they were
 * excluding finished leads and were excluding nothing. The team's "converted
 * leads" KPI read zero for every user, forever. All of it looked like working
 * code.
 *
 * The flags are the fix, because they live on the ROW: is_closed,
 * converts_to_appointment, is_locked. Rename the status to anything, in any
 * language, and the tick travels with it.
 *
 * ── AND THE TWO PLACES A RENAME STILL HAS TO CASCADE ────────────────────────
 *
 * Some things genuinely must store the name — a WhatsApp automation matching on
 * it, a follow-up captioned with it. Those are cascaded on rename, and the
 * cascade is asserted here because a missing one is silent: the automation
 * stays switched ON and simply never fires again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SRC = {
  statuses: strip(read(path.join(BE, 'src/controllers/lead_statuses.controller.js'))),
  leads:    strip(read(path.join(BE, 'src/controllers/leads.controller.js'))),
  appts:    strip(read(path.join(BE, 'src/controllers/appointments.controller.js'))),
  alerts:   strip(read(path.join(BE, 'src/services/smartAlerts.service.js'))),
  me:       strip(read(path.join(BE, 'src/routes/me.routes.js'))),
  page:     strip(read(path.join(FE, 'src/pages/LeadsPage.jsx'))),
};

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — The dead literals are gone, everywhere
// ═══════════════════════════════════════════════════════════════════════════

for (const [where, src] of Object.entries(SRC)) {
  for (const dead of ["'won'", "'converted'", "'closed won'"]) {
    assert.ok(!src.includes(dead),
      `${where} still tests for the status name ${dead} — no such status has ever existed `
      + 'in this system, so whatever that code is for has never once run'); n++;
  }
}

// And each site now asks the status table instead.
assert.match(SRC.leads, /converts_to_appointment/,
  'the conversion alert no longer identifies a converted lead at all'); n++;
// The paren matters: the import at the top of the file is a third occurrence
// of the bare name, and counting that made this assertion off by one in the
// direction that hides a missing call site.
assert.strictEqual((SRC.leads.match(/fireLeadConversionAlert\(/g) || []).length, 2,
  'the conversion alert fires from one path only — the single-lead update and the bulk '
  + 'status change must both raise it, or a bulk win goes unannounced'); n++;

// Three Smart Alerts excluded finished leads. All three must now do it by flag.
const alertGuards = (SRC.alerts.match(/is_closed OR ls\.converts_to_appointment/g) || []).length;
assert.strictEqual(alertGuards, 3,
  `${alertGuards} of the 3 Smart Alert queries exclude finished leads by flag — the rest are `
  + 'chasing leads that are already won or already lost'); n++;

assert.match(SRC.me, /ls\.converts_to_appointment/,
  "the team's converted-leads KPI is not counted from the flag; it reads zero for everyone"); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — The Leads page reads flags, not names
// ═══════════════════════════════════════════════════════════════════════════

for (const name of ["'Appointment Scheduled'", "'Appointment Completed'"]) {
  assert.ok(!SRC.page.includes(name),
    `LeadsPage still hard-codes ${name}. Renaming that status makes every converted lead's `
    + 'follow-up glow red for a chase nobody owes'); n++;
}
assert.match(SRC.page, /evStatusObj\?\.converts_to_appointment/,
  'the follow-up lock no longer recognises a converted lead'); n++;
assert.match(SRC.page, /evStatusObj\?\.is_closed/,
  'the follow-up lock no longer recognises a closed lead'); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — Renaming a status carries everything that stores its name
// ═══════════════════════════════════════════════════════════════════════════

const iUp = SRC.statuses.indexOf('function updateStatus(');
assert.ok(iUp > -1, 'updateStatus is gone'); n++;
const upFn = SRC.statuses.slice(iUp, SRC.statuses.indexOf('\nfunction ', iUp + 10));

// The four things that store a status name. A missing one is silent in a
// different way each time, which is why they are listed rather than summarised.
const CASCADES = [
  [/UPDATE leads SET status/,           'the leads themselves — they would keep a name nothing recognises'],
  [/UPDATE lead_activities SET new_value/, 'the timeline, which would split one status into two in every report'],
  [/UPDATE lead_activities SET old_value/, 'the other side of the timeline'],
  [/UPDATE lead_events SET status_name/,   'follow-up captions, left naming a status that no longer exists'],
  [/UPDATE wa_automations SET match_value/,
    'WhatsApp automations — they stay switched ON, raise nothing, and never fire again'],
];
for (const [re, why] of CASCADES) {
  assert.match(upFn, re, `the rename does not carry ${why}`); n++;
}

/* The automation cascade MUST be scoped to lead events.
   wa_automations.match_value holds an appointment status SLUG for
   appointment.* rules. An unscoped rewrite of a lead status called 'confirmed'
   would repoint every appointment automation at nothing — the same silent
   failure, inflicted on a different feature. */
const iRules = upFn.indexOf('UPDATE wa_automations');
const rulesStmt = upFn.slice(iRules, iRules + 260);
assert.match(rulesStmt, /event LIKE 'lead\.%'/,
  'the automation rename is not scoped to lead events; renaming a lead status would '
  + 'repoint appointment automations too'); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — Deleting a status is refused while anything depends on it
// ═══════════════════════════════════════════════════════════════════════════

const iDel = SRC.statuses.indexOf('function deleteStatus(');
assert.ok(iDel > -1, 'deleteStatus is gone'); n++;
const delFn = SRC.statuses.slice(iDel, SRC.statuses.indexOf('\nfunction ', iDel + 10));

assert.match(delFn, /FROM leads WHERE status/,
  'a status can be deleted while leads are on it'); n++;
assert.match(delFn, /is_default/,
  'the default status can be deleted, leaving nothing to fall back to'); n++;
// \b, not a bare prefix: 'FROM wa_automationsX' satisfies a loose match, which
// is how a check that had been deleted outright still read as present.
assert.match(delFn, /FROM wa_automations\b/,
  'a status can be deleted out from under a live WhatsApp automation — the rule stays '
  + 'listed and active, pointed at a name that exists nowhere'); n++;

// Refused, not cascaded. There is no correct destination to move a rule to;
// only a person knows which status that message should follow now.
const iAuto = delFn.indexOf('FROM wa_automations');
assert.match(delFn.slice(iAuto, iAuto + 700), /res\.status\(409\)/,
  'the automation check does not refuse the delete'); n++;
// And it names them. "3 automations use it" sends somebody hunting.
assert.match(delFn.slice(iAuto, iAuto + 700), /template_key/,
  'the refusal does not name which automations, so the admin has to go and find them'); n++;
/* template_key, and the column matters.
   This first read `t.name`, which wa_templates does not have — it holds
   template_key and provider_template_name. A static test cannot know that: the
   assertion passed happily on a query that would have thrown "column t.name
   does not exist" the first time somebody tried to delete a status. It was
   caught by running the SQL against a real Postgres, which is the only thing
   that can catch it. This assertion pins the correct column so the wrong one
   cannot come back. */
assert.ok(!/t\.name\b/.test(delFn),
  'the automation lookup selects t.name — wa_templates has no such column and the '
  + 'delete would throw'); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 5 — Deleting an appointment puts the lead back where it WAS
// ═══════════════════════════════════════════════════════════════════════════

const iApptDel = SRC.appts.indexOf('DELETE FROM appointments             WHERE id = $1');
assert.ok(iApptDel > -1, 'the appointment delete is gone'); n++;
const unconvert = SRC.appts.slice(iApptDel, iApptDel + 2600);

/* Two tiers, and the ORDER is the whole point.
   Converting the lead wrote a status_changed row whose old_value is the status
   it held the moment before. That is a fact the timeline is already holding,
   and a fixed fallback bucket throws it away. */
const iTrail = unconvert.search(/FROM lead_activities\b/);
const iDefault = unconvert.indexOf('is_default = TRUE');
assert.ok(iTrail > -1,
  'the lead is dropped into a generic bucket rather than returned to the status it was '
  + 'actually on — the timeline records that and nothing reads it'); n++;
/* And the trail must be a query that actually RUNS.
   Stubbing `const back = { rows: [] }` leaves every string this test looks for
   sitting in the file, in a statement nothing executes — which is exactly the
   shape a hurried "temporarily disable this" leaves behind. */
assert.match(unconvert, /const back = await client\.query\(/,
  'the previous-status lookup is not executed; the fallback bucket wins every time'); n++;
assert.ok(iDefault > -1, 'there is no fallback when the trail cannot answer'); n++;
assert.ok(iTrail < iDefault,
  'the default is consulted BEFORE the trail, so the recorded previous status never wins'); n++;

// The recovered name is checked against lead_statuses. An old_value naming a
// status somebody deleted last month would put the lead somewhere no filter,
// colour or board column recognises — worse than the generic bucket.
assert.match(unconvert.slice(iTrail - 200, iDefault), /JOIN lead_statuses/,
  'the recovered status name is used without checking it still exists'); n++;

// It must find the transition INTO the converting status, not any earlier one.
assert.match(unconvert.slice(iTrail, iDefault), /converts_to_appointment/,
  'the trail lookup does not identify which transition was the conversion'); n++;
// Newest first: a lead converted twice returns to where the LAST conversion
// found it, not the first.
assert.match(unconvert.slice(iTrail, iDefault), /ORDER BY la\.created_at DESC/,
  'the trail is not read newest-first, so a twice-converted lead returns to where it was '
  + 'years ago rather than last week'); n++;

console.log(`statusflags: ${n} checks passed`);
