-- Migration 154: wa_send_skips — the record of messages that were REFUSED at
-- queue time, so "why didn't the customer get a message?" is answerable from
-- the Settings screen instead of only from a server terminal.
--
-- ── Why refusals were invisible ─────────────────────────────────────────────
--
-- The dispatcher deliberately writes NO wa_messages row when it refuses to
-- queue (missing variable, no messageable number, template off, …): a refusal
-- row would occupy the dedupe key and block the REAL send after the problem
-- is fixed. That design is correct — but it made every refusal a console.warn
-- and nothing else, and this owner spent a day debugging silent non-sends
-- (auto-send off, a hub with no map link, an unapproved invoice) that the
-- system knew the exact reason for at the moment it happened.
--
-- This table is that missing record. Append-only, separate from wa_messages,
-- so it cannot interfere with dedupe or the outbox. One row per refused
-- automation attempt, written by fireWhatsAppEvent under its own savepoint —
-- a failure to record a skip can never fail the caller's transaction or
-- discard messages that DID queue.
--
-- 'duplicate' is NOT recorded: it means the message already exists, which is
-- the system working, not a question anyone needs answered.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_send_skips (
    id           SERIAL PRIMARY KEY,

    -- The automation event that tried to send ('appointment.created', …).
    event        VARCHAR(60),

    template_key VARCHAR(40),

    -- Which record the send was for, same polymorphic shape as wa_messages.
    entity_type  VARCHAR(20),
    entity_id    INTEGER,

    -- The dispatcher's terse reason, verbatim: 'missing_variable:workshop_link',
    -- 'no_messageable_number', 'auto_send_off', 'template_disabled',
    -- 'entity_not_found', 'error', … The UI translates it to a sentence.
    reason       VARCHAR(120) NOT NULL,

    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The panel reads newest-first.
CREATE INDEX IF NOT EXISTS idx_wa_send_skips_recent
  ON wa_send_skips (id DESC);

COMMENT ON TABLE wa_send_skips IS
  'Automation sends REFUSED at queue time, with the dispatcher''s reason. Append-only; deliberately separate from wa_messages so a refusal can never occupy a dedupe key. Written by fireWhatsAppEvent under its own savepoint.';

COMMIT;
