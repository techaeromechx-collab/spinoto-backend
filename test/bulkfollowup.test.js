'use strict';

/**
 * One follow-up for a whole selection.
 *
 * A lead status can be flagged needs_follow_up in Settings. Setting it on ONE
 * lead asks when to chase; setting it on fifty used to ask nothing and — worse
 * — closed whatever follow-ups those leads already had. The flag was honoured
 * exactly where it mattered least.
 *
 * ── THE FOUR WAYS THIS GOES WRONG SILENTLY ──────────────────────────────────
 *
 *   1. ORDER. The endpoint closes open follow-ups on every status change. Write
 *      the new row before that close and it is marked done in the same
 *      transaction — the request succeeds, the toast says "follow-up set", and
 *      nothing appears in the Today tab. Nobody would suspect the insert.
 *
 *   2. THE 'Z'. `new Date('2026-08-25T09:00:00Z')` is 2:30pm IST. Every morning
 *      follow-up files itself in the afternoon and half of them read as late.
 *      One character, and the only symptom is a time that looks nearly right.
 *
 *   3. WHICH LEADS. A lead skipped as locked or already-converted keeps its old
 *      status. Giving it a follow-up for a status it is not in is a reminder
 *      about something that never happened.
 *
 *   4. VOLUME. The single-lead path notifies creator, assignee and actor. Doing
 *      that per lead is 150 notifications and 150 pushes for one click, which
 *      is how people learn to switch notifications off.
 *
 * And the deliberate omission: bulk must NOT collect a call outcome. One
 * outcome cannot describe twenty conversations.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — The endpoint
// ═══════════════════════════════════════════════════════════════════════════

const ctrl = strip(read(path.join(BE, 'src/controllers/leads.controller.js')));

const iFn = ctrl.indexOf('function bulkStatus(');
assert.ok(iFn > -1, 'bulkStatus is gone'); n++;
// Bounded at the next top-level function so nothing below can satisfy these.
const after = ctrl.slice(iFn + 10);
const iEnd  = after.search(/\n(async )?function \w+\(/);
const fn    = ctrl.slice(iFn, iEnd > -1 ? iFn + 10 + iEnd : ctrl.length);

// ── It accepts the follow-up at all ────────────────────────────────────────
for (const field of ['follow_up_date', 'follow_up_time', 'follow_up_note']) {
  assert.ok(fn.includes(field), `bulkStatus does not accept ${field}`); n++;
}

// The date is validated by SHAPE. Date() would swallow '2026' as 1 January and
// file every follow-up eight months early.
assert.match(fn, /follow_up_date:[\s\S]{0,200}?\\d\{4\}-\\d\{2\}-\\d\{2\}/,
  'follow_up_date is not checked against YYYY-MM-DD; a partial date would be accepted '
  + 'and silently mean something else'); n++;

// ── It writes rows, not just closes them ───────────────────────────────────
assert.match(fn, /INSERT INTO lead_events/,
  'bulkStatus never creates a follow-up — the flag is still ignored in bulk'); n++;

const iClose  = fn.search(/UPDATE lead_events SET is_done = TRUE/);
const iInsert = fn.indexOf('INSERT INTO lead_events');
assert.ok(iClose > -1, 'bulkStatus no longer closes the old follow-ups'); n++;
assert.ok(iClose < iInsert,
  'the new follow-up is written BEFORE the blanket close — it is marked done the moment '
  + 'it is created, and the only symptom is an empty Today tab'); n++;

// ── Local time, not UTC ────────────────────────────────────────────────────
const iDue = fn.indexOf('new Date(`${follow_up_date}');
assert.ok(iDue > -1, 'due_at is not built from the date and time'); n++;
const dueExpr = fn.slice(iDue, fn.indexOf(')', iDue) + 1);
assert.ok(!/Z`/.test(dueExpr) && !/Z'/.test(dueExpr),
  `due_at is built as UTC: ${dueExpr} — 09:00 would file at 2:30pm IST and read as late`); n++;
assert.match(fn, /isNaN\(dueAt\)/,
  'an unparseable date is passed to the insert; due_at would be null or throw mid-transaction'); n++;

// ── Only the leads that moved ──────────────────────────────────────────────
//
// `ids` is the changed set; `lead_ids` is what the client asked for. Inserting
// against lead_ids would give a locked lead a follow-up for a status it is not
// in.
const insertStmt = fn.slice(iInsert - 400, iInsert + 400);
assert.ok(/\bids\b/.test(insertStmt),
  'the follow-up insert does not use the changed-id list'); n++;
assert.ok(!/\blead_ids\b/.test(insertStmt),
  'the follow-up is written against the REQUESTED ids — a lead skipped as locked or already '
  + 'converted would get a follow-up for a status it never entered'); n++;

// ── One notification each, not one per lead ────────────────────────────────
const iNotify = fn.indexOf('follow_up_scheduled');
assert.ok(iNotify > -1, 'nobody is told the follow-ups exist'); n++;
const notifyBlock = fn.slice(fn.lastIndexOf('if (followUpCount)', iNotify), iNotify + 900);

assert.match(notifyBlock, /perUser/,
  'the notification is not grouped per person; this is the 150-pushes-per-click shape'); n++;

/* The loop ENCLOSING the insert must iterate people, not leads.
   Asserted on the text immediately before the INSERT rather than on the block
   as a whole: perUser is built by a loop over `changeable`, so "does this
   block mention changeable" is true either way, and a per-lead insert sitting
   below a correctly-built map passes that check while sending a hundred and
   fifty notifications. */
const iNotifIns = fn.indexOf('INSERT INTO notifications');
assert.ok(iNotifIns > -1, 'no notification is written at all'); n++;
const enclosing = fn.slice(Math.max(0, iNotifIns - 400), iNotifIns);
assert.match(enclosing, /for \(const \[uid, count\] of perUser\)/,
  'the notification insert is not inside the per-person loop'); n++;
assert.ok(!/of changeable\)/.test(enclosing),
  'a notification is inserted per LEAD — fifty leads means up to a hundred and fifty'); n++;

// After the commit. A push service must never be able to hold a transaction
// open, and a failed notification must not roll back committed statuses.
const iCommit = fn.indexOf("await client.query('COMMIT')");
assert.ok(iCommit > -1 && iCommit < fn.indexOf('INSERT INTO notifications'),
  'notifications are written inside the transaction'); n++;
assert.match(notifyBlock, /isNotificationEnabled\(pool/,
  'the preference check uses the transaction client after it has been released'); n++;
/* A real try/CATCH around the announcing, not merely the letters 'catch'
   somewhere nearby — `.catch(() => {})` on an unrelated call a few lines down
   satisfies the loose version, which is how this assertion first passed on a
   `finally` that swallowed nothing. */
const iLoop = fn.indexOf('for (const [uid, count] of perUser)');
const loopBody = fn.slice(iLoop, fn.indexOf('\n      }', iLoop));
assert.match(loopBody, /\}\s*catch\s*\(/,
  'a failed notification throws after the statuses are committed — the caller would be told '
  + 'the whole thing failed when all of it succeeded'); n++;
assert.ok(!/\}\s*finally\s*\{/.test(loopBody),
  'the notification error is caught by a finally, which re-throws'); n++;

// ── It reports what it did ─────────────────────────────────────────────────
/* Asserted on the SUCCESS response specifically.
   There are two res.json calls in here — the early return for "nothing moved"
   also carries follow_ups: 0, and a file-wide match is satisfied by that one
   while the real response has been renamed. Which is exactly what happened the
   first time this was written.

   \b matters too: '_' is a word character, so a renamed `_follow_ups:` does
   not satisfy a bounded match the way a bare substring would. */
const iRes = fn.lastIndexOf('res.json({');
assert.ok(iRes > -1, 'bulkStatus returns nothing'); n++;
const resBlock = fn.slice(iRes, fn.indexOf('});', iRes) + 3);
assert.match(resBlock, /\bfollow_ups:\s*followUpCount/,
  'the response does not report how many follow-ups were actually written, so the toast '
  + 'can only repeat back what was asked for'); n++;
assert.match(resBlock, /\bfollow_up_date:/,
  'the response does not say WHEN, so the toast cannot repeat the date back'); n++;

// ── And it does NOT take a call log ────────────────────────────────────────
for (const field of ['call_outcome', 'call_notes']) {
  assert.ok(!fn.includes(field),
    `bulkStatus accepts ${field} — one outcome cannot describe twenty conversations`); n++;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — The bulk bar
// ═══════════════════════════════════════════════════════════════════════════

const page = strip(read(path.join(FE, 'src/pages/LeadsPage.jsx')));

// The interception is on the FLAG, not on a status name. Matching names is how
// a rename in Settings silently switches a feature off.
assert.match(page, /if \(s\.needs_follow_up\)/,
  'the bulk menu does not ask for a follow-up when the status needs one'); n++;
assert.match(page, /setBulkFollow\(\{ statusName: s\.name \}\)/,
  'the follow-up modal is never opened from the bulk menu'); n++;

// It sends what it collected.
const iApply = page.indexOf('async function applyBulkStatus(');
const applyFn = page.slice(iApply, page.indexOf('\n  }', iApply));
for (const field of ['follow_up_date', 'follow_up_time']) {
  assert.ok(applyFn.includes(field), `applyBulkStatus does not send ${field}`); n++;
}
// StatusActionModal returns `note`; the API wants `follow_up_note`. The rename
// is the kind of thing that works in testing because the note is optional and
// nobody notices it never arrives.
assert.match(applyFn, /follow_up_note = followUp\.note|follow_up_note.*followUp\.note/,
  "the modal's `note` is not mapped to the API's `follow_up_note`; notes would vanish"); n++;

// The call half of the shared modal is switched off for bulk.
const iModal = page.indexOf('{bulkFollow && (');
assert.ok(iModal > -1, 'the bulk follow-up modal is not rendered'); n++;
const modalBlock = page.slice(iModal, iModal + 700);
assert.match(modalBlock, /logsCall=\{false\}/,
  'the bulk follow-up modal asks for a call outcome as well'); n++;
assert.match(modalBlock, /needsFollowUp/,
  'the bulk modal does not ask for the follow-up it exists to collect'); n++;

// The toast reports the SERVER's count, not the size of the selection.
assert.match(page, /r\.follow_ups/,
  'the toast does not read the follow-up count from the response — it would claim a number '
  + 'for leads the server skipped'); n++;

console.log(`bulkfollowup: ${n} checks passed`);
