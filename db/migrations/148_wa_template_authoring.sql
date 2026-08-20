-- Migration 148: let templates be added and retired from Settings → WhatsApp,
-- instead of by writing a migration each time.
--
-- Templates themselves still belong to Meta. This is about the REGISTRY row
-- that points at an already-approved one: its code name, its language, the
-- ordered variable mapping, and which records may send it. That row was only
-- ever creatable in SQL, which is why every template so far has arrived as a
-- migration (110, 117, 128, 140, 147).
--
-- ── Why last_tested_at is a column and not a UI flag ────────────────────────
--
-- The registry's whole failure mode is a mapping that is WRONG but VALID: the
-- right number of values in the wrong order sends cleanly, to a real customer,
-- with the vehicle in the amount slot. Nothing in this system can detect it —
-- Meta matches on position and never sees our key names — so the only check
-- that exists is a human reading the test message on a phone.
--
-- A "you should test first" hint in the form is advice. This column is the
-- rule: whatsapp.controller.js refuses is_enabled = true while it is NULL, so
-- the path from "added" to "reaching customers" runs through a test send.
--
-- It is CLEARED by any edit to the mapping or the provider name, because a
-- reorder invalidates the test that passed. Testing once and then shuffling the
-- variables is exactly the sequence this is meant to catch.

BEGIN;

ALTER TABLE wa_templates
  ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ;

COMMENT ON COLUMN wa_templates.last_tested_at IS
  'When a test send last succeeded for this exact mapping. Cleared by any change to variables, header_variables or provider_template_name. is_enabled cannot be set true while this is NULL.';

-- Every template that predates this migration was hand-written and hand-checked
-- in a migration, and several are live and sending today. Backfilling them as
-- tested is not a shortcut — it records the truth that they were verified by
-- the process that existed then, and it stops this column silently switching
-- off templates that are working.
--
-- Only the ones already enabled: a seeded-but-never-enabled template has NOT
-- been verified by anyone, and it should have to pass the same test as a new
-- one before it can send.
UPDATE wa_templates
   SET last_tested_at = COALESCE(auto_send_changed_at, NOW())
 WHERE is_enabled
   AND last_tested_at IS NULL;

COMMIT;
