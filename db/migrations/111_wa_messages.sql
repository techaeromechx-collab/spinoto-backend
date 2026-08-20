-- 111_wa_messages.sql
--
-- The outbox. One row per message, outbound or inbound.
--
-- Nothing sends inside an HTTP request. A controller writes a queued row in the
-- same transaction as the status change that caused it, and a worker picks it
-- up. That is what makes "the appointment saved but the message vanished"
-- impossible, and what stops a slow Interakt from holding a user's request open.
--
-- See docs/whatsapp-integration-plan.md §6.2 and §7.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_messages (
    id                   SERIAL PRIMARY KEY,

    template_id          INTEGER     REFERENCES wa_templates(id),

    -- Denormalised on purpose. A template row can be superseded; the record of
    -- what was sent must still say which template it was, years later.
    template_key         VARCHAR(40),

    direction            VARCHAR(3)  NOT NULL DEFAULT 'out'
                         CHECK (direction IN ('out','in')),

    -- Polymorphic by design rather than five nullable FKs. Nothing joins from
    -- here in a hot path — the Messages tab looks up by (entity_type, entity_id)
    -- and that is the only read pattern.
    entity_type          VARCHAR(20),
    entity_id            INTEGER,

    -- E.164, normalised ONCE by utils/phone.js. Interakt upserts its contacts
    -- by phone number, so '+919876543210' and '9876543210' become two contacts
    -- in their dashboard — the same way customer_vehicles splits one vehicle's
    -- history across two spellings of a registration.
    to_number            VARCHAR(20) NOT NULL,

    -- ── Frozen at send time ──────────────────────────────────────────────────
    --
    -- Resolved values, and the body they produced. If the customer's name is
    -- corrected next week, THIS MUST NOT CHANGE. Re-deriving the body from live
    -- data at read time would turn an audit trail into a guess.
    variables            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    body_rendered        TEXT,

    -- ── Status ladder ────────────────────────────────────────────────────────
    --
    -- queued < sent < delivered < read, with failed terminal.
    --
    -- Webhooks arrive out of order — 'read' landing before 'delivered' is
    -- routine, not an error. The controller advances this MONOTONICALLY; a
    -- naive UPDATE ... SET status = $1 would show a message the customer has
    -- already read as merely delivered.
    status               VARCHAR(12) NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sent','delivered','read','failed','received')),

    provider_message_id  VARCHAR(120),
    error_code           VARCHAR(40),
    error_message        TEXT,

    attempts             INTEGER     NOT NULL DEFAULT 0,
    next_retry_at        TIMESTAMPTZ,

    -- NULL = fired automatically. This is the column that answers "did a person
    -- send this, or did we?"
    sent_by              INTEGER     REFERENCES users(id),

    -- Every template send is a billable conversation, and hubs are paid
    -- separately, so message volume needs to be attributable.
    hub_id               INTEGER     REFERENCES hubs(id),

    -- What makes a re-fire harmless.
    --   automatic → the transition identity, e.g. 'status:7'
    --   manual    → a timestamp bucket, so an advisor CAN deliberately resend
    dedupe_key           VARCHAR(60) NOT NULL DEFAULT '',

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_at            TIMESTAMPTZ,
    sent_at              TIMESTAMPTZ,
    delivered_at         TIMESTAMPTZ,
    read_at              TIMESTAMPTZ,
    failed_at            TIMESTAMPTZ
);

-- The real duplicate guard. The dispatcher also no-ops when old status = new
-- status, but a constraint is what makes a double send impossible rather than
-- merely unlikely: two concurrent requests that both pass the check still
-- cannot both write this row.
--
-- Partial on direction='out' — inbound messages have no template and no
-- meaningful dedupe identity.
--
-- COALESCE, not the bare columns. In a unique index NULLs compare as DISTINCT
-- (NULLS NOT DISTINCT is PG15+ and not assumed here), so nullable columns would
-- mean a row missing its entity_id could be inserted without limit — the guard
-- would silently not apply to exactly the rows most likely to be duplicated by
-- a retry.
--
-- AND template_key IS NOT NULL, though, or the fix overshoots. A free-form
-- reply inside the 24-hour window (see 113_wa_conversations.sql) has no
-- template, no entity and takes the default dedupe_key, so every one of them
-- would fold to the same tuple ('', 0, '') and the SECOND such message in the
-- system would fail on a unique violation. Templated sends are the only ones
-- with a meaningful identity to deduplicate; a hand-typed reply is deliberate
-- by definition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_dedupe
  ON wa_messages (
    template_key,
    COALESCE(entity_type, ''),
    COALESCE(entity_id, 0),
    dedupe_key
  )
  WHERE direction = 'out' AND template_key IS NOT NULL;

-- The worker's only query.
CREATE INDEX IF NOT EXISTS idx_wa_messages_worker
  ON wa_messages (status, next_retry_at)
  WHERE status IN ('queued','failed');

-- Webhook lookup.
CREATE INDEX IF NOT EXISTS idx_wa_messages_provider_id
  ON wa_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The Messages tab.
CREATE INDEX IF NOT EXISTS idx_wa_messages_entity
  ON wa_messages (entity_type, entity_id, created_at DESC);

-- Inbound routing + conversation lookup.
CREATE INDEX IF NOT EXISTS idx_wa_messages_number
  ON wa_messages (to_number, created_at DESC);

COMMENT ON TABLE  wa_messages IS
  'Outbox and inbound log. Rows are written in the same transaction as the event that caused them; a worker does the sending.';
COMMENT ON COLUMN wa_messages.variables IS
  'Frozen at send time. Never re-derived from live data — this is the audit record of what the customer actually received.';
COMMENT ON COLUMN wa_messages.status IS
  'Monotonic: queued < sent < delivered < read. failed is terminal. Never move backwards; webhooks arrive out of order.';
COMMENT ON COLUMN wa_messages.dedupe_key IS
  'Transition identity for automatic sends, timestamp bucket for manual. Backs the unique index that prevents double sends.';

COMMIT;
