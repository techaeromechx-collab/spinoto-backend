-- 201_chat_group_management.sql
--
-- Managing a group after it exists: rename it, change who is in it, archive it,
-- pin it, and SAY SO IN THE THREAD.
--
-- ══ THREE ADDITIONS, AND THE THIRD IS THE ONE TO READ ══════════════════════
--
--   chat_conversations.archived_at / archived_by   a group put beyond writing
--   chat_participants.pinned_at                   per-user ordering
--   chat_messages.system_event / system_target_id  "Ana added Ben"
--
-- Additive only. No column dropped, no data rewritten, no trigger. Everything
-- here is nullable and every query that exists today returns the same rows
-- after it as before — except ONE, deliberately: UNREAD_SQL now excludes system
-- events, for the reason given under system_event below.
--
-- ══ WHY ARCHIVE AND DELETE ARE BOTH HERE ═══════════════════════════════════
--
-- chat_participants, chat_messages, chat_reads and chat_message_reactions all
-- reference their parent ON DELETE CASCADE, so `DELETE FROM chat_conversations
-- WHERE id = $1` already removes a whole group and everything anybody ever said
-- in it, in one statement, irretrievably. That capability exists whether or not
-- a button is wired to it.
--
-- So archive is not a softer delete offered instead — it is the DEFAULT, and the
-- hard delete stays behind MANAGE_CHAT and a typed confirmation, because the
-- thing being destroyed is mostly other people's writing.
--
-- Archived is not the same as dismissed. Dismissed is one person clearing one
-- row from their own list and it comes back on the next message (chat_reads.
-- dismissed_at). Archived is the conversation itself going read-only for
-- everybody, and nothing brings it back but restoring it.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_conversations: archived
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id);

/* A timestamp and an actor, not a boolean. "Where did our group go" is a
   question somebody will ask, and `archived = true` cannot answer it. The same
   reason chat_participants keeps left_at instead of deleting the row. */
COMMENT ON COLUMN chat_conversations.archived_at IS
  'Set when a group is archived: it disappears from every list and goes '
  'READ-ONLY for everybody, including MANAGE_CHAT. Restoring clears it. NULL '
  'for a live conversation, and always NULL for kind=direct — a direct thread '
  'is cleared per person via chat_reads.dismissed_at, never archived for both.';

COMMENT ON COLUMN chat_conversations.archived_by IS
  'Who archived it. Kept when it is restored, so the last archiver is still '
  'answerable for it.';

/* Only groups can be archived. A direct thread belongs equally to two people
   and neither may put the other''s messages beyond reach — clearing it from
   your own list is the whole of what one person gets to decide. Without this
   the API is the only thing preventing it, and the API is one commit away from
   not preventing it. */
ALTER TABLE chat_conversations
  DROP CONSTRAINT IF EXISTS chat_conversations_archive_shape;
ALTER TABLE chat_conversations
  ADD CONSTRAINT chat_conversations_archive_shape CHECK (
    archived_at IS NULL OR kind = 'group'
  );

/* Partial, on the only version any list asks for. The recency index already
   exists (ix_chat_conversations_recent) and still serves the ordering; this one
   keeps the archived rows from being walked at all. */
CREATE INDEX IF NOT EXISTS ix_chat_conversations_live
  ON chat_conversations (id)
  WHERE archived_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_participants: pinned
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chat_participants
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

/* On the participant row, which is already keyed (conversation_id, user_id) —
   so a pin is one person's opinion about one thread and needs no new table.
   Putting it on chat_conversations would mean pinning a group for everybody in
   it, which is not what pinning is. */
COMMENT ON COLUMN chat_participants.pinned_at IS
  'This user has pinned this conversation to the top of their own list. A '
  'timestamp rather than a boolean so several pins order among themselves by '
  'when they were pinned. Per user: nobody else sees it.';

-- ═══════════════════════════════════════════════════════════════════════════
-- chat_messages: system events
-- ═══════════════════════════════════════════════════════════════════════════

/* ── WHY THE THREAD HAS TO SAY IT ───────────────────────────────────────────
 *
 * Without this, group membership changes silently. Somebody is added and reads
 * a conversation that was private a second ago with no line explaining why they
 * can; somebody is removed and simply stops replying, and the people left
 * behind cannot tell whether they walked out or were shown the door. A group
 * whose title changed under everybody is worse: the thread they were talking in
 * has a different name and nothing says who did it.
 *
 * ── WHY IT IS A MESSAGE AND NOT AN AUDIT TABLE ──
 * Because it has to appear IN the thread, in order, between the messages it
 * explains. A separate table would have to be merged into every page of the
 * thread by timestamp, and keyset pagination over a union of two tables is how
 * you get a page that skips a message. It is already a row with a conversation,
 * a sender, a timestamp and a place in the index — the only thing it lacks is
 * permission from the has_content constraint to carry no body.
 *
 * ── WHAT IS STORED, AND WHAT IS NOT ──
 * The EVENT and the TARGET'S ID, not a rendered sentence. "Ana added Ben" is
 * built at read time from users.name, so somebody who changes their name does
 * not leave a thread full of a name they no longer use. The one exception is
 * `renamed`, whose new title goes in `body`: the title at that moment is a
 * historical fact and looking it up live would print today's name onto the day
 * it changed. */
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS system_event     TEXT,
  ADD COLUMN IF NOT EXISTS system_target_id INTEGER REFERENCES users(id);

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_system_event_known;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_system_event_known CHECK (
    system_event IS NULL OR system_event IN (
      'added', 'removed', 'left', 'renamed', 'archived', 'restored'
    )
  );

/* `added`, `removed` and `left` are about a person; the other three are not,
   and a row claiming "renamed" with a target user id is a row nobody can render
   without guessing what it meant. */
ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_system_target_shape;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_system_target_shape CHECK (
    (system_event IN ('added', 'removed', 'left') AND system_target_id IS NOT NULL)
    OR
    (system_event IS NULL AND system_target_id IS NULL)
    OR
    (system_event IN ('renamed', 'archived', 'restored') AND system_target_id IS NULL)
  );

/* A system event must not also be a shared record. Two different kinds of thing
   in one row and the renderer has to pick. */
ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_system_not_ref;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_system_not_ref CHECK (
    system_event IS NULL OR ref_type IS NULL
  );

/* ── Widening has_content, for the second time and for the same kind of reason ─
 *
 * The rule is "a row must say something". It was written when the only ways to
 * say something were text and a pointer, and it has already been widened once,
 * for the soft delete that is supposed to say nothing. A system event says
 * plenty — it simply says it in a column rather than in prose, since the prose
 * is assembled per reader.
 *
 * The three-state list is spelled out rather than replaced by something looser,
 * because the value of this constraint is that an EMPTY row — no text, no
 * pointer, no event, not deleted — is still impossible to insert. */
ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_has_content;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_has_content CHECK (
    deleted_at IS NOT NULL
    OR system_event IS NOT NULL
    OR (body IS NOT NULL AND BTRIM(body) <> '')
    OR ref_type IS NOT NULL
  );

COMMENT ON COLUMN chat_messages.system_event IS
  'Non-NULL makes this a SYSTEM LINE rather than something somebody typed: '
  'sender_id is who did it, system_target_id is who it was done to. It does '
  'NOT count towards unread (UNREAD_SQL excludes it) — a colleague renaming a '
  'group is not a message anybody has to come back and read, and a badge that '
  'lights for it trains people to ignore the badge. It DOES move '
  'last_message_at, so somebody just added finds the group near the top of '
  'their list instead of at its creation date.';

COMMENT ON COLUMN chat_messages.system_target_id IS
  'The person added, removed, or who left. NULL for renamed/archived/restored. '
  'An id, not a name: the sentence is built at read time so a person who '
  'changes their name does not leave old lines quoting the old one.';

/* Threads are read newest-first through ix_chat_messages_thread, which this
   does not disturb: a system row is an ordinary row in that index. Nothing here
   needs an index of its own — nobody queries "all the renames". */

COMMIT;
