-- Migration 161: where a RETURNING customer's new lead lands.
--
-- ── The gap ─────────────────────────────────────────────────────────────────
--
-- Migration 156 made a closed lead stop swallowing new messages: a customer
-- marked Lost in March who messages in August gets a fresh lead instead of
-- having the enquiry filed onto a dead one. Right, and half-finished — the
-- fresh lead is created with status NULL, which renders as "New Lead".
--
-- So the pipeline cannot tell apart three completely different people:
--
--   a stranger who has never contacted you
--   somebody who said no in March and has changed their mind
--   somebody who has already paid you and wants their next service
--
-- All three sit in the same bucket wearing the same label. The second is worth
-- a different conversation from the first, and the third is worth a different
-- one again — you already know their vehicle, their history and their name.
--
-- ── Why two flags and not one ───────────────────────────────────────────────
--
-- The obvious shortcut is one "Returning" status. It loses the distinction that
-- matters most: a re-enquiry is a sale you failed to close and are getting a
-- second run at; a repeat customer is revenue that already worked. Those go to
-- different people, get different scripts, and belong in different places on
-- the board.
--
-- ── Why FLAGS and not status names in the code ──────────────────────────────
--
-- Same reasoning as is_closed, and it is not theoretical here.
--
-- leads.status stores the status NAME as text (migration 013 turned the enum
-- into VARCHAR(100)). Code that hardcodes 'Re-Enquiry' breaks the moment
-- somebody renames the status on the Master Data screen — and it breaks
-- silently, which is the only kind of breakage that survives.
--
-- A flag lives on the ROW. Rename the status to anything, in any language, and
-- the tick travels with it.
--
-- ── The partial unique index over a constant ────────────────────────────────
--
-- The same trick migrations 159 and 160 use: exactly one status may hold each
-- flag. Two statuses claiming "this is where re-enquiries go" is not a
-- preference to resolve at read time, it is a contradiction, and the database
-- is where a contradiction should be refused.
--
-- ── Nothing is seeded, deliberately ─────────────────────────────────────────
--
-- No status is ticked by this migration, because no suitable status exists yet
-- — these have to be created. Until one is ticked the behaviour is byte for
-- byte what it is today: a returning customer gets a lead with status NULL.
-- The feature switches itself on when somebody decides where it should point.

BEGIN;

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_reenquiry       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_repeat_customer BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lead_statuses.is_reenquiry IS
  'New WhatsApp leads from a customer whose previous lead was CLOSED (Lost, Junk, Not Interested...) start on this status. They said no once and have come back. At most one status can hold it. Nothing happens until one does - the lead simply starts with no status, as it did before migration 161.';

COMMENT ON COLUMN lead_statuses.is_repeat_customer IS
  'New WhatsApp leads from somebody who has ALREADY had a job done - a past appointment, or a row in customer_profiles - start on this status. Takes precedence over is_reenquiry when both would apply: money that already worked outranks a sale that did not. At most one status can hold it.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_statuses_reenquiry
  ON lead_statuses ((TRUE)) WHERE is_reenquiry;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_statuses_repeat
  ON lead_statuses ((TRUE)) WHERE is_repeat_customer;

COMMENT ON INDEX idx_lead_statuses_reenquiry IS
  'At most one status is the re-enquiry destination. Two admins ticking two statuses get one winner and one error, rather than a rule that picks whichever row the planner returned first.';

-- ── Finding a past visit by phone number ────────────────────────────────────
--
-- "Has this person had a job done?" is asked once per inbound message, and the
-- honest way to ask it is on the number rather than through leads: an
-- appointment can be a walk-in with lead_id NULL (021 says so in its own
-- comment), and that walk-in is exactly the repeat customer this is for.
--
-- Indexed on the same expression as migration 155's leads index and for the
-- same reason — appointments.mobile is free text typed by staff, so
-- '+91 97241 90308' and '9724190308' are the same person and only the last ten
-- digits can say so. Without the index this is a sequential scan of every
-- appointment ever booked, on every message that arrives.
CREATE INDEX IF NOT EXISTS idx_appointments_mobile_national
  ON appointments (RIGHT(regexp_replace(COALESCE(mobile, ''), '\D', '', 'g'), 10));

COMMENT ON INDEX idx_appointments_mobile_national IS
  'Matches an appointment to a phone number on the last ten digits, the same normalisation utils/phone.js and migration 155 use. Read on every inbound WhatsApp message to decide whether the sender is a repeat customer.';

-- Same problem, same fix, for the whatsapp column — exactly as migration 155
-- did for leads. A customer whose WhatsApp number differs from the number the
-- appointment was booked under must still be recognised, and the OR in the
-- lookup would otherwise scan every row regardless of the index above.
CREATE INDEX IF NOT EXISTS idx_appointments_whatsapp_national
  ON appointments (RIGHT(regexp_replace(COALESCE(whatsapp, ''), '\D', '', 'g'), 10))
  WHERE whatsapp IS NOT NULL;

COMMIT;
