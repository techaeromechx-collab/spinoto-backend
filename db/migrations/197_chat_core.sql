-- 197_chat_core.sql
--
-- Internal chat: staff talking to staff, and pointing at records.
--
-- ══ WHAT THIS IS NOT ═══════════════════════════════════════════════════════
--
-- Not WhatsApp. wa_conversations / wa_messages are a log of what was said to a
-- CUSTOMER through a third party, keyed by phone number, governed by Interakt's
-- 24-hour window and template rules. None of that applies to two advisors
-- talking about a car, and keying an internal thread by phone number would be
-- absurd. Separate tables.
--
-- It does borrow one thing from over there, and it is the most important
-- decision in this file: THE READ CURSOR. See chat_reads.
--
-- ══ NO MEDIA, DELIBERATELY ═════════════════════════════════════════════════
--
-- No file column, no image column, no attachment table. Not an omission to be
-- filled in later — the feature was specified without it, and the moment a
-- column exists to hold a key somebody will add an upload path to fill it.
-- Sharing a photo of a damaged bumper already has a home: the job card's media,
-- where it is attached to the car it belongs to instead of to a conversation
-- nobody will search in a year. What crosses chat is a POINTER to that record.
--
-- ══ FOUR TABLES ════════════════════════════════════════════════════════════
--
--   chat_conversations  a thread: a pair, or a named group
--   chat_participants   who is in it, including who used to be
--   chat_messages       what was said, and optionally what it points at
--   chat_reads          per-user cursors — where each person has read up to
--
-- Nothing existing is altered. No column added to users, none to
-- notifications, nothing dropped, nothing backfilled. An additive-only
-- migration cannot break a screen that works today, and ten of these are
-- already queued ahead of it (187-196) on a live database.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_conversations
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_conversations (
  id              SERIAL      PRIMARY KEY,
  kind            TEXT        NOT NULL CHECK (kind IN ('direct', 'group')),
  title           TEXT,
  dm_key          TEXT,
  created_by      INTEGER     NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,

  -- A group with no name is a list of people nobody can refer to in a
  -- sentence. A direct conversation with a name is two people who have
  -- renamed each other, which is not a thing this feature does.
  CONSTRAINT chat_conversations_title_shape CHECK (
    (kind = 'group'  AND title IS NOT NULL AND BTRIM(title) <> '')
    OR
    (kind = 'direct' AND title IS NULL)
  ),

  CONSTRAINT chat_conversations_dmkey_shape CHECK (
    (kind = 'direct' AND dm_key IS NOT NULL)
    OR
    (kind = 'group'  AND dm_key IS NULL)
  )
);

/* ── dm_key: the constraint that stops the worst bug this feature can have ──
 *
 * Two people must have exactly one direct thread. Without this, a double-click
 * on "Message Aman", or two colleagues opening each other at the same moment,
 * creates two rows. Both look like the conversation. Each person replies in
 * the one they happen to have open, neither sees the other's reply, and both
 * believe they have been ignored. Nothing errors and nothing looks broken.
 *
 * The key is LEAST(a,b) || ':' || GREATEST(a,b), computed in the controller so
 * that (4,9) and (9,4) produce the identical string. A partial unique index
 * then makes the duplicate impossible at the database rather than unlikely in
 * the application — the same shape as uq_estimates_appointment_original.
 *
 * Partial, because groups legitimately repeat: the same four people may have
 * as many differently-named groups as they like. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_conversations_dm_key
  ON chat_conversations (dm_key)
  WHERE kind = 'direct';

CREATE INDEX IF NOT EXISTS ix_chat_conversations_recent
  ON chat_conversations (last_message_at DESC NULLS LAST, id DESC);

COMMENT ON COLUMN chat_conversations.dm_key IS
  'LEAST(u1,u2)||'':''||GREATEST(u1,u2) for kind=direct, NULL for groups. '
  'Written by the controller; uq_chat_conversations_dm_key makes a second '
  'thread for the same pair impossible.';

/* last_message_at is denormalised so ordering the conversation list never
   touches chat_messages. It is written in the SAME TRANSACTION as the message
   insert, by the controller — not by a trigger. Nothing else in this schema
   uses triggers, and a trigger is a write that nobody reading the controller
   can see. */
COMMENT ON COLUMN chat_conversations.last_message_at IS
  'Denormalised ordering key, written alongside the message insert in the same '
  'transaction. NULL until the first message: a conversation is created lazily '
  'on first send, so this should rarely be NULL in practice.';

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_participants
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_participants (
  conversation_id INTEGER     NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         INTEGER     NOT NULL REFERENCES users(id),
  added_by        INTEGER     REFERENCES users(id),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at         TIMESTAMPTZ,
  muted           BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);

/* This index is the entry point for the conversation list — "which threads am
   I in" is the first query every chat screen runs. Partial on left_at IS NULL
   because that is the only version anybody lists. */
CREATE INDEX IF NOT EXISTS ix_chat_participants_user
  ON chat_participants (user_id)
  WHERE left_at IS NULL;

COMMENT ON COLUMN chat_participants.left_at IS
  'Set instead of deleting the row. Somebody who left a group still wrote the '
  'messages that are in it, and a DELETE would leave those messages with no '
  'explanation for why they are there. It is also the only way to answer "who '
  'could read this at the time it was sent".';

COMMENT ON COLUMN chat_participants.muted IS
  'Suppresses the push notification only. A muted conversation still counts as '
  'unread and still shows in the list — muting is "stop buzzing my phone", not '
  '"hide this from me", and conflating the two loses messages.';

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_messages
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_messages (
  id              SERIAL      PRIMARY KEY,
  conversation_id INTEGER     NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER     NOT NULL REFERENCES users(id),
  body            TEXT,
  ref_type        TEXT,
  ref_id          INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,

  /* Same idea as job_card_readings_has_a_number in 196: a row that says
     nothing should not be insertable. A LIVE message is some text, or a pointer
     at a record, or both — never neither.
     ── The deleted_at escape, and why it is not a loophole ────────────────
     A withdrawn message is SUPPOSED to carry nothing: the delete path nulls the
     body and the pointer, because a deleted message that still holds its text
     is deleted in name only, one query away from being read by the very person
     it was withdrawn from. Without this first line the constraint refused that
     update and soft-deleting a text-only message failed outright — which is
     exactly what it should have done, since the rule as first written said
     every row must say something and the delete path disagreed. The rule was
     right and incomplete. The state it was missing is this one. */
  CONSTRAINT chat_messages_has_content CHECK (
    deleted_at IS NOT NULL
    OR (body IS NOT NULL AND BTRIM(body) <> '')
    OR ref_type IS NOT NULL
  ),

  /* Half a pointer is worse than none: ref_type with no id renders a chip that
     can never resolve, and an id with no type cannot even be looked up. */
  CONSTRAINT chat_messages_ref_pair CHECK (
    (ref_type IS NULL AND ref_id IS NULL)
    OR
    (ref_type IS NOT NULL AND ref_id IS NOT NULL)
  ),

  /* The list is deliberately SHORT. A type belongs here only once a resolver
     exists that reproduces that record's real access rule — see the comment on
     ref_type. Adding a type is one line; adding it without its resolver is a
     data leak with a nice chip around it. */
  CONSTRAINT chat_messages_ref_type_known CHECK (
    ref_type IS NULL OR ref_type IN (
      'lead', 'appointment', 'job_card', 'estimate',
      'customer_invoice', 'purchase_invoice', 'customer', 'vehicle'
    )
  )
);

/* Serves both the thread page query and the newest-message lookup. The DESC on
   both columns matches the ORDER BY exactly, and id is in it because two
   messages can share a created_at — with only the timestamp, keyset paging
   would skip or repeat whichever of them landed on the page boundary. */
CREATE INDEX IF NOT EXISTS ix_chat_messages_thread
  ON chat_messages (conversation_id, created_at DESC, id DESC);

COMMENT ON COLUMN chat_messages.ref_type IS
  'A POINTER to a CRM record, never a copy of it. No label, no customer name, '
  'no amount, no plate, no phone number is stored here — so there is nothing '
  'in this row to leak if the viewer turns out not to have access. What the '
  'chip says is resolved per viewer, at render time, against the same '
  'permission check that record''s own screen uses. Receiving a pointer is not '
  'permission to open it.';

COMMENT ON COLUMN chat_messages.ref_id IS
  'Intentionally NOT a foreign key: the target table varies by ref_type and '
  'Postgres cannot express that. The consequence is a dangling pointer when a '
  'record is deleted, and the resolver returns exists=false so the chip reads '
  '"no longer exists". That is the right trade: a cascade would silently '
  'delete somebody''s message because a lead was tidied up.';

COMMENT ON COLUMN chat_messages.deleted_at IS
  'Soft delete. The body is nulled and the row stays, so the thread does not '
  'renumber underneath somebody who is reading it and the reply that answered '
  'this message still has something to sit under.';

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_reads
-- ═══════════════════════════════════════════════════════════════════════════

/* ── Cursors, not flags, and this is the decision worth reading ─────────────
 *
 * Borrowed wholesale from wa_conversation_reads (migrations 163/164), which
 * learned it the hard way. A boolean is_read on the conversation would mean:
 *
 *   an admin glancing at a thread clears the badge for everyone in it
 *   the first person to look at a group conversation clears it for the rest
 *   "dismiss" has to be UNSET from the write path for every user who had set
 *     it, and one missed update is a colleague's message landing somewhere
 *     nobody will look again
 *
 * A timestamp per (user, conversation) has none of those. Unread is arithmetic:
 * is there a message newer than where I read to. A dismissed conversation
 * comes back the moment somebody writes in it, with nothing written anywhere
 * and no cleanup to forget.
 *
 * A user who has never opened a conversation has NO ROW, which must mean
 * everything in it is unread. The queries therefore COALESCE to 'epoch' rather
 * than testing for NULL — and the missing-row case is the common one, because
 * it is every conversation nobody has opened yet. */
CREATE TABLE IF NOT EXISTS chat_reads (
  user_id         INTEGER     NOT NULL REFERENCES users(id),
  conversation_id INTEGER     NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, conversation_id)
);

COMMENT ON COLUMN chat_reads.read_at IS
  'Where this user has read up to. Absent row = epoch = everything unread.';

COMMENT ON COLUMN chat_reads.dismissed_at IS
  'Cleared from the list, which is not the same as read. Compared against the '
  'conversation''s newest message, so a new message brings it back by '
  'arithmetic with nothing written anywhere.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Retention, decided now rather than in two years
-- ═══════════════════════════════════════════════════════════════════════════

/* wa_events is at 316MB with no retention job and notifications has none
   either, which is how both got there: the table shipped, the sweep did not,
   and nobody was going to come back for it. Chat will outgrow both.
   scheduler.js gets the purge in the same change as this table. */
COMMENT ON TABLE chat_messages IS
  'Internal staff messages. RETENTION: soft-deleted rows are purged after 90 '
  'days by the sweep in src/scheduler.js. Live messages are kept indefinitely '
  'pending a business decision — when one is made, extend that same sweep '
  'rather than adding a second one.';

COMMENT ON TABLE chat_conversations IS
  'Internal staff chat threads. Direct threads are unique per pair via '
  'uq_chat_conversations_dm_key; groups are not.';

COMMIT;
