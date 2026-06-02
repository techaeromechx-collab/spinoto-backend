-- Migration 037: Lead Events
-- Adds follow_up_days to lead_statuses, creates lead_events table,
-- adds is_default to lead_statuses, makes leads.status nullable.

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS follow_up_days INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS lead_events (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status_name  VARCHAR(100) NOT NULL,
  due_date     DATE NOT NULL,
  note         TEXT,
  is_done      BOOLEAN NOT NULL DEFAULT FALSE,
  done_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_due  ON lead_events(due_date, is_done);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id);

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE leads
  ALTER COLUMN status DROP NOT NULL;
