-- 110_wa_templates.sql
--
-- The WhatsApp template REGISTRY.
--
-- This table does not store templates. Meta stores templates; editing one there
-- sends it back through approval. What this holds is a pointer to an approved
-- template plus the mapping that says how to fill it — which is the part Meta
-- has no opinion about and Interakt cannot tell us.
--
-- See docs/whatsapp-integration-plan.md §6.1.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_templates (
    id                     SERIAL PRIMARY KEY,

    -- Stable key used in code. Never Interakt's name — that is a display string
    -- an admin can change in a dashboard we do not control.
    template_key           VARCHAR(40)  NOT NULL,

    -- The exact "code name" from app.interakt.ai/template/<code>/view.
    -- This is what the send API matches on; a typo here is a 404 at send time.
    provider_template_name VARCHAR(120) NOT NULL,

    -- 'en' and 'en_US' are DIFFERENT templates to Meta, not variants of one.
    language_code          VARCHAR(10)  NOT NULL DEFAULT 'en',

    category               VARCHAR(20)  NOT NULL DEFAULT 'UTILITY',

    -- ── The mapping ──────────────────────────────────────────────────────────
    --
    -- Ordered array of canonical variable keys, e.g.
    --   ["customer_name","vehicle","date","reg_number","time","service_type","workshop_link"]
    --
    -- Position IS the contract: variables[0] becomes bodyValues[0]. Interakt
    -- exposes no API to read a template's definition, so this order is
    -- transcribed by a human from the dashboard.
    --
    -- Get it wrong and nothing errors. The message sends, with the vehicle in
    -- the date slot, to a real customer. That is why the registry UI has a
    -- "send test to my number" button and why manual sends preview the filled
    -- body — they are the only checks that exist.
    variables              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    header_variables       JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- Human-readable copy of the body, for the registry screen only.
    -- NOT authoritative and never parsed — Meta's copy is the real one, and
    -- this one goes stale the moment somebody edits the template there.
    body_preview           TEXT,

    -- ── The two toggles ──────────────────────────────────────────────────────
    --
    -- Two, not one, because "enabled but manual only" is a state you actually
    -- want — it is how a template gets used while its mapping is still being
    -- trusted.
    --
    --   is_enabled=false                 → invisible everywhere. Kill switch.
    --   is_enabled=true,  auto_send=false → staff may send it; nothing fires.
    --   is_enabled=true,  auto_send=true  → fires on its trigger + manual.
    --
    -- Both default FALSE: a freshly seeded registry sends nothing until somebody
    -- deliberately turns it on.
    is_enabled             BOOLEAN      NOT NULL DEFAULT FALSE,
    auto_send              BOOLEAN      NOT NULL DEFAULT FALSE,

    -- FALSE for templates with no automatic trigger (call_not_received). Lets
    -- the UI disable the auto toggle rather than silently ignore it, so nobody
    -- switches it on and then waits for messages that were never going to come.
    supports_auto          BOOLEAN      NOT NULL DEFAULT TRUE,

    -- ── What fires this template ─────────────────────────────────────────────
    --
    -- appointment_statuses.slug, from 036_appointment_status_workflow.sql:10 —
    -- already UNIQUE, already indexed (:39), and already the key the app
    -- advances by (estimates.controller.js:1922 →
    -- advanceAppointmentStatus(apptId, 'work-completed')).
    --
    -- Deliberately NOT a foreign key. A slug is stable configuration, not a
    -- reference: an FK here would make deleting an unused status fail with a
    -- constraint error from a table nobody expects, and a template pointing at
    -- a slug that no longer exists should degrade to "never fires", not block
    -- master data edits. The dispatcher resolves it at send time and logs a
    -- miss.
    --
    -- NULL for templates fired by something other than an appointment status
    -- transition (invoice_ready fires on invoice issue; call_not_received is
    -- manual).
    trigger_status_slug    VARCHAR(60),

    -- "Why did customers stop getting appointment messages?" is otherwise
    -- unanswerable — someone flipped a toggle three weeks ago and nobody
    -- remembers. One column turns that into a lookup.
    auto_send_changed_by   INTEGER      REFERENCES users(id),
    auto_send_changed_at   TIMESTAMPTZ,

    is_active              BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by             INTEGER      REFERENCES users(id),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT wa_templates_auto_requires_support
      CHECK (auto_send = FALSE OR supports_auto = TRUE)
);

-- One live template per key+language. Superseded rows stay for history with
-- is_active = FALSE, so a message sent last year can still say which definition
-- produced it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_templates_key_lang_active
  ON wa_templates (template_key, language_code)
  WHERE is_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_templates_provider_name_active
  ON wa_templates (provider_template_name, language_code)
  WHERE is_active;

COMMENT ON TABLE  wa_templates IS
  'Pointer + variable mapping for templates approved at Meta. Never the source of truth for body text.';
COMMENT ON COLUMN wa_templates.variables IS
  'Ordered canonical keys. Index = Interakt bodyValues position. Transcribed by hand; verify with a test send.';
-- Note the CHECK above enforces only the supports_auto half. is_enabled is
-- deliberately NOT in it: hitting the kill switch on a template must not also
-- clear auto_send, or turning it back on would silently leave automation off.
-- The dispatcher therefore tests `is_enabled AND auto_send` itself.
COMMENT ON COLUMN wa_templates.auto_send IS
  'Fires on its trigger. The dispatcher requires is_enabled AND auto_send; only the supports_auto half is enforced by CHECK.';
COMMENT ON COLUMN wa_templates.trigger_status_slug IS
  'appointment_statuses.slug that fires this template. Not an FK — a dangling slug means "never fires", it must not block deleting a status.';


-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_wa_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_templates_updated_at ON wa_templates;
CREATE TRIGGER trg_wa_templates_updated_at
  BEFORE UPDATE ON wa_templates
  FOR EACH ROW EXECUTE FUNCTION set_wa_templates_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed — the five approved templates, all OFF
-- ─────────────────────────────────────────────────────────────────────────────
--
-- provider_template_name values are the real Interakt code names, read from the
-- URL at app.interakt.ai/template/<codename>/view.
--
-- The TRAILING UNDERSCORES are part of the name, not a typo and not padding —
-- 'cnr_', 'appointment_booked_', 'service_completed_', 'invoice_'. The send API
-- matches this string exactly; trimming one is a "template not found".
--
-- variables order is derived from the approved body text, since Meta numbers
-- {{1}}, {{2}}, … in the order they appear. It is still UNVERIFIED against the
-- live templates and MUST be confirmed with a test send before auto_send is
-- switched on for any of these — a wrong order does not error, it just sends
-- the customer their registration number where the date should be.
--
-- trigger_status_slug values come from 036_appointment_status_workflow.sql:22-31.
-- 'at-workshop' rather than 'vehicle-picked' for the pickup template, because
-- the message says "picked up AND received at our workshop" — sending it the
-- moment the driver collects the vehicle would be a claim about where it is
-- that is not yet true.
--
-- Guarded with NOT EXISTS rather than ON CONFLICT DO NOTHING. The unique index
-- is partial on is_active, so once an admin retires a seeded row the conflict
-- target stops matching and a re-run would resurrect a deliberately killed
-- template as a fresh active TODO_ placeholder.

INSERT INTO wa_templates
  (template_key, provider_template_name, language_code, variables,
   supports_auto, trigger_status_slug, body_preview)
SELECT * FROM (VALUES
  ('call_not_received', 'cnr_', 'en',
   '["customer_name"]'::jsonb, FALSE, NULL::varchar(60),
   'Hi {{customer_name}} — we tried calling you, but you missed our call.'),

  ('appointment_created', 'appointment_booked_', 'en',
   '["customer_name","vehicle","date","reg_number","time","service_type","workshop_link"]'::jsonb,
   TRUE, NULL::varchar(60),
   'Hi {{customer_name}} — your appointment has been created for {{vehicle}}.'),

  ('pickup_received', 'pickup_received_at_workshop', 'en',
   '["customer_name","vehicle"]'::jsonb, TRUE, 'at-workshop'::varchar(60),
   'Hi {{customer_name}} — your {{vehicle}} has been picked up and received at our workshop.'),

  -- Two variables, not one. The first draft of this seed had only
  -- customer_name, taken from a copy of the template text that turned out to
  -- be out of date; the approved body reads "Your {{vehicle}} service has been
  -- completed". Interakt caught it on the first test send with
  -- "expected number of values are 2" — which is the count check doing its job,
  -- and a reminder that it is only a COUNT check: it would have accepted these
  -- two values in either order without complaint.
  ('service_completed', 'service_completed_', 'en',
   '["customer_name","vehicle"]'::jsonb, TRUE, 'work-completed'::varchar(60),
   'Hi {{customer_name}} — your {{vehicle}} service has been completed successfully.'),

  ('invoice_ready', 'invoice_', 'en',
   '["customer_name","invoice_link"]'::jsonb, TRUE, NULL::varchar(60),
   'Hi {{customer_name}} — your invoice is ready: {{invoice_link}}')
) AS seed(template_key, provider_template_name, language_code, variables,
          supports_auto, trigger_status_slug, body_preview)
WHERE NOT EXISTS (
  SELECT 1 FROM wa_templates t WHERE t.template_key = seed.template_key
);

COMMIT;
