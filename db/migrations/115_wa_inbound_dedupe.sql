-- 115_wa_inbound_dedupe.sql
--
-- Idempotency for inbound WhatsApp messages.
--
-- ── Why outbound already had this and inbound did not ────────────────────────
--
-- idx_wa_messages_dedupe (migration 111) is partial on
-- `direction = 'out' AND template_key IS NOT NULL`, which was right for what it
-- guards: a status transition firing twice. Inbound was excluded on purpose,
-- because a hand-typed reply is deliberate by definition and should never be
-- collapsed with another one.
--
-- That reasoning assumed inbound rows arrive from a source that cannot repeat.
-- They do not. They arrive from a webhook, and Interakt's signature covers the
-- request body ONLY — no timestamp, no nonce. So anyone who captures one valid
-- `message_received` request (a proxy log, an APM trace, a mirrored request)
-- can replay it indefinitely.
--
-- Without a guard that is an unbounded insert primitive, and worse: every
-- replay re-extends wa_conversations.window_expires_at by another 24 hours,
-- holding the free-form messaging window open for a number long after the
-- customer stopped writing.
--
-- The provider's own message id is the natural key — it is stable per message
-- and a replay carries the same one.
--
-- Partial and NULL-guarded so it constrains nothing else: outbound rows are
-- excluded, and an inbound row that somehow arrives without a provider id is
-- still storable rather than rejected.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_inbound_provider_id
  ON wa_messages (provider_message_id)
  WHERE direction = 'in' AND provider_message_id IS NOT NULL;

COMMENT ON INDEX idx_wa_messages_inbound_provider_id IS
  'Replay guard for the inbound webhook. Interakt signs the body but sends no nonce, so a captured request can be replayed indefinitely.';

COMMIT;
