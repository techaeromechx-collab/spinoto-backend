-- Migration 164: clearing a conversation out of the WhatsApp dropdown.
--
-- ── Two different verbs, and they are not the same thing ────────────────────
--
--   Mark as read   "I have seen this." The badge drops. The row stays, because
--                  a list that empties itself as you look at it cannot be used
--                  to find the message you just read.
--   Clear          "I am done with this." The row goes.
--
-- Without the second one the dropdown only ever grows. Every number that has
-- ever messaged the workshop stays in it forever, and the twenty conversations
-- that are finished bury the two that are not.
--
-- ── Why a cursor and not a deleted flag ─────────────────────────────────────
--
-- Same trick as read_at, for the same reason, and it matters more here.
--
-- A boolean "dismissed" would have to be UNSET when the customer writes again —
-- from the webhook, for every user who had cleared it, on every inbound
-- message. Three writes, a race, and one missed update means a customer's reply
-- lands in a conversation that stays invisible. That is the failure mode this
-- whole feature exists to prevent.
--
-- A timestamp needs no such update. The row is hidden while its last message is
-- OLDER than the cursor; the moment a newer message arrives it reappears by
-- arithmetic, with nothing written anywhere.
--
-- ── Nothing is deleted, and that is not squeamishness ───────────────────────
--
-- These are real conversations with real customers. "Clear" removes a row from
-- one person's dropdown, and the thread on the lead is untouched — as is
-- everybody else's view of it, since the cursor is per user like the read one.
-- A Clear that destroyed messages would be a button nobody could safely press.

BEGIN;

ALTER TABLE wa_conversation_reads
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN wa_conversation_reads.dismissed_at IS
  'This user cleared the conversation out of their WhatsApp dropdown at this moment. Hidden while its newest message is older than this; a newer message brings it back automatically, with no write. NULL means never cleared. Deletes nothing - the thread on the lead and every other user''s view are untouched.';

COMMIT;
