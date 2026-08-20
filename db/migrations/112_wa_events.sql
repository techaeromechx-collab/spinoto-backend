-- 112_wa_events.sql
--
-- Raw webhook receipts. Append-only, never updated, never interpreted before
-- it is written.
--
-- The point is not analytics. When Interakt changes a payload shape — and a
-- BSP sitting between us and Meta will — this is the only thing that can answer
-- "what did they actually send us?" A parser that silently stopped matching
-- leaves no other trace.
--
-- Written for EVERY webhook, including ones referring to messages we do not
-- recognise. An unmatched event is itself the interesting signal: it usually
-- means a message went out from the Interakt dashboard rather than from here.
--
-- See docs/whatsapp-integration-plan.md §6.3.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_events (
    id                  BIGSERIAL   PRIMARY KEY,

    -- Nullable: some payloads (inbound messages, account notifications) carry
    -- no outbound message id at all.
    provider_message_id VARCHAR(120),

    -- As received. Deliberately not a CHECK constraint — an unknown event type
    -- must still be storable, or the one case worth investigating is the one
    -- case that fails to insert.
    event_type          VARCHAR(40),

    payload             JSONB       NOT NULL,

    -- Set once the event has been applied to wa_messages. Rows that stay NULL
    -- are the ones to look at.
    processed_at        TIMESTAMPTZ,
    process_error       TEXT,

    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_events_provider_id
  ON wa_events (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_events_received
  ON wa_events (received_at DESC);

-- Unprocessed / errored events, for the diagnostics view.
CREATE INDEX IF NOT EXISTS idx_wa_events_unprocessed
  ON wa_events (received_at DESC)
  WHERE processed_at IS NULL;

COMMENT ON TABLE wa_events IS
  'Append-only raw webhook log. Written before interpretation so a payload change is discoverable rather than silent.';
COMMENT ON COLUMN wa_events.processed_at IS
  'NULL means the event was stored but not applied — unrecognised message id, or a parse failure recorded in process_error.';

COMMIT;
