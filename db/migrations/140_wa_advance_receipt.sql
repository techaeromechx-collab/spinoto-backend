-- Migration 140: the advance receipt WhatsApp template.
--
-- Seeded DISABLED, like every template before it. Nothing reaches a customer
-- until someone switches it on in Settings → WhatsApp.
--
-- ── Why it fires on the PAYMENT, not the estimate ───────────────────────────
-- entity_id is the ledger payment id. One job can take two advances, each with
-- its own numbered voucher, and keying the message on the estimate would make
-- the second look like a duplicate of the first — the dedupe index would swallow
-- it and the customer would never receive the second receipt.
--
-- ── Why there is no refund template here ────────────────────────────────────
-- A refund is a conversation, not a notification. By the time money is going
-- back, someone has already spoken to the customer — and an automated "here is
-- your refund voucher" arriving before the money does reads as the refund
-- having completed. The voucher is a link an advisor sends deliberately.
--
-- ── The link resolves ───────────────────────────────────────────────────────
-- Unlike the estimate template when it was first seeded, receipt_link points at
-- a route that exists: /advance/<token> is public unconditionally (App.jsx) and
-- served by GET /api/public/documents/advance/:token. If PUBLIC_APP_URL is
-- unset the dispatcher refuses to queue rather than sending a link to nowhere,
-- which is the intended behaviour.

INSERT INTO wa_templates
  (template_key, provider_template_name, language_code, variables,
   supports_auto, trigger_status_slug, body_preview)
SELECT * FROM (VALUES
  ('advance_receipt', 'advance_receipt', 'en',
   '["customer_name","amount","voucher_no","balance_due","receipt_link"]'::jsonb,
   TRUE, NULL::varchar(60),
   'Hi {{customer_name}} — we have received ₹{{amount}} as an advance. Receipt {{voucher_no}}. Balance on the job: ₹{{balance_due}}. Your receipt: {{receipt_link}}')
) AS seed(template_key, provider_template_name, language_code, variables,
          supports_auto, trigger_status_slug, body_preview)
WHERE NOT EXISTS (
  SELECT 1 FROM wa_templates t WHERE t.template_key = seed.template_key
);

-- The provider template must exist in Interakt under this exact name before the
-- toggle is switched on, with five body variables in this order. A mismatch is
-- a 4xx from the provider, which no retry can fix.
