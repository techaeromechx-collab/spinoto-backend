-- Migration 195: what the customer was quoted when they booked.
--
-- ══ THE PROBLEM ════════════════════════════════════════════════════════════
--
-- A customer rings on the 1st and books an engine oil change. The advisor
-- quotes ₹2,400 from that day's pricing rules, and appointment_services.price
-- records it. The car arrives on the 22nd. By then the rule for that vehicle's
-- segment says ₹2,600.
--
-- EstimatesPage already carries the booked services onto the estimate and
-- re-prices them at today's rate — that part has always worked. What it does
-- not do is keep the ₹2,400. It reads appointment_services.price, ignores it,
-- and writes only the new figure. So the estimate says ₹2,600 and there is
-- nothing anywhere on the screen, or in the row, saying the customer was told
-- something else.
--
-- The advisor then bills ₹2,600 to somebody who is expecting ₹2,400, and finds
-- out at the counter.
--
-- ══ WHY A COLUMN AND NOT A JOIN ════════════════════════════════════════════
--
-- The booked price could be looked up: estimate_items → estimates.appointment_id
-- → appointment_services, matched on service_id. Three reasons not to.
--
--   1. appointment_services is EDITABLE. updateAppointment deletes every row
--      and re-inserts (appointments.controller.js), so re-booking a job
--      silently rewrites what we would claim the customer was originally told.
--   2. The match is not reliable. Two lines of the same service on one
--      estimate — a second oil change on a second vehicle, a re-do — have no
--      way to say which booking row each came from.
--   3. It is a promise, not a lookup. The same bargain migration 190 struck for
--      inspection points and 194 struck for issued part names: what somebody
--      was TOLD is a fact about a moment, and a fact about a moment is stored,
--      not re-derived later from data that has since moved.
--
-- So: a nullable snapshot on the line, written once when the line is carried
-- over from the booking, and never touched again.
--
-- ══ WHY INC-GST ════════════════════════════════════════════════════════════
--
-- customer_rate is ex-GST at 4dp (migration 057) because that is what the
-- invoice maths needs. booked_price is the opposite: it is the number that came
-- out of a human mouth on the phone. Pricing rules are stored inc-GST, the
-- booking screen quotes inc-GST, and "booked at ₹2,400" is only meaningful as
-- the figure the customer actually heard. Storing it ex-GST would mean showing
-- them ₹2,033.90 and calling it what they were quoted.
--
-- NULL means one of two things and both are correct: the line was typed in by
-- hand and was never booked, or the row predates this migration. Either way
-- there is no quote to honour and nothing is shown.
--
-- ══ WHY is_from_appointment IS BACKFILLED ══════════════════════════════════
--
-- The column has existed since the estimate_items table was created. It is
-- accepted by the API, stored, and returned. Nothing has ever set it to TRUE —
-- the frontend tracked carried lines in local state under a different name and
-- never sent the flag. So every row in the table says FALSE, including the
-- ones that plainly did come from a booking.
--
-- This migration does NOT invent history for them. A backfill would have to
-- guess, by matching service_id against a table that has been edited since, and
-- a guess written into a column that reads as a fact is worse than an honest
-- FALSE. From here forward the flag is set at write time and means what it says;
-- rows created before today keep saying FALSE, and booked_price being NULL on
-- them is the tell.

BEGIN;

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS booked_price NUMERIC(12,2);

COMMENT ON COLUMN estimate_items.booked_price IS
  'Inc-GST price this service was quoted at when the customer booked, copied '
  'from appointment_services.price at the moment the line was carried onto the '
  'estimate. A snapshot, never re-derived. NULL = this line was not carried '
  'from a booking, or predates migration 195. Compare against '
  'customer_rate * (1 + gst_percent/100) to show the advisor the gap.';

COMMENT ON COLUMN estimate_items.is_from_appointment IS
  'TRUE when this line was carried over from appointment_services rather than '
  'typed in. Written from migration 195 onward; every row created before that '
  'says FALSE regardless of its origin, because the flag was never set. Not '
  'backfilled — see the note at the top of 195_booked_price.sql.';

/* Only the carried lines, and only those with a gap worth drawing attention to,
   are ever asked about — the estimate detail screen wants "does this line have
   a booked price that differs". A partial index keeps that out of the way of
   every other query on a table this size. */
CREATE INDEX IF NOT EXISTS idx_estimate_items_booked
  ON estimate_items (estimate_id)
  WHERE booked_price IS NOT NULL;

DO $$
DECLARE
  total   INTEGER;
  flagged INTEGER;
BEGIN
  SELECT COUNT(*) INTO total   FROM estimate_items;
  SELECT COUNT(*) INTO flagged FROM estimate_items WHERE is_from_appointment;
  RAISE NOTICE '195: booked_price added. % existing line(s), % flagged as booked '
               '(expected 0 — nothing ever set the flag). New lines carried from '
               'a booking will record both.', total, flagged;
END $$;

COMMIT;
