-- 109_whatsapp_prerequisites.sql
--
-- Groundwork for the WhatsApp module. Nothing here is WhatsApp-specific enough
-- to be useless without it — a hub location link is worth having on its own.
--
-- See docs/whatsapp-integration-plan.md §3.2.
--
-- Additive only. No existing column changes type, gains NOT NULL, or is dropped.
--
-- ── What this migration deliberately does NOT add ────────────────────────────
--
-- An earlier draft added `trigger_key` to appointment_statuses, to give
-- automation a rename-proof identifier instead of the ILIKE name matching in
-- appointmentReminders.service.js:56-61.
--
-- That column already exists. 036_appointment_status_workflow.sql:10 added
-- `slug VARCHAR(60) UNIQUE`, indexed at :39, and it is already what the app
-- keys off — estimates.controller.js:1922 calls
-- advanceAppointmentStatus(apptId, 'work-completed').
--
-- Adding a second stable key alongside it would leave the next person guessing
-- which one is authoritative. WhatsApp triggers therefore reference `slug`, and
-- the mapping from template to slug lives on wa_templates (migration 110) where
-- the rest of the template configuration is.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- map_url on workshops AND hubs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `hubs` holds state_id / city_id / area_id and hub_code (016, 084) — FKs into
-- Location Master, not an address. There is nowhere to put a Google Maps pin,
-- so the "Workshop Location" line in the appointment WhatsApp template has no
-- source today.
--
-- BOTH tables, deliberately. 107_workshops.sql is explicit that every typed
-- workshop column maps 1:1 onto a hubs column "so conversion is a copy rather
-- than a translation". Adding this to hubs alone would mean every hub created
-- through the workshop path arrives with no location and nobody notices until a
-- customer is sent an appointment message with a blank map link.
--
-- The convert endpoint (workshops.controller.js, the INSERT INTO hubs column
-- list) must include this column, or the copy silently drops it.

ALTER TABLE workshops ADD COLUMN IF NOT EXISTS map_url TEXT;
ALTER TABLE hubs      ADD COLUMN IF NOT EXISTS map_url TEXT;

COMMENT ON COLUMN workshops.map_url IS
  'Google Maps share link for the premises. Copied onto hubs.map_url at conversion.';
COMMENT ON COLUMN hubs.map_url IS
  'Google Maps share link. Fills the Workshop Location variable in the appointment WhatsApp template. NULL means that message is skipped, never sent with a blank line.';

COMMIT;
