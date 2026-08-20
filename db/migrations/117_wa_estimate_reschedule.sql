-- 117_wa_estimate_reschedule.sql
--
-- Two more approved templates: Estimate Approval and Reschedule.
--
-- Both seeded DISABLED, like the original five. Nothing reaches a customer
-- until someone switches it on in Settings → WhatsApp.
--
-- ── Trigger notes ────────────────────────────────────────────────────────────
--
-- estimate_approval → 'estimate-submitted' (036_appointment_status_workflow:24).
--   Submitting an estimate is exactly the moment the customer needs to see it.
--   NOT 'estimate-created', which is an internal draft state.
--
-- appointment_reschedule → no slug. Rescheduling changes the DATE, not the
--   status: appointments.controller.js writes original_scheduled_date /
--   rescheduled_at and leaves status_id alone. So there is no status transition
--   to hang it on, and it needs its own hook on the reschedule path. Left NULL
--   and manual-capable until that hook exists, rather than pointed at a status
--   that would fire at the wrong moment.
--
-- ── The estimate link is not yet resolvable ─────────────────────────────────
--
-- estimate_link needs a PUBLIC estimate page, which does not exist —
-- estimates.routes.js:37 puts /by-token/:token behind canView, the same way
-- customer invoices were before migration 109's stage-0a work.
--
-- Until that page exists the dispatcher will refuse to queue this template with
-- `missing_variable:estimate_link` rather than send a link to a login screen.
-- That is the intended behaviour, not a bug to work around.

BEGIN;

INSERT INTO wa_templates
  (template_key, provider_template_name, language_code, variables,
   supports_auto, trigger_status_slug, body_preview)
SELECT * FROM (VALUES
  ('estimate_approval', 'estimate_approval_', 'en',
   '["customer_name","vehicle","estimate_amount","estimate_link"]'::jsonb,
   TRUE, 'estimate-submitted'::varchar(60),
   'Hi {{customer_name}} — the estimate for your {{vehicle}} is ready. Amount: ₹{{estimate_amount}}. View: {{estimate_link}}'),

  ('appointment_reschedule', 'appointment_reshedule', 'en',
   '["customer_name","vehicle","date","time","service_type","workshop_link"]'::jsonb,
   TRUE, NULL::varchar(60),
   'Hi {{customer_name}} — your appointment for {{vehicle}} has been rescheduled to {{date}} at {{time}}.')
) AS seed(template_key, provider_template_name, language_code, variables,
          supports_auto, trigger_status_slug, body_preview)
WHERE NOT EXISTS (
  SELECT 1 FROM wa_templates t WHERE t.template_key = seed.template_key
);

COMMIT;

-- NOTE the provider name for #7 is 'appointment_reshedule' — one 's'.
-- That is how it is spelled in the Interakt URL, and the send API matches the
-- string exactly. Correcting the spelling here would produce
-- "No approved template found". Fix it in Interakt first if it bothers you,
-- then update this row from Settings → WhatsApp.
