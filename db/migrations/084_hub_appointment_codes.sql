-- 084_hub_appointment_codes.sql
--
-- Human-readable codes for hubs and appointments, replacing plain numeric
-- IDs in the UI (the numeric ids keep doing their job for FKs/routing/API —
-- these are purely additional display-facing codes).
--
-- hub_code: derived from the hub name (initials, up to 3 letters, padded
-- from the last word if the name is short). Generated once, frozen forever.
--
-- appointment_code: {hub_code}_APT_{MM}-{YY}_{00001} — generated once when a
-- hub is first assigned to the appointment, frozen forever after that (even
-- if the appointment is later reassigned to a different hub). The trailing
-- sequence number resets every calendar month, tracked independently per hub
-- via hub_appointment_sequences.
--
-- See: backend/src/utils/hubCode.js, backend/src/utils/appointmentCode.js

ALTER TABLE hubs ADD COLUMN IF NOT EXISTS hub_code VARCHAR(10);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hubs_hub_code
  ON hubs(hub_code) WHERE hub_code IS NOT NULL;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_code VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_appointment_code
  ON appointments(appointment_code) WHERE appointment_code IS NOT NULL;

-- Tracks the last-used sequence number per hub, per calendar month (IST).
-- Incremented atomically (INSERT ... ON CONFLICT DO UPDATE) so concurrent
-- appointment creation never hands out duplicate numbers.
CREATE TABLE IF NOT EXISTS hub_appointment_sequences (
  hub_id      INTEGER     NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  year        INTEGER     NOT NULL,
  month       INTEGER     NOT NULL,
  last_seq    INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hub_id, year, month)
);
