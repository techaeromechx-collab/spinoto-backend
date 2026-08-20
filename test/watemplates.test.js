/**
 * The two WhatsApp templates that never sent, and the public estimate page they
 * point at.
 *
 * Four separate faults are pinned here. Each one was invisible from the UI —
 * the templates reported "Auto" with a green dot while sending nothing, and the
 * approval page returned a plausible error instead of working.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appts    = fs.readFileSync(`${BE}/src/controllers/appointments.controller.js`, 'utf8');
const ests     = fs.readFileSync(`${BE}/src/controllers/estimates.controller.js`, 'utf8');
const pubEst   = fs.readFileSync(`${BE}/src/controllers/public.estimate.controller.js`, 'utf8');
const pubRts   = fs.readFileSync(`${BE}/src/routes/public.documents.routes.js`, 'utf8');
const estPage  = fs.readFileSync(`${FE}/pages/PublicEstimatePage.jsx`, 'utf8');
const waUi     = fs.readFileSync(`${FE}/components/settings/WhatsAppSettings.jsx`, 'utf8');
const mig128   = fs.readFileSync(`${BE}/db/migrations/128_wa_direct_fire_templates.sql`, 'utf8');

// ── FAULT 1: appointment_reschedule had no trigger at all ──────────────────
const apptsCode = strip(appts);
assert.ok(/templateKey: 'appointment_reschedule'/.test(apptsCode),
  'nothing fires appointment_reschedule'); n++;
assert.ok(/if \(isRescheduling\) \{[\s\S]{0,900}templateKey: 'appointment_reschedule'/.test(apptsCode),
  'the reschedule message is not gated on an actual reschedule'); n++;
assert.ok(/entityType: 'appointment'/.test(
  apptsCode.slice(apptsCode.indexOf("templateKey: 'appointment_reschedule'") - 200,
                  apptsCode.indexOf("templateKey: 'appointment_reschedule'") + 300)),
  'the reschedule message does not use the appointment context'); n++;

// The dedupe key is the NEW SLOT, not the transition.
//
// wa_messages has UNIQUE (template_key, entity_type, entity_id, dedupe_key)
// WHERE direction='out'. A constant key means one appointment can produce one
// reschedule message ever — and rescheduling twice is ordinary.
assert.ok(/dedupeKey: `reschedule:\$\{appt\.scheduled_date \|\| ''\}T\$\{appt\.scheduled_time \|\| ''\}`/.test(appts),
  'the reschedule dedupe key is not derived from the new date and time'); n++;
assert.ok(!/dedupeKey: `?'?status:rescheduled/.test(apptsCode),
  'the reschedule dedupe key is the transition — a second reschedule would be silent'); n++;
// Simulated: two different slots must produce two different keys; the same slot
// twice (a retry) must produce one.
{
  const key = (d, t) => `reschedule:${d || ''}T${t || ''}`;
  assert.notStrictEqual(key('2026-08-18', '09:30:00'), key('2026-08-20', '14:00:00'),
    'two different reschedules collapse to one key'); n++;
  assert.strictEqual(key('2026-08-18', '09:30:00'), key('2026-08-18', '09:30:00'),
    'a retried request would send twice'); n++;
  // dedupe_key is VARCHAR(60).
  assert.ok(key('2026-08-18', '09:30:00').length <= 60,
    'the dedupe key overflows its column'); n++;
}
// NOT routed through advanceAppointmentStatus: its UPDATE is
// `WHERE status_id IS DISTINCT FROM $1`, so an appointment already sitting in
// 'rescheduled' returns before the messaging step.
assert.ok(!/advanceAppointmentStatus\([^)]*'rescheduled'/.test(apptsCode),
  "routed through advanceAppointmentStatus — a second reschedule would no-op before sending"); n++;
// Fired after the commit, and swallowed.
const reschedIdx = apptsCode.indexOf("templateKey: 'appointment_reschedule'");
const commitIdx  = apptsCode.lastIndexOf("await client.query('COMMIT')", reschedIdx);
assert.ok(commitIdx > 0 && commitIdx < reschedIdx,
  'the reschedule message is queued before the reschedule is committed'); n++;

// ── FAULT 2: estimate_approval fired with the wrong entity, at the wrong time ──
const estsCode = strip(ests);
assert.ok(/templateKey: 'estimate_approval'/.test(estsCode), 'nothing fires estimate_approval'); n++;
assert.ok(/entityType: 'estimate'/.test(estsCode),
  "estimate_approval does not use the estimate context — estimate_amount and estimate_link cannot resolve"); n++;
// It must fire from companyApprove (status → sent_to_customer), NOT from
// submitEstimate (status → pending_company_review, a price Spinoto has not
// reviewed).
const caIdx = estsCode.indexOf('function companyApprove');
const fireIdx = estsCode.indexOf("templateKey: 'estimate_approval'");
assert.ok(caIdx > 0 && fireIdx > caIdx,
  'estimate_approval does not fire from companyApprove'); n++;
const submitIdx = estsCode.indexOf("'estimate-submitted'");
assert.ok(submitIdx < caIdx,
  'estimate_approval appears to fire from the submit path, before Spinoto has reviewed the price'); n++;
assert.ok(/dedupeKey: `sent:\$\{id\}`/.test(ests), 'estimate_approval has no stable dedupe key'); n++;
assert.ok(/require\('\.\.\/services\/whatsapp\.dispatcher'\)/.test(ests),
  'the dispatcher is not imported'); n++;

// ── FAULT 3: the public estimate page called routes that do not exist ──────
// Every URL the page fetches must match a route the backend actually mounts.
// This is the check that would have caught it: three calls, zero of them real.
const mounted = [...pubRts.matchAll(/router\.(get|post)\('([^']+)'/g)]
  .map(m => `/api/public/documents${m[2]}`);
assert.ok(mounted.length >= 4, `expected at least 4 public document routes, found ${mounted.length}`); n++;

// Everything after ${API_URL} up to the closing backtick — the earlier version
// of this stopped at the '$' of ${encodeURIComponent(token)} and compared a
// truncated path, which is its own way of passing for the wrong reason.
const called = [...estPage.matchAll(/\$\{API_URL\}([^`]*)/g)].map(m => m[1]);
assert.ok(called.length >= 3, `expected 3 API calls from the estimate page, found ${called.length}`); n++;
for (const url of called) {
  // Compare shapes: the call has ${...} where the route has :param.
  const shape = url.replace(/\$\{[^}]+\}/g, ':p').replace(/\/$/, '');
  const ok = mounted.some(r => r.replace(/:[^/]+/g, ':p') === shape);
  assert.ok(ok, `the estimate page calls ${url} — no such route is mounted. Mounted: ${mounted.join(', ')}`); n++;
}
assert.ok(!/api\/public\/estimates\//.test(estPage),
  'the page still calls /api/public/estimates/ (plural, unmounted)'); n++;

// ── FAULT 4: the approval guard checked an impossible status ──────────────
// estimates.status CHECK (migration 052) does not allow 'submitted'.
const ALLOWED = ['draft', 'pending_company_review', 'sent_to_customer', 'partially_approved',
                 'fully_approved', 'revision_requested', 'work_in_progress', 'work_completed'];
const mig052 = fs.readFileSync(`${BE}/db/migrations/052_estimates.sql`, 'utf8');
for (const st of ALLOWED) {
  assert.ok(mig052.includes(`'${st}'`), `${st} is not in the CHECK constraint — the allow-list here is stale`); n++;
}
assert.ok(!mig052.includes("'submitted'"),
  "'submitted' IS a valid status after all — re-check this fix"); n++;

const pubEstCode = strip(pubEst);
assert.ok(!/status !== 'submitted'|status = 'submitted'/.test(pubEstCode),
  "the approval guard still checks 'submitted', which no estimate can ever hold"); n++;
assert.ok(/row\.status !== 'sent_to_customer'/.test(pubEstCode),
  'the decidable() guard does not check sent_to_customer'); n++;
assert.ok(/AND status = 'sent_to_customer'/.test(pubEstCode),
  'the conditional UPDATE does not guard on sent_to_customer'); n++;
// Every status the guards name must be one the column can hold.
for (const m of pubEstCode.matchAll(/status (?:!==|=) '([a-z_]+)'/g)) {
  assert.ok(ALLOWED.includes(m[1]),
    `the guard references status '${m[1]}', which the CHECK constraint does not allow`); n++;
}

// ── The estimate PDF route ────────────────────────────────────────────────
assert.ok(/router\.get\('\/estimate-pdf\/:token'/.test(pubRts), 'the estimate PDF route is not mounted'); n++;
assert.ok(/getPublicEstimatePdf/.test(pubEst), 'the estimate PDF handler does not exist'); n++;
// It must use the NARROW public select, never the internal one — an estimate
// carries hub rates and commission, which is the margin on the job.
const pdfBody = pubEst.slice(pubEst.indexOf('async function getPublicEstimatePdf'));
assert.ok(/PUBLIC_ESTIMATE/.test(pdfBody), 'the PDF handler does not use the public select'); n++;
assert.ok(!/EST_SELECT/.test(pubEst), 'the public estimate controller reaches for the internal select'); n++;
// A draft is not a quote.
assert.ok(/DOWNLOADABLE_STATUSES/.test(pdfBody), 'any status can be downloaded, including drafts'); n++;
for (const blocked of ['draft', 'pending_company_review']) {
  const set = pubEst.slice(pubEst.indexOf('const DOWNLOADABLE_STATUSES'), pubEst.indexOf(']);'));
  assert.ok(!set.includes(`'${blocked}'`),
    `${blocked} is downloadable — that is a price nobody has approved`); n++;
}
// Public request ⇒ no Origin-derived base URL baked into the QR.
assert.ok(/baseUrl: null/.test(pdfBody), 'the PDF passes a request-derived base URL into the QR'); n++;
assert.ok(/no-store/.test(pdfBody), "a proxy could cache one customer's estimate and serve it to another"); n++;

// ── Migration 128 ─────────────────────────────────────────────────────────
assert.ok(/SET trigger_status_slug = NULL/.test(mig128), 'the migration does not clear the triggers'); n++;
for (const k of ['estimate_approval', 'appointment_reschedule']) {
  assert.ok(mig128.includes(`'${k}'`), `${k} is not covered by the migration`); n++;
}
assert.ok(!/auto_send/.test(mig128.replace(/--.*$/gm, '')),
  'the migration touches auto_send — these templates stay automatic'); n++;
assert.ok(!/BEGIN;|COMMIT;/.test(mig128), 'the migration opens its own transaction — migrate.js wraps it'); n++;

// ── The Settings screen no longer offers the trap ─────────────────────────
assert.ok(/const DIRECT_FIRE = \{/.test(waUi), 'the direct-fire registry is missing'); n++;
for (const k of ['invoice_ready', 'estimate_approval', 'appointment_reschedule']) {
  assert.ok(new RegExp(`${k}:`).test(waUi), `${k} can still be pointed at a status`); n++;
}
assert.ok(/t\.supports_auto && !DIRECT_FIRE\[t\.template_key\] && \(/.test(waUi),
  'the appointment dropdown still renders for code-fired templates'); n++;
assert.ok(/t\.supports_auto && DIRECT_FIRE\[t\.template_key\] && \(/.test(waUi),
  'code-fired templates show nothing at all instead of when they send'); n++;

console.log(`whatsapp templates + public estimate: ${n} checks passed`);
