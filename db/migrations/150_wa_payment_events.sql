-- Migration 150: the two missing money messages — invoice_paid and
-- payment_received.
--
-- Until now the customer heard from Spinoto when an invoice was APPROVED
-- (invoice_ready) and when an ADVANCE was taken (advance_receipt), and then
-- nothing when the actual money moved: a counter payment, a gateway capture,
-- a settled invoice all passed silently. These two rows close that gap.
--
--   invoice_paid      — fired by invoiceBalance.service.recalcInvoiceState()
--                       on the transition INTO 'paid'. That function is the
--                       single writer of invoice status, so one hook covers
--                       every path money can arrive by. Entity: invoice.
--                       Deduped on `paid:{invoice_id}` — once per invoice,
--                       ever, even if a refund drops it out of 'paid' and a
--                       new payment brings it back.
--
--   payment_received  — fired from addPayment (counter) and
--                       captureVerifiedPayment (gateway) after
--                       recalcInvoiceState, so the balance_due it carries
--                       already includes the payment it announces.
--                       Entity: payment (the LEDGER row — two part-payments
--                       are two receipts). Advances are excluded by the
--                       dispatcher's PAYMENT_CONTEXT (payment_type <>
--                       'advance'); they keep their own voucher template.
--
-- ── Both arrive OFF, like every template since 110 ──────────────────────────
--
-- provider_template_name values are PLACEHOLDERS. These templates must be
-- created and approved in Interakt first; then the code name is corrected on
-- the Settings → WhatsApp card (the field is editable there — migration 148's
-- whole point was that fixing a name must not need a migration). The enable
-- gate (last_tested_at) then forces a test send before either can reach a
-- customer, so a wrong placeholder cannot leak: an untested template cannot
-- be enabled, and a disabled template never sends.
--
-- Seeded here rather than left to the Add-template form for one reason: the
-- fire sites reference these template_key values verbatim. A key typed by
-- hand in the form ('invoicepaid', 'payment_recieved') would compile, save,
-- and never fire — with nothing anywhere to say why.

BEGIN;

INSERT INTO wa_templates
  (template_key, provider_template_name, language_code, variables,
   supports_auto, trigger_status_slug, entity_types, body_preview)
SELECT * FROM (VALUES
  ('invoice_paid', 'invoice_paid', 'en',
   '["customer_name","amount","invoice_link"]'::jsonb,
   TRUE, NULL::varchar(60), ARRAY['invoice']::text[],
   'Hi {{customer_name}} — we have received your payment in full. Amount: ₹{{amount}}. Your invoice: {{invoice_link}}. Thank you!'),

  ('payment_received', 'payment_received', 'en',
   '["customer_name","amount","balance_due"]'::jsonb,
   TRUE, NULL::varchar(60), ARRAY['payment']::text[],
   'Hi {{customer_name}} — we have received your payment of ₹{{amount}}. Remaining balance: ₹{{balance_due}}. Thank you!')
) AS seed(template_key, provider_template_name, language_code, variables,
          supports_auto, trigger_status_slug, entity_types, body_preview)
-- NOT EXISTS rather than ON CONFLICT, same reasoning as 110: the unique index
-- is partial on is_active, and a re-run must not resurrect a deliberately
-- retired row.
WHERE NOT EXISTS (
  SELECT 1 FROM wa_templates t WHERE t.template_key = seed.template_key
);

COMMIT;
