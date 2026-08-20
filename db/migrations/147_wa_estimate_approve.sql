-- Migration 147: the "estimate approved" confirmation template, and the column
-- that says which kind of record a template belongs to.
--
-- ── Two templates, one letter apart ─────────────────────────────────────────
--
-- 117 seeded 'estimate_approval' (provider 'estimate_approval_'), which ASKS
-- the customer to approve and carries the estimate link. This adds
-- 'estimate_approve' (provider 'estimate_approve_'), which CONFIRMS an approval
-- that already happened. Opposite ends of the same conversation, and their
-- Interakt code names differ by two characters.
--
-- The keys are deliberately as close as the provider names, rather than being
-- renamed to something more distinct. The registry's job is to mirror Interakt
-- exactly; inventing a clearer local name here would mean the one string an
-- admin has to compare against the dashboard no longer matches it.
--
-- ── Why position 3 is estimate_amount and not amount ────────────────────────
--
-- The Interakt body reads "Approved amount: ₹{{amount}}". That label is display
-- text in the dashboard — the send API takes positional values, not names, and
-- Meta never sees our key. buildValues()'s estimate branch
-- (whatsapp.dispatcher.js) produces customer_name, vehicle, reg_number,
-- estimate_amount and estimate_link. There is no `amount` key for an estimate;
-- that one belongs to the advance branch. Registering 'amount' here would
-- resolve to undefined and the dispatcher would refuse to queue with
-- missing_variable:amount, forever, with the template looking correctly
-- configured.
--
-- ── supports_auto TRUE, but NOT via trigger_status_slug ─────────────────────
--
-- Migration 128 is the precedent and the warning. Settings → WhatsApp offers an
-- appointment-status trigger for every template, but fireStatusMessages()
-- always loads the APPOINTMENT context. estimate_approval was pointed at
-- 'estimate-created' and silently never sent — the trigger fired, the context
-- had no grand_total, and the dispatcher logged missing_variable:estimate_amount
-- on every attempt.
--
-- So trigger_status_slug stays NULL and the auto path is a code hook on the
-- customer-approval handler, where the estimate context is already loaded.
-- supports_auto is TRUE so the "send automatically" checkbox appears in
-- Settings; auto_send and is_enabled keep their FALSE defaults, so both boxes
-- start unticked and nothing reaches a customer until someone says so.

BEGIN;

INSERT INTO wa_templates
  (template_key, provider_template_name, language_code, variables,
   supports_auto, trigger_status_slug, body_preview)
SELECT * FROM (VALUES
  ('estimate_approve', 'estimate_approve_', 'en',
   '["customer_name","vehicle","estimate_amount"]'::jsonb,
   TRUE, NULL::varchar(60),
   'Hi {{customer_name}}, thank you for approving your estimate for {{vehicle}}. Approved amount: ₹{{amount}}. We''ll begin work and keep you posted.')
) AS seed(template_key, provider_template_name, language_code, variables,
          supports_auto, trigger_status_slug, body_preview)
WHERE NOT EXISTS (
  SELECT 1 FROM wa_templates t WHERE t.template_key = seed.template_key
);

-- ── Which record can send which template ────────────────────────────────────
--
-- WHAT WAS WRONG
--
-- whatsapp.messages.controller.js offered EVERY enabled template for EVERY
-- record: the query was `WHERE is_active AND is_enabled` with no reference to
-- entity_type at all. On a lead that meant "Advance Receipt" and "Invoice
-- Ready" appeared in the list, and picking one produced a 422 for a variable
-- the lead has no way to supply. The registry knew what each template needs and
-- had no way to say what it belongs to.
--
-- WHY AN ARRAY
--
-- Most templates belong to exactly one kind of record. call_not_received —
-- "Hi {{customer_name}}", one variable — belongs to two: you chase a cold lead
-- and you chase a booked appointment, and both contexts supply a name. A single
-- entity_type column would have forced a duplicate registry row for the same
-- Interakt template, and two rows that must be edited together are two rows
-- that will drift.
--
-- TEXT[] and not an enum: the valid set lives in ENTITY_TYPES in
-- whatsapp.messages.controller.js, which is also what validates the request.
-- A Postgres enum would be a second definition of the same list, and adding an
-- entity type would need a migration to stay in step with a JS constant.
ALTER TABLE wa_templates
  ADD COLUMN IF NOT EXISTS entity_types TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN wa_templates.entity_types IS
  'Which record types may send this template, e.g. {estimate} or {lead,appointment}. Must contain only values from ENTITY_TYPES in whatsapp.messages.controller.js. Empty means the template is offered nowhere — deliberate for a template that only ever fires from code.';

-- Backfill. Keyed on template_key, not id, and only where still empty, so
-- re-running this migration cannot overwrite a mapping someone has since
-- corrected in Settings.
UPDATE wa_templates SET entity_types = v.types
  FROM (VALUES
    ('call_not_received',      ARRAY['lead','appointment']),
    ('appointment_created',    ARRAY['appointment']),
    ('appointment_reschedule', ARRAY['appointment']),
    ('pickup_received',        ARRAY['appointment']),
    ('service_completed',      ARRAY['appointment']),
    ('invoice_ready',          ARRAY['invoice']),
    ('advance_receipt',        ARRAY['advance']),
    ('estimate_approval',      ARRAY['estimate']),
    ('estimate_approve',       ARRAY['estimate'])
  ) AS v(key, types)
 WHERE wa_templates.template_key = v.key
   AND wa_templates.entity_types = '{}';

-- A template with no mapping is invisible in every dropdown, which is a silent
-- failure of exactly the kind this column exists to prevent. Say so at migrate
-- time instead.
DO $$
DECLARE unmapped TEXT;
BEGIN
  SELECT string_agg(template_key, ', ' ORDER BY template_key) INTO unmapped
    FROM wa_templates WHERE is_active AND entity_types = '{}';
  IF unmapped IS NOT NULL THEN
    RAISE WARNING 'wa_templates: no entity_types set for: % — these will not be offered on any record until mapped.', unmapped;
  END IF;
END $$;

COMMIT;

-- Before switching this on in Settings → WhatsApp, confirm in Interakt that
-- the template's code name is exactly 'estimate_approve_' (trailing underscore)
-- and that its body takes THREE variables in this order: name, vehicle, amount.
-- A count mismatch is a 4xx no retry can fix. The right count in the wrong
-- order sends cleanly, to a real customer, with the vehicle in the amount slot.
