-- Migration 157: the flow's own messages belong in the conversation.
--
-- ── What is missing today ───────────────────────────────────────────────────
--
-- The thread shows two things: what the customer sent, and what the CRM sent.
-- It does not show the third participant. An Interakt workflow greets every
-- customer, asks them questions and offers them buttons, and none of it is
-- anywhere in this system — so an advisor opening a lead reads:
--
--     Support/Help
--     Other
--     Hi
--
-- Three answers with the questions removed. It looks like a customer typing
-- nonsense, when in fact they answered exactly what they were asked.
--
-- ── Why a column and not a template_key ─────────────────────────────────────
--
-- The obvious shortcut is template_key = 'bot'. It would be wrong twice:
-- template_key is a foreign concept here (there is no wa_template behind it),
-- and migration 111's unique index is built on
-- (template_key, entity_type, entity_id, dedupe_key) WHERE template_key IS NOT
-- NULL — so the second bot message on the same lead would be rejected as a
-- duplicate send.
--
-- origin says what it means and constrains nothing else.

BEGIN;

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS origin VARCHAR(10) NOT NULL DEFAULT 'crm'
  CHECK (origin IN ('crm', 'bot'));

COMMENT ON COLUMN wa_messages.origin IS
  'Who sent this. crm = this application (template or typed reply). bot = an Interakt workflow, ingested from workflow_response_update. Rendered differently, because an advisor must never think a person wrote the greeting.';

-- ── The idempotency guard, and it is not optional ───────────────────────────
--
-- workflow_response_update is CUMULATIVE. Every time the customer taps
-- anything, Interakt re-sends the ENTIRE conversation from the beginning — one
-- observed event carried three exchanges spanning six hours. Without this
-- index, a five-step flow with five taps would insert fifteen copies of the
-- greeting.
--
-- question.id is a UUID that stays the same across those re-sends, which is
-- exactly what makes it usable as the key.
--
-- Partial, and scoped to bot rows only: outbound CRM sends keep their own
-- guard from migration 111, and inbound keeps the one from 115. A bot row that
-- somehow arrives with no id is still storable rather than rejected — losing a
-- message is worse than storing it twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_bot_provider_id
  ON wa_messages (provider_message_id)
  WHERE direction = 'out' AND origin = 'bot' AND provider_message_id IS NOT NULL;

COMMENT ON INDEX idx_wa_messages_bot_provider_id IS
  'Replay guard for workflow_response_update, which re-sends the whole conversation on every step.';

COMMIT;
