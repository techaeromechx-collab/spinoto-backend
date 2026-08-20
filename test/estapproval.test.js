/**
 * Per-item customer approval.
 *
 * The rule this exists to hold: the staff screen and the customer's link must
 * produce IDENTICAL database state for identical input. Before this change the
 * public endpoint wrote a word into estimates.status that the CHECK constraint
 * does not allow (a 500) and never touched estimate_items at all (so nothing
 * reached the workshop). Both failures came from having two models; the tests
 * below mostly check there is now one.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const svc     = fs.readFileSync(`${BE}/src/services/estimateApproval.service.js`, 'utf8');
const staff   = fs.readFileSync(`${BE}/src/controllers/estimates.controller.js`, 'utf8');
const pub     = fs.readFileSync(`${BE}/src/controllers/public.estimate.controller.js`, 'utf8');
const page    = fs.readFileSync(`${FE}/pages/PublicEstimatePage.jsx`, 'utf8');
const mig052  = fs.readFileSync(`${BE}/db/migrations/052_estimates.sql`, 'utf8');

const { deriveStatus, ESTIMATE_STATUSES } = require(`${BE}/src/services/estimateApproval.service.js`);

// ── The derivation, exercised directly ─────────────────────────────────────
const D = (cur, a, r, total) => deriveStatus(cur, { total, approved_count: a, rejected_count: r });

assert.strictEqual(D('sent_to_customer', 4, 0, 4), 'fully_approved'); n++;
assert.strictEqual(D('sent_to_customer', 2, 2, 4), 'partially_approved'); n++;
assert.strictEqual(D('sent_to_customer', 1, 0, 4), 'partially_approved', 'one approved is still partial'); n++;
assert.strictEqual(D('sent_to_customer', 0, 4, 4), 'revision_requested', 'all refused reopens for revision'); n++;
assert.strictEqual(D('sent_to_customer', 0, 0, 4), 'sent_to_customer', 'nothing decided = still waiting'); n++;
assert.strictEqual(D('sent_to_customer', 0, 2, 4), 'sent_to_customer', 'none approved, some pending = still waiting'); n++;
// Work already under way is terminal — a recount must not pull a job out of the
// workshop's queue mid-fit.
assert.strictEqual(D('work_in_progress', 0, 4, 4), 'work_in_progress'); n++;
assert.strictEqual(D('work_completed',   0, 4, 4), 'work_completed'); n++;
// An estimate with no items must not claim to be fully approved.
assert.strictEqual(D('sent_to_customer', 0, 0, 0), 'sent_to_customer', 'zero items is not "fully approved"'); n++;

// EVERY value it can produce must be one the column can hold. This is the check
// that would have caught the 500: the old code wrote 'approved', which is not a
// status this system has.
const produced = new Set();
for (const cur of ESTIMATE_STATUSES) {
  for (const [a, r, t] of [[0,0,0],[0,0,4],[4,0,4],[2,2,4],[0,4,4],[1,0,4],[0,2,4]]) {
    produced.add(D(cur, a, r, t));
  }
}
for (const st of produced) {
  assert.ok(ESTIMATE_STATUSES.includes(st), `deriveStatus can produce '${st}', which is not a legal status`); n++;
  assert.ok(mig052.includes(`'${st}'`), `'${st}' is not in the CHECK constraint in migration 052`); n++;
}
// And the allow-list here matches the constraint, in both directions.
for (const st of ESTIMATE_STATUSES) {
  assert.ok(mig052.includes(`'${st}'`), `${st} is listed in the service but not in the CHECK constraint`); n++;
}
assert.ok(!ESTIMATE_STATUSES.includes('approved'), "'approved' is back in the allow-list — that is the 500"); n++;
assert.ok(!ESTIMATE_STATUSES.includes('rejected'), "'rejected' is not a status this system has"); n++;

// ── One implementation, two callers ────────────────────────────────────────
const staffCode = strip(staff);
const pubCode   = strip(pub);
for (const [name, code] of [['staff', staffCode], ['public', pubCode]]) {
  assert.ok(/applyItemApprovals\(client,/.test(code), `the ${name} path does not use the shared service`); n++;
}
// Scoped to the two APPROVAL handlers.
//
// Other paths legitimately write estimates.status — submitEstimate sets
// 'pending_company_review', companyApprove sets 'sent_to_customer',
// updateItemWorkStatus sets the work states. Those are different transitions,
// not approval derivations, and banning the whole file would have demanded
// deleting working code that has nothing to do with this change.
function bodyOf(src, fnName) {
  const at = src.indexOf(`function ${fnName}(`);
  assert.ok(at > 0, `${fnName} not found`);
  // Up to the next top-level `function ` declaration.
  const rest = src.slice(at + 10);
  const end = rest.search(/\nfunction \w+\(/);
  return end === -1 ? rest : rest.slice(0, end);
}
const staffApproval = bodyOf(staffCode, 'customerApproval');
const pubDecide     = bodyOf(pubCode, 'decidePublicEstimate');

for (const [name, body] of [['staff customerApproval', staffApproval], ['public decide', pubDecide]]) {
  assert.ok(!/UPDATE estimates SET status|UPDATE estimates\s+SET status = \$1/.test(body),
    `${name} writes estimates.status directly — the approval status must be derived`); n++;
  assert.ok(!/newStatus\s*=/.test(body), `${name} still contains its own status derivation`); n++;
  // NOT "must not mention a status" — the staff handler legitimately lists
  // ['sent_to_customer','partially_approved',…] as the states in which an
  // approval may be RECORDED. That is an entry guard, not a derivation, and
  // banning the words would have meant deleting a correct check.
  //
  // What must be gone is the derivation itself: the counts query it fed on.
  assert.ok(!/COUNT\(\*\) FILTER \(WHERE customer_approved/.test(body),
    `${name} still counts item approvals itself — that belongs to the service`); n++;
  assert.ok(!/UPDATE estimate_items[\s\S]{0,80}customer_approved = \$1/.test(body),
    `${name} still writes item approvals itself`); n++;
  assert.ok(/applyItemApprovals\(client,/.test(body), `${name} does not call the shared service`); n++;
}
// The service is the only place the approval derivation lives.
assert.ok(/'fully_approved'/.test(svc) && /'partially_approved'/.test(svc) && /'revision_requested'/.test(svc),
  'the service does not contain the derivation'); n++;

// ── The item UPDATE is scoped ──────────────────────────────────────────────
// On a public endpoint the item ids arrive from an unauthenticated caller.
// Without the estimate_id scope a forwarded link approves other people's lines.
assert.ok(/WHERE id = \$2 AND estimate_id = \$3/.test(svc),
  'the item UPDATE is not scoped to the estimate'); n++;
assert.ok(/work_status = 'pending'[\s\S]{0,120}customer_approved = TRUE/.test(svc),
  'approved items are not returned to the work queue'); n++;

// ── The public endpoint's three guards ─────────────────────────────────────
assert.ok(/approvals: z\.array/.test(pub), 'the public endpoint still takes a single decision'); n++;
assert.ok(!/decision: z\.enum\(\['approved', 'rejected'\]\)/.test(pub),
  "the old whole-estimate schema survived — that is the value that 500'd"); n++;
// Foreign ids refused, not skipped.
assert.ok(/const foreign = \[\.\.\.sentIds\]\.filter/.test(pub),
  'a foreign item id is not detected'); n++;
assert.ok(/reason: 'items_changed'/.test(pub), 'a changed estimate is not reported distinctly'); n++;
// Partial payloads refused — a missing item stays NULL and reads as unanswered.
assert.ok(/sentIds\.size !== liveIds\.size/.test(pub), 'a partial payload is accepted'); n++;
assert.ok(/reason: 'incomplete'/.test(pub), 'an incomplete payload is not reported distinctly'); n++;
// Both checks run BEFORE anything is written.
//
// Compared against the CALL SITE, not `applyItemApprovals` anywhere — the
// import sits at the top of the file and would satisfy the comparison no matter
// where the guards actually were. Matching an import instead of a use is how a
// source-order assertion passes while testing nothing.
const callSite = pub.indexOf('applyItemApprovals(client,');
assert.ok(callSite > 0, 'the service is never called'); n++;
assert.ok(pub.indexOf("reason: 'items_changed'") < callSite,
  'the foreign-id check runs after items are written'); n++;
assert.ok(pub.indexOf("reason: 'incomplete'") < callSite,
  'the completeness check runs after items are written'); n++;

// ── One transaction, and the one-way claim inside it ───────────────────────
const decideBody = pub.slice(pub.indexOf('async function decidePublicEstimate'));
assert.ok(/await client\.query\('BEGIN'\)/.test(decideBody), 'the decision is not transactional'); n++;
assert.ok(/AND status = 'sent_to_customer'\s*\n\s*AND decision_source IS NULL/.test(decideBody),
  'the one-way guard is not in the SQL — two taps could both win'); n++;
// The claim must come before the item writes, so a loser writes nothing.
assert.ok(decideBody.indexOf("decision_source = 'customer_link'") < decideBody.indexOf('applyItemApprovals(client,'),
  'items are written before the estimate is claimed — a losing racer would write them anyway'); n++;
assert.ok(/ROLLBACK/.test(decideBody), 'a failure part-way is not rolled back'); n++;

// ── Full rejection cancels the appointment ─────────────────────────────────
assert.ok(/result\.allRejected/.test(pub), 'full rejection is not detected'); n++;
assert.ok(/advanceAppointmentStatus\(row\.appointment_id, 'cancelled'\)/.test(pub),
  'the appointment is not cancelled when everything is refused'); n++;
// 'cancelled' must be a SYSTEM status or advanceAppointmentStatus refuses it.
const mig061 = fs.readFileSync(`${BE}/db/migrations/061_new_appointment_statuses.sql`, 'utf8');
assert.ok(/\('Cancelled',\s*'cancelled',[^)]*TRUE/.test(mig061),
  "'cancelled' is not a system appointment status — advanceAppointmentStatus would skip it"); n++;
// After the commit, and non-throwing: the decision is already recorded.
assert.ok(pub.indexOf("await client.query('COMMIT')") < pub.indexOf("'cancelled'"),
  'the appointment is cancelled inside the decision transaction'); n++;
assert.ok(/advanceAppointmentStatus\([^)]*\)\.catch\(/.test(pub),
  'a failed cancellation would turn a successful decision into an error'); n++;
// appointment_id must be selected, and must NOT be returned to the browser.
assert.ok(/e\.appointment_id,/.test(pub), 'appointment_id is not selected'); n++;
const resBody = pub.slice(pub.indexOf('estimate: {'), pub.indexOf('items: await publicItems'));
assert.ok(!/appointment_id/.test(resBody), 'appointment_id is returned to the browser'); n++;

// ── The public projection stays narrow ─────────────────────────────────────
const itemsRaw = pub.slice(pub.indexOf('async function publicItems'),
                           pub.indexOf('async function publicItems') + 900);
assert.ok(/ei\.customer_approved/.test(itemsRaw), 'the page cannot see which items are decided'); n++;
// SQL comments stripped: the query explains in prose exactly which columns it
// deliberately excludes, and matching that prose is the opposite of a finding.
const itemsSel = itemsRaw.replace(/--.*$/gm, '');
for (const leak of ['hub_rate', 'commission', 'cost', 'margin', 'total_payable']) {
  assert.ok(!new RegExp(leak, 'i').test(itemsSel), `the public item select exposes '${leak}'`); n++;
}
// Prove the scan can fire — otherwise it passes because the slice is empty.
assert.ok(/SELECT/.test(itemsSel) && /estimate_items/.test(itemsSel),
  'the item-select slice did not capture the query'); n++;

// ── The page ───────────────────────────────────────────────────────────────
assert.ok(/const \[picked, setPicked\]/.test(page), 'there is no per-item selection state'); n++;
// Pre-ticked, but honouring an item already refused.
assert.ok(/it\.customer_approved === false \? false : true/.test(page),
  'items are not pre-ticked, or an already-refused item is silently re-ticked'); n++;
// Every line is submitted, every time.
assert.ok(/approvals: \(data\.items \|\| \)?\[?\]?\)?\.map|approvals: \(data\.items \|\| \[\]\)\.map/.test(page),
  'the page does not submit every item'); n++;
assert.ok(!/decision: intent, last4/.test(page), 'the page still posts a whole-estimate decision'); n++;
// The amount is on the buttons that commit.
assert.ok(/Confirm approval — \$\{money\(pickedTotal\)\}/.test(page),
  'the confirm button does not carry the amount'); n++;
assert.ok(/money\(pickedTotal\)/.test(page.slice(page.indexOf('Approve everything'), page.indexOf('Approve everything') + 400)),
  'the approve button does not carry the amount'); n++;
// A live total, shown when it differs from the estimate total.
assert.ok(/pickedTotal !== Number\(e\.grand_total\)/.test(page),
  'the approving-total is not shown when it differs'); n++;
assert.ok(/You are approving/.test(page), 'there is no running total'); n++;
// One tap to refuse everything.
assert.ok(/I don't want any of this/.test(page), 'there is no reject-all action'); n++;
// Nothing selected must not be submittable as an approval.
assert.ok(/disabled=\{pickedCount === 0\}/.test(page),
  'an empty selection can be submitted as an approval'); n++;
// Lines stop being editable once decided.
assert.ok(/const selectable = !decided && decision\.can_decide && picked/.test(page),
  'items stay editable after the estimate is answered'); n++;
// Clearer copy for a staff-approved estimate.
assert.ok(/const APPROVED_STATUSES = \{/.test(page), 'the already-decided copy is still generic'); n++;
assert.ok(/fully_approved:\s*'This estimate has been approved/.test(page),
  'a staff-approved estimate does not say so'); n++;

console.log(`estimate per-item approval: ${n} checks passed`);
