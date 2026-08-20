/**
 * The shared appointment schedule.
 *
 * One component now renders on two dashboards with different data visibility.
 * The things worth pinning are the ones that would silently differ between the
 * two shells, and the grid alignment that was already broken once.
 */
const fs = require('fs');
const assert = require('assert');
const SRC = require('path').resolve(__dirname, '../../frontend/src') + '';

const cmp = fs.readFileSync(`${SRC}/components/AppointmentSchedule.jsx`, 'utf8');
const css = fs.readFileSync(`${SRC}/styles/appointmentSchedule.css`, 'utf8');
const hub = fs.readFileSync(`${SRC}/pages/HubDashboardPage.jsx`, 'utf8');
const staff = fs.readFileSync(`${SRC}/pages/DashboardPage.jsx`, 'utf8');

let n = 0;

// ── Both dashboards render the SAME component ───────────────────────────────
for (const [name, src] of [['HubDashboardPage', hub], ['DashboardPage', staff]]) {
  assert.ok(/import AppointmentSchedule from '\.\.\/components\/AppointmentSchedule\.jsx'/.test(src),
    `${name} does not import the shared schedule`); n++;
  assert.ok(/<AppointmentSchedule \/>/.test(src), `${name} does not render it`); n++;
}
// No copy left behind — two divergent copies is the failure this refactor exists
// to prevent.
assert.ok(!/function ScheduleSection/.test(hub), 'the hub still has its own copy'); n++;
assert.ok(!/Today's Appointments — Super Admin only/.test(staff),
  'the old narrow card is still on the staff dashboard'); n++;

// ── The hub column is the ONLY difference between the two ───────────────────
assert.ok(/const showHub = !user\?\.hub_id;/.test(cmp),
  'the hub column is not keyed off the session'); n++;
assert.ok(/\{showHub && \(/.test(cmp), 'the hub column is not conditional'); n++;
// It must be its own grid cell, not appended to another line — the vehicle
// sub-line is where it used to live and that is what was asked to change.
assert.ok(!/vehicle_number.*hub_name|hub_name.*vehicle_number/.test(cmp),
  'hub name is concatenated onto the vehicle line instead of being a column'); n++;
assert.ok(/apsch-row--hub/.test(cmp) && /\.apsch-row--hub \{/.test(css),
  'no separate grid template for the hub column'); n++;

// ── No hub_id is sent ───────────────────────────────────────────────────────
// For a hub session the backend pins the query regardless; for staff the
// ABSENCE of the filter is what shows every hub. Sending the session's hub id
// would be ignored for hubs and, worse, meaningless for staff.
// Narrowed to the query strings: `user?.hub_id` is a legitimate read for
// deciding whether to show the hub COLUMN, and a blanket /hub_id/ match fails
// on that and on the comment explaining the rule.
const queries = [...cmp.matchAll(/new URLSearchParams\(\{[^}]*\}\)/gs)].map(m => m[0]);
assert.strictEqual(queries.length, 3, `expected 3 query builders, found ${queries.length}`); n++;
for (const q of queries) {
  assert.ok(!/hub_id/.test(q), `a request sends hub_id: ${q.replace(/\s+/g, ' ')}`); n++;
}
assert.ok(/date_from/.test(cmp) && /date_to/.test(cmp),
  'the schedule does not query by date range'); n++;
// The old staff card fetched the 30 most recently CREATED appointments and
// filtered client-side, so an appointment booked weeks ago for today was
// simply absent. That request is gone.
assert.ok(!/appointments\?limit=30/.test(staff), 'the old 30-row appointment fetch survived'); n++;
assert.ok(!/todayISO/.test(staff), 'the UTC-based todayISO survived on the staff dashboard'); n++;

// ── Draggable, like every other section ─────────────────────────────────────
const order = staff.match(/const DEFAULT_ORDER = \[[\s\S]*?\];/);
assert.ok(order, 'DEFAULT_ORDER not found'); n++;
assert.ok(/'schedule'/.test(order[0]), "'schedule' is not in DEFAULT_ORDER — it would not render or reorder"); n++;
assert.ok(/schedule: canViewDashApptList,/.test(staff),
  'schedule is missing from sectionMap, or uses a different permission than the card it replaced'); n++;
assert.ok(/id === 'schedule'/.test(staff), 'no render branch for the schedule section'); n++;
// Sections render inside SortableSection purely by being in the order array,
// so being listed is what makes it draggable.
assert.ok(/sectionOrder\.filter\(id => sectionMap\[id\]\)\.map\(id => \(\s*\n\s*<SortableSection/.test(staff),
  'sections are no longer rendered through SortableSection'); n++;

// ── Grid alignment: no content-sized track ──────────────────────────────────
// Each row is its own grid, so an `auto` track resolves per row and the columns
// drift. This is the bug that put the vehicle numbers at four different x
// positions; it must not come back through the shared component.
for (const sel of ['.apsch-row {', '.apsch-row--hub {']) {
  const block = css.slice(css.indexOf(sel));
  const tmpl = block.match(/grid-template-columns:([^;]+);/)[1];
  assert.ok(!/\bauto\b/.test(tmpl), `${sel} has an auto track: ${tmpl.trim()}`); n++;
  assert.ok(/minmax\(0,/.test(tmpl), `${sel} lacks minmax(0,…), so a long value can widen a track`); n++;
}
assert.ok(/\.apsch-row > \* \{ min-width: 0; \}/.test(css),
  'grid items keep min-width:auto and can be pushed wider by their content'); n++;
// Every user-entered string in a fixed track truncates rather than widening.
for (const cls of ['apsch-name', 'apsch-veh', 'apsch-hub', 'apsch-pill']) {
  const re = new RegExp(`\\.${cls}[^{]*\\{[^}]*text-overflow: ellipsis`, 's');
  const grouped = new RegExp(`\\.${cls}[,\\s][^{]*\\{[^}]*text-overflow: ellipsis`, 's');
  assert.ok(re.test(css) || grouped.test(css), `.${cls} does not truncate`); n++;
}

// ── The moved CSS left nothing behind ───────────────────────────────────────
const hubCss = fs.readFileSync(`${SRC}/styles/HubDashboardPage.css`, 'utf8');
for (const dead of ['hubdash-row', 'hubdash-tab', 'hubdash-pill', 'hubdash-viewall', 'hubdash-range']) {
  assert.ok(!hubCss.includes(dead), `${dead} rules survived in HubDashboardPage.css after the move`); n++;
}

console.log(`shared schedule: ${n} checks passed`);
