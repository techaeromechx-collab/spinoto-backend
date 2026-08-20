/**
 * Appointments calendar — month grid and the endpoint behind it.
 *
 * Two things carry real risk here: the grid maths (a wrong cell shows the wrong
 * day's bookings) and the hub scoping on a brand-new list endpoint (a leak
 * would expose every hub's schedule to every hub).
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const SRC = require('path').resolve(__dirname, '../../frontend/src') + '';
const ROOT = require('path').resolve(__dirname, '..') + '/src';

let n = 0;

// ── Grid maths, from the real source ────────────────────────────────────────
const dateSrc = fs.readFileSync(`${SRC}/lib/istDate.js`, 'utf8').replace(/^export /gm, '');
const { monthGrid, addMonths, addDays, monthOf, fmtMonthLabel } =
  new Function(`${dateSrc}; return { monthGrid, addMonths, addDays, monthOf, fmtMonthLabel };`)();

// Always 42 cells, so the grid never changes height while paging — a grid that
// grows a row moves the "next month" arrow out from under the cursor.
for (const ym of ['2026-08', '2026-02', '2024-02', '2026-01', '2026-12', '2027-05']) {
  const g = monthGrid(ym);
  assert.strictEqual(g.days.length, 42, `${ym}: not 42 cells`); n++;
  // Every cell is one day after the last — no gaps, no repeats.
  for (let i = 1; i < 42; i++) {
    assert.strictEqual(g.days[i].date, addDays(g.days[i - 1].date, 1), `${ym}: cell ${i} is not consecutive`);
  }
  n++;
  // The whole calendar month is present.
  const inMonth = g.days.filter(d => d.inMonth).map(d => d.date);
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  assert.strictEqual(inMonth.length, lastDay, `${ym}: expected ${lastDay} in-month days, got ${inMonth.length}`); n++;
  assert.strictEqual(inMonth[0], `${ym}-01`, `${ym}: first in-month cell is not the 1st`); n++;
  // from/to describe the VISIBLE span, which is what the fetch must cover —
  // requesting only the month leaves the leading and trailing cells wrongly
  // empty.
  assert.strictEqual(g.from, g.days[0].date); n++;
  assert.strictEqual(g.to, g.days[41].date); n++;
  assert.ok(g.from <= `${ym}-01` && g.to >= `${ym}-${String(lastDay).padStart(2, '0')}`,
    `${ym}: visible span does not cover the month`); n++;
}

// Sunday-first, matching the SUN…SAT header. 2026-08-01 is a Saturday, so the
// grid starts on Sunday 2026-07-26 — the exact leading run in the mockup.
const aug = monthGrid('2026-08');
assert.strictEqual(aug.days[0].date, '2026-07-26', 'August 2026 should start at Sun 26 Jul'); n++;
assert.strictEqual(aug.days[0].inMonth, false, 'a leading day is marked in-month'); n++;
assert.strictEqual(aug.days[6].date, '2026-08-01', 'the 1st should land in the Saturday column'); n++;
// Monday-first is supported for the day we want it.
assert.strictEqual(monthGrid('2026-08', 1).days[0].date, '2026-07-27', 'Monday-first grid is wrong'); n++;

// A month starting exactly on the week start must NOT gain a blank leading week.
// 2026-03-01 is a Sunday.
assert.strictEqual(monthGrid('2026-03').days[0].date, '2026-03-01',
  'a month starting on Sunday gained a leading week'); n++;

// addMonths across the year boundary, both directions.
assert.strictEqual(addMonths('2026-12', 1), '2027-01'); n++;
assert.strictEqual(addMonths('2026-01', -1), '2025-12'); n++;
assert.strictEqual(addMonths('2026-08', 0), '2026-08'); n++;
assert.strictEqual(addMonths('2026-08', 12), '2027-08'); n++;
assert.strictEqual(monthOf('2026-08-14'), '2026-08'); n++;
assert.ok(/August 2026/.test(fmtMonthLabel('2026-08')), 'month label is wrong'); n++;

// ── The endpoint ────────────────────────────────────────────────────────────
let QUERIES = [];
const fakePool = {
  query: async (sql, params) => { QUERIES.push({ sql: String(sql), params }); return { rows: [], rowCount: 0 }; },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};
for (const [file, exp] of Object.entries({
  [path.join(ROOT, 'config/db.js')]: { pool: fakePool },
  [path.join(ROOT, 'socket.js')]: { getIO: () => ({ emit() {} }) },
})) require.cache[file] = { id: file, filename: file, loaded: true, exports: exp };

function run(handler, req) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {}, set() { return res; },
      json: (b) => resolve({ status: 200, body: b }),
      status: (s) => ({ json: (b) => resolve({ status: s, body: b }), end: () => resolve({ status: s }) }),
    };
    handler(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
    setTimeout(() => resolve({ status: 'timeout' }), 400);
  });
}

const HUB   = { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false };
const ADMIN = { id: 1, hub_id: null, permissions: new Set(['VIEW_APPOINTMENT']), is_super_admin: false };

(async () => {
  const ctrl = require(path.join(ROOT, 'controllers/appointments.controller.js'));
  assert.ok(typeof ctrl.listAppointmentsCalendar === 'function', 'not exported'); n++;

  const q = (user, query) => run(ctrl.listAppointmentsCalendar, { user, params: {}, query });

  // THE one that matters: a hub is pinned to its own hub, and a hub_ids in the
  // query string cannot widen it.
  QUERIES = [];
  let r = await q(HUB, { month: '2026-08', hub_ids: '1,2,5' });
  assert.strictEqual(r.status, 200, `hub calendar got ${r.status}`); n++;
  const hq = QUERIES[0];
  assert.ok(/a\.hub_id = \$\d+/.test(hq.sql), 'the hub scope predicate is missing'); n++;
  assert.ok(hq.params.includes(3), 'the session hub id never reached the query'); n++;
  assert.ok(!/ANY\(\$\d+::int\[\]\)/.test(hq.sql),
    'a hub passed hub_ids and it was honoured — that widens them across hubs'); n++;
  assert.ok(!hq.params.some(p => Array.isArray(p) && p.includes(5)),
    'another hub id from the query string reached the query'); n++;

  // Staff with VIEW_APPOINTMENT see everything, and may filter by hub.
  QUERIES = [];
  await q(ADMIN, { month: '2026-08', hub_ids: '1,2' });
  const aq = QUERIES[0];
  assert.ok(/ANY\(\$\d+::int\[\]\)/.test(aq.sql), 'staff hub filter was dropped'); n++;
  assert.ok(!/EXISTS \(\s*SELECT 1 FROM leads/.test(aq.sql),
    'a user with VIEW_APPOINTMENT was narrowed to their own leads'); n++;

  // Staff WITHOUT the permission fall back to their own leads, as the list does.
  QUERIES = [];
  await q({ id: 7, hub_id: null, permissions: new Set(), is_super_admin: false }, { month: '2026-08' });
  assert.ok(/EXISTS \(\s*SELECT 1 FROM leads/.test(QUERIES[0].sql),
    'a permissionless staff user was not narrowed to their own leads'); n++;

  // month=YYYY-MM expands to the real first and last of that month.
  QUERIES = [];
  r = await q(ADMIN, { month: '2026-02' });
  assert.strictEqual(r.body.date_from, '2026-02-01'); n++;
  assert.strictEqual(r.body.date_to, '2026-02-28', 'February 2026 has 28 days'); n++;
  r = await q(ADMIN, { month: '2024-02' });
  assert.strictEqual(r.body.date_to, '2024-02-29', 'February 2024 is a leap year'); n++;
  r = await q(ADMIN, { month: '2026-12' });
  assert.strictEqual(r.body.date_to, '2026-12-31'); n++;

  // Bad input is refused rather than silently returning everything.
  for (const [query, why] of [
    [{}, 'no range at all'],
    [{ month: '2026-13' }, 'month 13'],
    [{ month: 'August' }, 'a month name'],
    [{ date_from: '2026-08-01' }, 'only one end of the range'],
    [{ date_from: '2026-08-31', date_to: '2026-08-01' }, 'reversed range'],
    [{ date_from: '01-08-2026', date_to: '31-08-2026' }, 'DD-MM-YYYY'],
    [{ date_from: '2026-01-01', date_to: '2026-12-31' }, 'a whole year'],
  ]) {
    r = await q(ADMIN, query);
    assert.strictEqual(r.status, 400, `${why} was accepted`); n++;
  }

  // No LIMIT: bounded by the date range instead. A month grid that silently
  // drops the 101st appointment is the bug this endpoint exists to avoid.
  QUERIES = [];
  await q(ADMIN, { month: '2026-08' });
  assert.ok(!/\bLIMIT\b/i.test(QUERIES[0].sql), 'the calendar query has a LIMIT'); n++;
  assert.ok(!/\bOFFSET\b/i.test(QUERIES[0].sql), 'the calendar query is paginated'); n++;

  // Slim projection, and no customer mobile — a cell has no use for it, which
  // also keeps this clear of the contact-masking rules.
  const sql = QUERIES[0].sql;
  assert.ok(!/a\.mobile\s+AS|\ba\.mobile,/.test(sql), 'the calendar selects the customer mobile'); n++;
  for (const col of ['public_token', 'scheduled_date', 'scheduled_time', 'customer_name',
                     'vehicle_number', 'status_name', 'status_color', 'status_bg', 'hub_name']) {
    assert.ok(sql.includes(col), `the projection is missing ${col}`); n++;
  }
  // Ordered by the schedule, not by booking order.
  assert.ok(/ORDER BY a\.scheduled_date ASC, a\.scheduled_time ASC/.test(sql),
    'the calendar is not ordered by the schedule'); n++;

  // ── Route wiring ──────────────────────────────────────────────────────────
  const routes = fs.readFileSync(path.join(ROOT, 'routes/appointments.routes.js'), 'utf8');
  const iCal = routes.indexOf("'/calendar'");
  const iId  = routes.indexOf("router.get   ('/:id'");
  assert.ok(iCal > -1 && iId > -1, 'could not find both routes'); n++;
  assert.ok(iCal < iId, "'/calendar' is declared below '/:id' and will be matched as an id"); n++;
  assert.ok(/router\.get\s+\('\/calendar', \.\.\.canView/.test(routes),
    'the calendar route does not use the same gate as the list'); n++;

  // ── The legend is data-driven ─────────────────────────────────────────────
  const cal = fs.readFileSync(`${SRC}/components/AppointmentCalendar.jsx`, 'utf8');
  assert.ok(/statuses\.filter\(/.test(cal), 'the legend is not built from the statuses list'); n++;
  // Behind a button: eighteen statuses laid out flat took two full rows of the
  // footer, more vertical space than a week of the grid.
  assert.ok(/function LegendButton/.test(cal), 'the legend is not collapsed behind a button'); n++;
  assert.ok(/useEscapeClose\(\(\) => setOpen\(false\), open\)/.test(cal),
    'the legend panel does not close on Escape'); n++;
  assert.ok(/apcal-legend-backdrop/.test(cal), 'the legend panel does not close on an outside click'); n++;
  const calCss = fs.readFileSync(`${SRC}/styles/appointmentCalendar.css`, 'utf8');
  // The footer sits at the bottom of a tall card, so a downward panel would
  // hang off the end of the page.
  assert.ok(/\.apcal-legend-pop \{[^}]*bottom: calc\(100% \+ 8px\)/s.test(calCss),
    'the legend panel opens downward off the bottom of the page'); n++;
  assert.ok(/\.apcal-legend-grid \{[^}]*grid-template-columns/s.test(calCss),
    'the legend is a single column — eighteen statuses would need scrolling'); n++;
  for (const hardcoded of ['Booked', 'Checked In', 'In Service']) {
    assert.ok(!cal.includes(`>${hardcoded}<`), `"${hardcoded}" is hardcoded into the legend`); n++;
  }
  // The fetch must cover the visible span, not the calendar month.
  assert.ok(/date_from: from, date_to: to/.test(cal) || /qs\.set\('date_from'/.test(cal) || /date_from: from/.test(cal),
    'the calendar does not request the visible grid span'); n++;
  assert.ok(/const \{ from, to \} = grid;/.test(cal),
    'the request range is not taken from the grid — leading/trailing cells would be empty'); n++;

  console.log(`appointments calendar: ${n} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
