-- Migration: add due_at (exact timestamp) to lead_events
-- Run once: psql spinoto -f backend/migrations/add_due_at_to_lead_events.sql

ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

-- Backfill existing rows: set due_at = due_date at start of day
UPDATE lead_events SET due_at = due_date::TIMESTAMPTZ WHERE due_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lead_events_due_at
  ON lead_events(due_at, is_done);
