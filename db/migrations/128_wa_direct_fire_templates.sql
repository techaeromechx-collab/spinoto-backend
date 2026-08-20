-- Migration 128: clear the appointment-status trigger on the two templates
-- that are fired from code.
--
-- WHAT WAS WRONG
-- ──────────────
-- Settings → WhatsApp offers an appointment-status dropdown for every template.
-- For most of them that is exactly right: the message needs a customer name, a
-- vehicle, a date, a time, a service and a workshop link, and every one of
-- those comes from the appointment whose status just changed.
--
-- These two are the first templates that need data from somewhere else, and
-- picking a status for them looked like configuring them while quietly
-- guaranteeing they would never send:
--
--   estimate_approval      was pointed at 'estimate-created'.
--     The trigger fired, but fireStatusMessages() always loads the APPOINTMENT
--     context — which has no grand_total and no estimate token. So
--     estimate_amount and estimate_link both resolved to undefined and the
--     dispatcher refused to queue, logging missing_variable:estimate_amount.
--     It now fires from estimates.controller.js companyApprove() with
--     entityType 'estimate', where both values exist.
--
--   appointment_reschedule was pointed at 'rescheduled'.
--     Nothing ever advanced an appointment to that slug through
--     advanceAppointmentStatus() — appointments.controller.js writes status_id
--     directly in the UPDATE. So fireStatusMessages() was never called and the
--     template was silent, with nothing in the log to say why. It now fires
--     from the reschedule path itself.
--
-- Migration 117 predicted both of these in its header. The dropdown was set
-- afterwards, in good faith, because an empty control reads as unfinished
-- configuration rather than as a deliberate state.
--
-- WHY NULL IS THE CORRECT VALUE
-- ─────────────────────────────
-- NULL here does not mean "no automation". It means "not fired by an
-- appointment status transition" — exactly what invoice_ready has carried since
-- migration 110, and that template has always sent correctly from
-- customer_invoices.controller.js. auto_send stays untouched: these templates
-- remain automatic, they are simply triggered by an event the status machine
-- does not model.
--
-- Leaving a slug set would also produce a second, doomed send attempt on every
-- status change — harmless, because the missing-variable guard stops it, but it
-- fills the log with a failure that looks like the real thing.
--
-- The Settings screen now shows a fixed "fires when…" label instead of a
-- dropdown for these, so the same well-intentioned edit cannot happen again.

UPDATE wa_templates
   SET trigger_status_slug = NULL,
       updated_at = NOW()
 WHERE template_key IN ('estimate_approval', 'appointment_reschedule')
   AND trigger_status_slug IS NOT NULL;

COMMENT ON COLUMN wa_templates.trigger_status_slug IS
  'appointment_statuses.slug that fires this template, or NULL when it is fired from code instead. NULL is not "manual" — invoice_ready, estimate_approval and appointment_reschedule are all automatic, they are simply triggered by events the appointment status machine does not model (an invoice being approved, an estimate being sent to the customer, a booking being moved). A template whose variables cannot be resolved from an appointment MUST have NULL here: a status trigger always loads the appointment context, so it would fail the missing-variable check on every fire.';
