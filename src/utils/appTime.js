'use strict';

/**
 * The application's clock. India, always.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The workshop is in India. The database is not — it runs UTC, because that is
 * what a managed Postgres defaults to and nothing ever told it otherwise. So
 * every question of the form "what DAY did this happen on" was being answered
 * five and a half hours early, in roughly a hundred places.
 *
 * Two separate clocks had to be moved, because they go wrong in different ways:
 *
 *   THE DATABASE decides what `some_timestamptz::date` means, and what NOW()
 *   and CURRENT_DATE return. On UTC, a payment taken at 3am IST on the 25th is
 *   filed against the 24th. Every daily total, every "today's leads", every
 *   done_at::date <= due_date comparison in the follow-up compliance report.
 *
 *   NODE decides how `new Date('2026-08-25T09:00:00')` — a string with no zone —
 *   is read. On UTC it means 09:00 UTC. The follow-up code has always written
 *   its due_at exactly that way, with a comment saying it does so deliberately
 *   so that "9am means 9am at the workshop"... while the process ran in UTC and
 *   filed it at 2:30pm IST. Every morning follow-up in the system is five and a
 *   half hours late and has been since the feature shipped.
 *
 * ── WHAT SETS WHAT ──────────────────────────────────────────────────────────
 *
 * `applyProcessTimezone()` is called as the FIRST statement of server.js and
 * db/migrate.js. It must run before anything else, because Node caches the
 * timezone the first time a Date is formatted; setting process.env.TZ after
 * that point changes the variable and not the behaviour.
 *
 * The database side is set on the connection itself in config/db.js, via the
 * startup packet rather than a `SET TIME ZONE` afterwards. A SET has to be
 * issued per connection, and a pool opens new ones whenever it feels like it —
 * so one missed connection means one query, occasionally, silently answering in
 * UTC. That is the worst possible version of this bug: intermittent and
 * invisible.
 *
 * ── AND THE STRING HELPERS BELOW ────────────────────────────────────────────
 *
 * istToday() does explicit offset arithmetic instead of trusting process.env.TZ.
 * Belt and braces on purpose: it is the one thing here that stays correct even
 * if somebody launches the process with TZ= set to something else, or runs a
 * script that skips applyProcessTimezone(). Dates are compared as 'YYYY-MM-DD'
 * strings for the same reason — a calendar date has no time of day, and giving
 * it one is how it acquires a timezone to be wrong about.
 *
 * India has no daylight saving, which is what makes a fixed offset honest here.
 * It would not be in a country that has it.
 */

const IST = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Call FIRST, before any other require that might touch a Date. */
function applyProcessTimezone() {
  process.env.TZ = IST;
  return IST;
}

/** Today's calendar date in IST as 'YYYY-MM-DD', whatever the process TZ is. */
function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `d` shifted by `days`, both ends 'YYYY-MM-DD'. Pure calendar arithmetic. */
function istAddDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Day of the week for an IST 'YYYY-MM-DD'. 0 = Sunday, as JS numbers them. */
function istWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The instant IST-midnight ends on `dateStr`, as an ISO string.
 *
 * For comparing against a timestamptz column, where an absolute moment is
 * wanted rather than a calendar day. 23:59:59.999 IST is 18:29:59.999Z.
 */
function istEndOfDayISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS).toISOString();
}

/**
 * A value from the database as the calendar date it actually is, 'YYYY-MM-DD'.
 *
 * ── WHY THIS EXISTS, AND WHY toISOString() IS NOT IT ───────────────────────
 *
 * `pg` turns a DATE column into a Date built at LOCAL midnight. With the
 * process pinned to IST by applyProcessTimezone() above, 2026-07-09 arrives as
 *
 *     Thu Jul 09 2026 00:00:00 GMT+0530
 *
 * and `.toISOString()` on that is "2026-07-08T18:30:00.000Z". Slice ten
 * characters off and the date is a DAY EARLY — on every row, silently, and
 * only on a server east of Greenwich. Which is every server this runs on.
 *
 * Reading the calendar parts instead returns what was stored, because those
 * are the same parts `pg` put in. Verified against four server timezones:
 * local parts were right in all four, toISOString() wrong in two (IST among
 * them), and forcing IST wrong in one.
 *
 * For a TIMESTAMPTZ the value is an instant rather than a calendar day, and
 * the local parts give its IST date — which is the date a person in the office
 * would call it. That depends on the process TZ, which applyProcessTimezone()
 * sets as the first statement of server.js.
 *
 * A string is passed through after being checked, so a column already cast to
 * text in SQL — the bulletproof version of this — costs nothing here.
 */
function calendarDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  IST, applyProcessTimezone, istToday, istAddDays, istWeekday, istEndOfDayISO,
  calendarDate,
};
