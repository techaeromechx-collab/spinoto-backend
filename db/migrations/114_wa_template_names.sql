-- 114_wa_template_names.sql
--
-- Replace the TODO_ placeholders seeded by 110 with the real Interakt code
-- names, read from the URL at app.interakt.ai/template/<codename>/view.
--
-- ── Why this is a separate migration and not an edit to 110 ──────────────────
--
-- 110 shipped with placeholders and was applied before the real names were
-- known. Its seed is guarded `WHERE NOT EXISTS (… template_key …)`, which makes
-- re-running it a no-op — correct, because that guard is what stops a re-run
-- resurrecting a template an admin has deliberately retired. So editing 110 in
-- place would fix nothing on any database that has already run it.
--
-- ── The trailing underscores are real ────────────────────────────────────────
--
-- 'cnr_', 'appointment_booked_', 'service_completed_', 'invoice_'. Not typos,
-- not padding. The send API matches this string exactly; trimming one produces
--   "No approved template found with name '…' and language 'en'".
--
-- ── The guard ────────────────────────────────────────────────────────────────
--
-- Each UPDATE only fires while the row still holds its placeholder. An admin
-- who has already corrected a name by hand in Settings → WhatsApp keeps their
-- value; re-running this file cannot overwrite it.

BEGIN;

UPDATE wa_templates SET provider_template_name = 'cnr_'
 WHERE template_key = 'call_not_received'
   AND provider_template_name = 'TODO_call_not_received';

UPDATE wa_templates SET provider_template_name = 'appointment_booked_'
 WHERE template_key = 'appointment_created'
   AND provider_template_name = 'TODO_appointment_created';

UPDATE wa_templates SET provider_template_name = 'pickup_received_at_workshop'
 WHERE template_key = 'pickup_received'
   AND provider_template_name = 'TODO_pickup_received';

UPDATE wa_templates SET provider_template_name = 'service_completed_'
 WHERE template_key = 'service_completed'
   AND provider_template_name = 'TODO_service_completed';

UPDATE wa_templates SET provider_template_name = 'invoice_'
 WHERE template_key = 'invoice_ready'
   AND provider_template_name = 'TODO_invoice_ready';

COMMIT;
