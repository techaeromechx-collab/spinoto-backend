-- Migration 040: Add due_at timestamp to lead_events

ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

UPDATE lead_events SET due_at = due_date::TIMESTAMPTZ WHERE due_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lead_events_due_at
  ON lead_events(due_at, is_done);
