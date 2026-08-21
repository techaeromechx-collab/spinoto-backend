'use strict';

/**
 * Setting a lead to Lost no longer stops to ask why.
 *
 * ── WHAT THIS IS PROTECTING ─────────────────────────────────────────────────
 *
 * Lost can be set from THREE places — the edit form's status select, the
 * inline dropdown on a list row, and the bulk bar. Each one had its own copy
 * of the same interception, which is why removing it is worth a test: putting
 * one of them back is a two-line change that looks local and makes "Lost" mean
 * something different depending on which control you used. That divergence is
 * invisible until somebody notices half their Lost leads have reasons.
 *
 * ── AND WHAT MUST NOT HAVE GONE WITH IT ─────────────────────────────────────
 *
 * The COLUMN stays. Reasons recorded before this change still render under the
 * lead name and in the timeline, and a lead that already carries one keeps it
 * when it is edited. Dropping the display along with the prompt would quietly
 * erase history that is still perfectly true — so the read paths are asserted
 * as hard as the removal is.
 *
 * The other interceptions stay too. converts_to_appointment and
 * logs_call/needs_follow_up are unrelated rules that happened to sit in the
 * same if/else chain, and the cheapest way to break them is to delete one
 * branch too many.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const page = read(path.join(FE, 'src/pages/LeadsPage.jsx'));
const code = strip(page);

// ── The prompt is gone from all three places ───────────────────────────────
//
// Asserted on the CODE with comments stripped: the file explains at length why
// the modal was removed, and a check against the raw text would pass on the
// explanation while the modal itself was back.
for (const gone of ['LostReasonModal', 'LOST_REASONS', 'lostModal', 'setLostModal', 'bulkLost']) {
  assert.ok(!new RegExp(`\\b${gone}\\b`).test(code),
    `${gone} is back — one of the three status controls stops to ask for a reason again, `
    + 'and Lost now means two different things depending on where it is set'); n++;
}

// The specific shape of the interception, in case it returns under a new name:
// a branch that tests the status NAME for 'lost' and opens something.
const lostBranches = [...code.matchAll(/\.toLowerCase\(\)\.includes\('lost'\)/g)];
for (const m of lostBranches) {
  const after = code.slice(m.index, m.index + 260);
  assert.ok(!/setLost|Modal\(|setOpen\(false\)/.test(after),
    `a 'lost' name check still opens a modal:\n${after.slice(0, 160)}`); n++;
}

// ── Bulk applies straight from the menu ────────────────────────────────────
//
// Not asserted as an exact one-liner any more: the menu legitimately gained a
// needs_follow_up branch, and pinning the handler's shape would mean this test
// fails every time that click grows a rule. What must stay true is narrower —
// the handler applies the status itself, and nothing in it looks at the status
// NAME for 'lost'.
const iMenu = code.indexOf('bulkStatusOptions.map(');
assert.ok(iMenu > -1, 'the bulk status menu is gone'); n++;
const menuBlock = code.slice(iMenu, iMenu + 900);
assert.match(menuBlock, /applyBulkStatus\(s\.name\)/,
  'the bulk status menu no longer applies the status'); n++;
assert.ok(!/lost/i.test(menuBlock),
  `the bulk menu checks the status name for 'lost' again:\n${menuBlock.slice(0, 200)}`); n++;

// applyBulkStatus takes a follow-up and nothing else. A lost_reason parameter
// creeping back is how the prompt gets reintroduced "so we can use it".
const iBulk = code.indexOf('async function applyBulkStatus(');
assert.ok(iBulk > -1, 'applyBulkStatus is gone'); n++;
const bulkSig = code.slice(iBulk, code.indexOf(')', iBulk) + 1);
assert.ok(!/lost/i.test(bulkSig),
  `applyBulkStatus takes a lost reason again: ${bulkSig}`); n++;
const bulkFn = code.slice(iBulk, code.indexOf('\n  }', iBulk));
assert.ok(!/lost_reason/.test(bulkFn),
  'the bulk request sends a lost_reason it has no way to have collected'); n++;

// ── The unrelated interceptions survived the deletion ──────────────────────
//
// Both appear once per status control. Counting rather than merely finding
// one: deleting the Lost branch from all three and one of these from one of
// them is precisely the slip this guards.
assert.strictEqual((code.match(/converts_to_appointment/g) || []).length >= 3, true,
  'a converts_to_appointment check was deleted along with the Lost branch — '
  + 'that status would now save without ever opening the appointment form'); n++;
assert.strictEqual((code.match(/needs_follow_up/g) || []).length >= 4, true,
  'a logs_call / needs_follow_up check was deleted along with the Lost branch'); n++;

// ── The column and its display are untouched ───────────────────────────────
assert.match(code, /lead\.lost_reason/,
  'the view modal no longer shows a recorded reason; history recorded before '
  + 'this change has been made invisible'); n++;
// Both list layouts — the table row and the card — render it, and both are
// guarded the same way. Counting the GUARD, not the field: the field name also
// appears inside each block, so a looser count stays satisfied when one of the
// two blocks is switched off.
assert.strictEqual((code.match(/\{l\.lost_reason && /g) || []).length, 2,
  'one of the two list layouts stopped showing a recorded reason'); n++;
assert.match(code, /lost_reason: lead\.lost_reason/,
  'the edit form no longer loads an existing reason, so re-saving a Lost lead wipes it'); n++;

// The server contract is deliberately NOT changed: the endpoint still accepts
// a reason, the column still exists. Removing them would make this a migration
// instead of a UI change, and would throw away the reasons already recorded.
const ctrl = strip(read(path.join(BE, 'src/controllers/leads.controller.js')));

// Bounded to each handler. updateLead and bulkStatus declare it separately, so
// a file-wide match is satisfied by whichever one still has it — and the one
// that matters here is bulkStatus, the endpoint this change is about.
for (const fn of ['function updateLead(', 'function bulkStatus(']) {
  const i = ctrl.indexOf(fn);
  assert.ok(i > -1, `${fn} is gone`); n++;
  const body = ctrl.slice(i, i + 1400);
  assert.match(body, /lost_reason:\s*z\.string\(\)/,
    `${fn} no longer accepts lost_reason; a lead that already has one would be `
    + 'blanked the next time it is saved'); n++;
}

console.log(`lostreason: ${n} checks passed`);
