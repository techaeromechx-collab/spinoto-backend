-- 200_chat_replies.sql
--
-- Replying to a specific message.
--
-- ══ ONE NULLABLE COLUMN ════════════════════════════════════════════════════
--
-- In a group, "yes do that" three messages later is ambiguous — and it is
-- ambiguous in the record afterwards too, which is worse. A pointer to the
-- message being answered removes the ambiguity without a new table: a reply IS
-- a message, it just knows what it answers.
--
-- ── ON DELETE SET NULL, not CASCADE ──
-- Withdrawing a message must not delete every answer to it. The quote strip
-- disappears and the reply stays, which is what the author of the reply meant to
-- leave behind. CASCADE here would let one person delete somebody else's
-- messages by deleting their own.
--
-- ── No depth, deliberately ──
-- A reply to a reply stores its own parent and renders one quoted strip. There
-- is no thread tree, no indent level, and no recursion: the strip shows the one
-- message being answered, which is the question anybody actually has.

BEGIN;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_id INTEGER
  REFERENCES chat_messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN chat_messages.reply_to_id IS
  'The message this one answers, or NULL. ON DELETE SET NULL so withdrawing a '
  'message does not delete the replies to it. One level only — the UI renders a '
  'single quoted strip, never a tree.';

/* The lookup is "give me the quoted rows for this page of messages", i.e. by
   the PARENT's id, which the primary key already serves. This index is for the
   other direction — counting or finding replies TO a message — and is partial
   because the overwhelming majority of rows have no parent. */
CREATE INDEX IF NOT EXISTS ix_chat_messages_reply_to
  ON chat_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

COMMIT;
