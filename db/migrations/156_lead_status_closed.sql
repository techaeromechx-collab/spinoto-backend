-- Migration 156: mark which lead statuses mean "this lead is finished".
--
-- ── Why this is not is_pipeline ─────────────────────────────────────────────
--
-- is_pipeline already exists and looks like the right flag. It is not.
--
-- Its user-facing label is "Count in Pipeline Value" and its hint says the
-- leads will be included in the Pipeline Value on the dashboard. It is a
-- REPORTING flag: does this lead's money count. That happens to correlate with
-- "is the lead finished" today, and the two will not always agree — the day
-- someone unticks a status for a reporting reason, WhatsApp routing would
-- change with it, silently, with nothing on that screen saying so.
--
-- One checkbox quietly controlling two unrelated things is how surprises get
-- built. So this is its own flag with its own sentence in the UI.
--
-- ── What it does ────────────────────────────────────────────────────────────
--
-- When a WhatsApp message arrives from a number whose only lead is closed, the
-- message does NOT land on that lead. A new one is created instead.
--
-- Without this, a customer marked Lost in March who messages again in August
-- has their enquiry filed onto a dead lead. Nobody works the Lost list, so
-- nobody replies. The message is stored, visible, and unread forever — which is
-- worse than not receiving it, because the system looks like it worked.

BEGIN;

-- DEFAULT FALSE deliberately. A status nobody has classified keeps behaving
-- exactly as it does today, and a status created next year is "still being
-- worked" until somebody says otherwise. The safe direction for a wrong guess
-- is an extra message on an existing lead, not an enquiry filed out of sight.
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lead_statuses.is_closed IS
  'This status means the lead is finished. A new inbound WhatsApp message from that customer starts a FRESH lead instead of landing here. Separate from is_pipeline, which is about dashboard value only.';

-- ── Seeded by EXACT NAME, not by matching words ─────────────────────────────
--
-- This is the mistake migration 047 made. It set is_pipeline = FALSE using
-- name ILIKE '%lost%' OR '%convert%' OR '%cancel%' — and "Junk" contains none
-- of those words, so it was missed and has been counting toward Pipeline Value
-- ever since. "Not Interested" and "Out of Service Area" too.
--
-- A list is longer but it cannot quietly skip the one that matters most.
-- Anything not named here stays FALSE and can be ticked in
-- Master Data → Lead Statuses, which is the point of the checkbox.
UPDATE lead_statuses
   SET is_closed = TRUE
 WHERE LOWER(TRIM(name)) IN (
   'lost',
   'junk',
   'not interested',
   'out of service area',
   'appointment cancelled',
   -- The end of the chase sequence. Day 1 and Day 2 are still being worked, so
   -- they stay open; Day 3 is where it stops.
   'no show (day 3)'
 );

COMMIT;
