-- ── Migration 072: Store reschedule history on appointments ──────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS original_scheduled_date DATE,
  ADD COLUMN IF NOT EXISTS original_scheduled_time TIME,
  ADD COLUMN IF NOT EXISTS rescheduled_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rescheduled_at          TIMESTAMPTZ;
