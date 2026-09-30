-- 199_chat_reactions_and_ticks.sql
--
-- Two things people expect from a chat window: a reaction, and knowing whether
-- the other person has actually looked at it.
--
-- ══ REACTIONS ══════════════════════════════════════════════════════════════
--
-- A row per (message, person, reaction). The primary key is all three, which is
-- the whole design:
--
--   one person CAN add 👍 and ❤️ to the same message
--   one person CANNOT add 👍 twice
--
-- A key on (message_id, user_id) alone would allow only one reaction each and
-- make a second one silently replace the first; no key at all and a double-click
-- puts two thumbs on one message from one person, which then has to be deduped
-- on every read forever.
--
-- ── A SHORT KEY, NOT THE EMOJI ──
--
-- The column holds 'up', 'heart', 'haha' — not the character. Three reasons, in
-- order of how much they matter:
--
--   The set stays closed. A TEXT column that holds emoji is a free-text column,
--   and the first time somebody posts a reaction from a different client it holds
--   a sentence. A CHECK on six ASCII keys cannot.
--
--   It is greppable and diffable. 'heart' shows up in a log, a query, a git diff
--   and a test name; the character does not, and in some terminals it is a box.
--
--   No encoding to get wrong. Emoji outside the BMP are surrogate pairs, they
--   normalise in more than one way (️ variation selectors), and two visually
--   identical hearts can be different byte strings — which would defeat the
--   primary key. Mapping key → character in the UI keeps all of that out of the
--   database.
--
-- ══ TICKS ══════════════════════════════════════════════════════════════════
--
-- chat_reads already carries read_at per (user, conversation). This adds
-- delivered_at beside it, so the three states are all honest:
--
--   one tick        the server has it
--   two grey ticks  delivered — their app has fetched it
--   two teal ticks  read — they have actually looked at the conversation
--
-- The difference is written by the same endpoint, on a condition that already
-- exists: listMessages writes read_at ONLY when the tab is visible (a background
-- tab refetching on a socket nudge must not clear somebody's badge for a message
-- nobody has looked at). delivered_at is written EVERY time, visible or not.
-- So "delivered" means their browser has the bytes and "read" means a person was
-- in front of it — which is exactly what the two states mean everywhere else.
--
-- No "delivered" was invented to make three ticks out of two. If there were no
-- honest way to tell the difference, this table would have stayed as it was and
-- the UI would have shown two states.
--
-- ── WHY NOT PER MESSAGE ──
--
-- A read receipt per message is a row per message per recipient, and it is not
-- needed: reading is monotonic. Somebody who has read up to 14:32 has read every
-- message before it, so one cursor answers for the whole thread by arithmetic.
-- Per-message rows would be thousands of writes to store a fact two timestamps
-- already contain.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Reactions
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_message_reactions (
  message_id INTEGER     NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  reaction   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (message_id, user_id, reaction),

  -- Six, matching what the picker offers. Adding a seventh is one line here and
  -- one in the UI's map; the CHECK is what stops the column drifting into free
  -- text in between.
  CONSTRAINT chat_message_reactions_known CHECK (
    reaction IN ('up', 'heart', 'haha', 'wow', 'sad', 'thanks')
  )
);

/* Reading a thread page asks "what is on these fifty messages", so the index
   leads on message_id. The primary key already covers that, but it leads on
   message_id too, so no second index is needed — noted here so nobody adds one
   for the same access path. */

COMMENT ON TABLE chat_message_reactions IS
  'One row per (message, person, reaction). The three-column primary key is '
  'deliberate: somebody may react twice with DIFFERENT reactions and never twice '
  'with the same one.';

COMMENT ON COLUMN chat_message_reactions.reaction IS
  'A short ASCII key, never the emoji character. The UI maps key to character. '
  'Keeps the set closed by CHECK, keeps the value greppable, and keeps '
  'surrogate pairs and unicode normalisation — where two identical-looking '
  'hearts are different byte strings — out of a primary key.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Delivery cursor
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_reads ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

COMMENT ON COLUMN chat_reads.delivered_at IS
  'How far this user''s client has FETCHED. Written by every listMessages call; '
  'read_at is written only when document.visibilityState is visible. So '
  'delivered means their browser has it and read means a person was looking — '
  'the two-grey-ticks / two-teal-ticks distinction, without inventing either.';

/* Backfill: every existing read_at is also a delivery — you cannot have read
   something that was not delivered. Guarded, and it only ever moves the cursor
   forward, so re-running this migration cannot walk it backwards. */
UPDATE chat_reads
   SET delivered_at = read_at
 WHERE read_at IS NOT NULL
   AND (delivered_at IS NULL OR delivered_at < read_at);

COMMIT;
