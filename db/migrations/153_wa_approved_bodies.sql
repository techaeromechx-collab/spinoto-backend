-- Migration 153: store the REAL approved template bodies, verbatim.
--
-- The registry's body_preview fields held short paraphrases written when the
-- rows were seeded. The owner supplied the actual approved texts (18 Aug
-- 2026), so the previews on the Templates cards and the WhatsApp preview
-- panel can finally show the message the customer really receives — emoji,
-- line breaks, sign-off and all.
--
-- body_preview is REFERENCE ONLY (never parsed for sending), so updating it
-- does not clear last_tested_at and does not touch is_enabled.
--
-- ── The variable-order guard ────────────────────────────────────────────────
--
-- The owner's approved bodies confirm the canonical order for every template.
-- Each order below was checked against the seeds and they MATCH — so on a
-- healthy database the variable UPDATEs are no-ops. They exist for the drifted
-- case: if a mapping was reordered by hand since seeding, it is corrected to
-- match the approved body, and because a corrected mapping is an UNTESTED
-- mapping, that row is also switched off and its test cleared — the same rule
-- the Settings screen applies to any mapping edit (migration 148). auto_send
-- is left alone: it re-arms the moment the template is re-tested and enabled.
--
-- The reschedule template is matched on BOTH keys: the seed created
-- 'appointment_reschedule', but a re-registration through the Add form derives
-- the key from the Interakt URL, where the code name is genuinely spelled
-- 'appointment_reshedule' (one 's').

BEGIN;

-- ── 1. Call Not Received ────────────────────────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'call_not_received' AND is_active
   AND variables <> '["customer_name"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer_name}} 👋
We tried calling you, but you missed our call.
You can call us on 7480033800.
Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'call_not_received' AND is_active;

-- ── 2. Appointment Generated ────────────────────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle","date","reg_number","time","service_type","workshop_link"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'appointment_created' AND is_active
   AND variables <> '["customer_name","vehicle","date","reg_number","time","service_type","workshop_link"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{Customer Name}} 👋
Your appointment has been successfully created for {{vehicle Brand & mode}}.
📅 Date: {{Date}}
🔢Registered No : {{Number}}
🕒 Time: {{Time}}
📍 Service Type: {{Service Type}}
👨🏻‍🔧Workshop Location:{{link}}
We''ll keep you updated at every step. Thank you for choosing us.💚
Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'appointment_created' AND is_active;

-- ── 3. Pickup Done & Received at Workshop ───────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'pickup_received' AND is_active
   AND variables <> '["customer_name","vehicle"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer Name}} 👋
Your {{vehicle}} has been safely picked up and received at our workshop. 🛠️
We''ll keep you updated at every step.

Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'pickup_received' AND is_active;

-- ── 4. Service Completed ────────────────────────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'service_completed' AND is_active
   AND variables <> '["customer_name","vehicle"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer name}}! 🎉
Your {{vehicle}} service has been completed successfully.
Thank you for trusting Spinoto.
Wishing you a smooth and safe ride! 💚

Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'service_completed' AND is_active;

-- ── 5. Invoice / Bill ───────────────────────────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","invoice_link"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'invoice_ready' AND is_active
   AND variables <> '["customer_name","invoice_link"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer name}} 👋
Your service with Spinoto is complete, and your invoice is ready.
Here is your Invoice:
{{Link}}
Thank you for choosing Spinoto. We look forward to serving you again! 💚

Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'invoice_ready' AND is_active;

-- ── 6. Estimate Approval (ask for approval) ─────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle","estimate_amount","estimate_link"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'estimate_approval' AND is_active
   AND variables <> '["customer_name","vehicle","estimate_amount","estimate_link"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer_name}} 👋
Estimate for your {{Vehicle}} is ready.
Estimated Amount: ₹{{estimate_amount}}
Please review and approve the estimate so we can begin the service.
View Estimate: {{estimate_link}}
Team Spinoto
Mechanic in Minutes'
 WHERE template_key = 'estimate_approval' AND is_active;

-- ── 7. Reschedule (both key spellings — see header) ─────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle","date","time","service_type","workshop_link"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key IN ('appointment_reschedule', 'appointment_reshedule') AND is_active
   AND variables <> '["customer_name","vehicle","date","time","service_type","workshop_link"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer_name}} 👋
Your appointment has been rescheduled for {{Vehicle}}.
📅 Date: {{date}}
🕒 Time: {{time}}
📍 Service Type: {{Service Type}}
👨🏻‍🔧 Workshop Location: {{Link}}
For any help you can call us on 7480033800.
Team Spinoto
Mechanic in Minutes'
 WHERE template_key IN ('appointment_reschedule', 'appointment_reshedule') AND is_active;

-- ── 8. Estimate Approve (confirm approval) ──────────────────────────────────
UPDATE wa_templates SET variables = '["customer_name","vehicle","estimate_amount"]'::jsonb,
       last_tested_at = NULL, is_enabled = FALSE
 WHERE template_key = 'estimate_approve' AND is_active
   AND variables <> '["customer_name","vehicle","estimate_amount"]'::jsonb;

UPDATE wa_templates SET body_preview =
'Hi {{customer_name}},
thank you for approving your estimate for {{vehicle}}.

Approved amount: ₹{{amount}}.
We''ll begin work and keep you posted.'
 WHERE template_key = 'estimate_approve' AND is_active;

COMMIT;
