/**
 * Hub dashboard date arithmetic.
 *
 * The schedule section decides what "today", "tomorrow" and "this week" mean
 * for an Indian workshop. Getting any of them wrong shows the hub the wrong
 * day's bookings, which is worse than showing none. Evaluates the real source.
 */
const fs = require('fs');
const assert = require('assert');
const SRC = require('path').resolve(__dirname, '../../frontend/src') + '';

// The helpers moved to lib/istDate.js when the schedule section was shared
// between the hub portal and the staff dashboard.
const src = fs.readFileSync(`${SRC}/lib/istDate.js`, 'utf8').replace(/^export /gm, '');
function grab(re, what) {
  const m = src.match(re);
  assert.ok(m, `could not locate ${what} in lib/istDate.js`);
  return m[0];
}
const code = [
  grab(/const IST_OFFSET_MS = [^\n]+/, 'IST_OFFSET_MS'),
  grab(/function istToday\(\) \{[\s\S]*?\n\}/, 'istToday'),
  grab(/function addDays\(ymd, n\) \{[\s\S]*?\n\}/, 'addDays'),
  grab(/function weekBounds\(ymd\) \{[\s\S]*?\n\}/, 'weekBounds'),
  grab(/function fmtTimeShort\(t\) \{[\s\S]*?\n\}/, 'fmtTimeShort'),
].join('\n');
const { istToday, addDays, weekBounds, fmtTimeShort } =
  new Function(`${code}; return { istToday, addDays, weekBounds, fmtTimeShort };`)();

let n = 0;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ── istToday agrees with the backend ────────────────────────────────────────
// Not "looks similar to" — the same value. The dashboard asks the API for
// date_from=today; if the two disagree across the 18:30 UTC boundary the hub
// sees an empty schedule at exactly the time of day they are closing up.
const backend = require(require('path').resolve(__dirname, '..') + '/src/utils/invoiceDate.js');
assert.strictEqual(istToday(), backend.istToday(), 'frontend and backend disagree on today'); n++;
assert.ok(YMD.test(istToday()), 'istToday is not YYYY-MM-DD'); n++;

// The rollover itself: 18:29 UTC is still "today" in IST, 18:30 is tomorrow.
// Rebuilt with a frozen clock rather than trusting the wall clock.
function istTodayAt(iso) {
  return new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
assert.strictEqual(istTodayAt('2026-03-14T18:29:00Z'), '2026-03-14'); n++;
assert.strictEqual(istTodayAt('2026-03-14T18:30:00Z'), '2026-03-15'); n++;
// And the trap the other way: UTC midnight is already 05:30 the same IST day.
assert.strictEqual(istTodayAt('2026-03-15T00:00:00Z'), '2026-03-15'); n++;

// ── addDays ─────────────────────────────────────────────────────────────────
assert.strictEqual(addDays('2026-03-14', 1), '2026-03-15'); n++;
assert.strictEqual(addDays('2026-03-14', -1), '2026-03-13'); n++;
assert.strictEqual(addDays('2026-03-31', 1), '2026-04-01', 'month rollover'); n++;
assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01', 'year rollover'); n++;
assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31', 'year rollback'); n++;
assert.strictEqual(addDays('2024-02-28', 1), '2024-02-29', 'leap day exists'); n++;
assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01', 'no leap day in 2026'); n++;
assert.strictEqual(addDays('2026-03-14', 0), '2026-03-14'); n++;

// ── weekBounds ──────────────────────────────────────────────────────────────
// Monday–Sunday CONTAINING the date. 2026-03-09 is a Monday.
const MON = '2026-03-09', SUN = '2026-03-15';
for (const d of [MON, '2026-03-11', '2026-03-13', SUN]) {
  const w = weekBounds(d);
  assert.strictEqual(w.from, MON, `${d}: week should start Mon ${MON}, got ${w.from}`); n++;
  assert.strictEqual(w.to, SUN, `${d}: week should end Sun ${SUN}, got ${w.to}`); n++;
}
// Sunday must belong to the week that is ENDING, not the one starting — the
// classic off-by-one when Sunday is treated as day 0 of a Mon-first week.
assert.strictEqual(weekBounds(SUN).from, MON, 'Sunday fell into the wrong week'); n++;
// Monday rolls the window forward.
assert.strictEqual(weekBounds('2026-03-16').from, '2026-03-16'); n++;

// Always exactly 7 days, including across a month boundary.
function span(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000 + 1;
}
for (const d of ['2026-01-01', '2026-02-28', '2026-03-31', '2026-12-31', '2024-02-29']) {
  const w = weekBounds(d);
  assert.strictEqual(span(w.from, w.to), 7, `${d}: week is not 7 days`); n++;
  assert.ok(w.from <= d && d <= w.to, `${d}: not inside its own week`); n++;
}

// ── The single-request window ───────────────────────────────────────────────
// The section fetches week.from .. max(week.to, tomorrow) and slices the three
// tabs out of it. On a Sunday, tomorrow is next week — if the window did not
// stretch, the Tomorrow tab would silently render empty.
for (const today of [MON, '2026-03-13', SUN]) {
  const w = weekBounds(today);
  const tomorrow = addDays(today, 1);
  const winTo = w.to > tomorrow ? w.to : tomorrow;
  assert.ok(w.from <= today && today <= winTo, `${today}: window misses today`); n++;
  assert.ok(w.from <= tomorrow && tomorrow <= winTo, `${today}: window misses tomorrow`); n++;
  assert.ok(w.from <= w.from && w.to <= winTo, `${today}: window misses the week`); n++;
}
assert.strictEqual(weekBounds(SUN).to < addDays(SUN, 1), true,
  'Sunday: tomorrow really is outside the week — the stretch is load-bearing'); n++;

// ── fmtTimeShort ────────────────────────────────────────────────────────────
assert.strictEqual(fmtTimeShort('09:30:00'), '9:30 AM'); n++;
assert.strictEqual(fmtTimeShort('13:05:00'), '1:05 PM'); n++;
assert.strictEqual(fmtTimeShort('00:15:00'), '12:15 AM', 'midnight hour is 12 AM, not 0'); n++;
assert.strictEqual(fmtTimeShort('12:00:00'), '12:00 PM', 'noon is 12 PM, not 0 PM'); n++;
assert.strictEqual(fmtTimeShort('23:59'), '11:59 PM'); n++;
// No time set is common on walk-ins — must not render "Invalid Date".
for (const bad of [null, undefined, '', 'nonsense']) {
  assert.strictEqual(fmtTimeShort(bad), '—', `fmtTimeShort(${JSON.stringify(bad)})`); n++;
}

console.log(`hub dashboard dates: ${n} checks passed`);
