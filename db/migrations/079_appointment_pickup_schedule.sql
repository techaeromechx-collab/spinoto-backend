-- ── Migration 079: Add Structured Pickup Scheduled Dates ───────────────────
BEGIN;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pickup_scheduled_date DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pickup_scheduled_time TIME DEFAULT NULL;

COMMENT ON COLUMN appointments.pickup_scheduled_date IS 'Scheduled date for vehicle pickup';
COMMENT ON COLUMN appointments.pickup_scheduled_time IS 'Scheduled time for vehicle pickup';

COMMIT;
