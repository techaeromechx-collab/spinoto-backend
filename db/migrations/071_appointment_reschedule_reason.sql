-- ── Migration 071: Add reschedule reason & notes to appointments ──────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reschedule_reason TEXT,
  ADD COLUMN IF NOT EXISTS reschedule_notes  TEXT;
