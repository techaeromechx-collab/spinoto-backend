-- Migration 151: wa_automations — one table for "when X happens, send Y".
--
-- Before this, which template fired on which event lived in THREE places:
--
--   trigger_status_slug   on wa_templates  (appointment status transitions)
--   trigger_lead_status   on wa_templates  (lead status transitions)
--   eight controllers hardcoding template keys (created / approved / paid / …)
--
-- The first two could each point ONE template at ONE status, the third needed
-- a deploy to change, and no screen could show all of it at once. This table
-- replaces all three READ paths with rows an admin can see, add, pause and
-- delete in Settings → WhatsApp → Automations.
--
-- What does NOT change: the dispatcher. notifyWhatsApp still owns variable
-- resolution, the refusal on blank variables, the dedupe index and the
-- transactional queue. The template's is_enabled + auto_send toggles remain
-- the master switches (the dispatcher enforces auto_send for automatic
-- sends) — an automation pointing at a switched-off template is quietly
-- inert, exactly as a status trigger was.
--
-- The event list is a CLOSED VOCABULARY defined in
-- services/whatsappAutomations.service.js (AUTOMATION_EVENTS) — every event
-- names a real call site in code. It is deliberately not a table: an event
-- with no code firing it would be a row promising something that cannot
-- happen.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_automations (
    id           SERIAL PRIMARY KEY,

    -- 'appointment.status_changed', 'invoice.paid', … — a key of
    -- AUTOMATION_EVENTS. Validated in the controller, not by FK or CHECK,
    -- because the vocabulary lives in code and a DB constraint would need a
    -- migration every time an event is added.
    event        VARCHAR(60)  NOT NULL,

    -- For *.status_changed events: the appointment status SLUG or the lead
    -- status NAME this automation matches (the same identifiers the old
    -- trigger columns held, for the same reasons — see migrations 110 & 116).
    -- NULL for events with no dimension to match (invoice.paid fires on every
    -- paid invoice). Matched with IS NOT DISTINCT FROM at fire time.
    match_value  VARCHAR(100),

    template_id  INTEGER      NOT NULL REFERENCES wa_templates(id) ON DELETE CASCADE,

    -- Who receives it. Only 'customer' exists today — staff notifications are
    -- the push system's job — but the column is here so a second recipient
    -- kind is a value, not a schema change.
    recipient    VARCHAR(20)  NOT NULL DEFAULT 'customer'
                 CHECK (recipient IN ('customer')),

    -- When it sends relative to the event. Only 'immediate' exists today; a
    -- delayed send needs scheduler work this table should not pretend exists.
    timing       VARCHAR(20)  NOT NULL DEFAULT 'immediate'
                 CHECK (timing IN ('immediate')),

    -- Pause without deleting. The template's own toggles still gate sending;
    -- this switches off ONE pairing while the template stays usable elsewhere.
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,

    created_by   INTEGER      REFERENCES users(id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One row per (event, match, template). COALESCE because match_value is NULL
-- for eventless matches and NULLs compare DISTINCT in a unique index — without
-- it the same invoice.paid → template pairing could be added without limit,
-- and every copy would burn one 'duplicate' dispatcher refusal per event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_automations_identity
  ON wa_automations (event, COALESCE(match_value, ''), template_id);

-- The fire-time read: WHERE event = $1 AND is_active.
CREATE INDEX IF NOT EXISTS idx_wa_automations_event
  ON wa_automations (event)
  WHERE is_active;

COMMENT ON TABLE wa_automations IS
  'When EVENT happens (optionally matching match_value), send template_id to the customer. Read at fire time by whatsappAutomations.service.js; the dispatcher''s toggles still gate every send.';
COMMENT ON COLUMN wa_automations.event IS
  'Closed vocabulary from AUTOMATION_EVENTS in whatsappAutomations.service.js — every event names a call site in code.';
COMMENT ON COLUMN wa_automations.match_value IS
  'appointment status SLUG or lead status NAME for *.status_changed events; NULL otherwise. NULL matches only the no-dimension events (IS NOT DISTINCT FROM).';

CREATE OR REPLACE FUNCTION set_wa_automations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_automations_updated_at ON wa_automations;
CREATE TRIGGER trg_wa_automations_updated_at
  BEFORE UPDATE ON wa_automations
  FOR EACH ROW EXECUTE FUNCTION set_wa_automations_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- Carry the existing configuration across. Nothing an admin set up stops
-- working: every populated trigger column becomes a row, and every code-fired
-- template gets the row its call site now looks up.
-- ─────────────────────────────────────────────────────────────────────────────

-- Appointment status triggers.
INSERT INTO wa_automations (event, match_value, template_id, is_active)
SELECT 'appointment.status_changed', t.trigger_status_slug, t.id, TRUE
  FROM wa_templates t
 WHERE t.is_active AND t.trigger_status_slug IS NOT NULL
ON CONFLICT DO NOTHING;

-- Lead status triggers.
INSERT INTO wa_automations (event, match_value, template_id, is_active)
SELECT 'lead.status_changed', t.trigger_lead_status, t.id, TRUE
  FROM wa_templates t
 WHERE t.is_active AND t.trigger_lead_status IS NOT NULL
ON CONFLICT DO NOTHING;

-- Code-fired templates → their events. Keyed on template_key because that is
-- exactly what the call sites hardcoded until now.
INSERT INTO wa_automations (event, match_value, template_id, is_active)
SELECT v.event, NULL, t.id, TRUE
  FROM (VALUES
    ('appointment_created',    'appointment.created'),
    ('appointment_reschedule', 'appointment.rescheduled'),
    ('estimate_approval',      'estimate.sent'),
    ('estimate_approve',       'estimate.customer_approved'),
    ('invoice_ready',          'invoice.approved'),
    ('invoice_paid',           'invoice.paid'),
    ('payment_received',       'payment.received'),
    ('advance_receipt',        'payment.advance_received')
  ) AS v(key, event)
  JOIN wa_templates t ON t.template_key = v.key AND t.is_active
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- supports_auto now means "has at least one automation". Resync it — and
-- because the CHECK requires auto_send ⇒ supports_auto, switch auto_send off
-- FIRST wherever the flag is about to go false. Those templates had auto_send
-- on with nothing that could ever fire them, so nothing observable changes.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE wa_templates t
   SET auto_send = FALSE
 WHERE t.is_active
   AND t.auto_send
   AND NOT EXISTS (SELECT 1 FROM wa_automations a WHERE a.template_id = t.id);

UPDATE wa_templates t
   SET supports_auto = EXISTS (SELECT 1 FROM wa_automations a WHERE a.template_id = t.id)
 WHERE t.is_active;

-- The old columns stay, unread, for rollback comfort. They are no longer
-- consulted at fire time and the Settings screen no longer writes them.
COMMENT ON COLUMN wa_templates.trigger_status_slug IS
  'DEPRECATED since migration 151 — superseded by wa_automations (event appointment.status_changed). Not read at fire time.';
COMMENT ON COLUMN wa_templates.trigger_lead_status IS
  'DEPRECATED since migration 151 — superseded by wa_automations (event lead.status_changed). Not read at fire time.';

COMMIT;
