-- 116_wa_lead_status_trigger.sql
--
-- Lets a WhatsApp template fire on a LEAD status change, not only an
-- appointment one.
--
-- ── Why a second column and not a reuse of trigger_status_slug ───────────────
--
-- The two status systems are not alike.
--
-- appointment_statuses has `slug` (migration 036) — a stable identifier that
-- survives renaming, which is why appointment triggers match on it.
--
-- lead_statuses has no slug, and `leads.status` stores the status NAME as text
-- rather than a foreign key (leads.controller.js:143 filters `l.status = $n`).
-- So a lead trigger has no choice but to match on the name.
--
-- Putting both in one column would mean the same field held a slug sometimes
-- and a display name others, with nothing to say which — and matching a lead
-- name against an appointment slug would silently never fire.
--
-- ── The rename caveat, stated plainly ───────────────────────────────────────
--
-- Renaming a lead status in Master Data WILL break a trigger pointing at it.
-- That is not a flaw introduced here: because `leads.status` stores the name,
-- renaming already orphans every lead that held the old value. This column is
-- no more fragile than the data it points at.

BEGIN;

ALTER TABLE wa_templates
  ADD COLUMN IF NOT EXISTS trigger_lead_status VARCHAR(100);

COMMENT ON COLUMN wa_templates.trigger_lead_status IS
  'lead_statuses.name that fires this template. Matched by NAME because leads.status stores the name, not an id. NULL = not lead-driven.';

-- Call Not Received was seeded supports_auto = FALSE, because at the time
-- nothing in the CRM could mean "we rang and nobody answered".
--
-- A lead status can. The master data already carries 'Call No Ans. (Day 1)',
-- '(Day 2)' and '(Day 3)' (seeded in 019), which is exactly that event — so the
-- template now has something real to hang off and the auto toggle is no longer
-- meaningless.
--
-- The trigger itself is deliberately NOT set here. Which status should message a
-- customer is an operational decision, and picking one on the owner's behalf
-- would start messaging leads the first time somebody enables the template.
UPDATE wa_templates
   SET supports_auto = TRUE
 WHERE template_key = 'call_not_received';

COMMIT;
