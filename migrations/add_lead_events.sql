-- ============================================================
-- Migration: Lead Status Events
-- Run this once against your Postgres database
-- ============================================================

-- 1. Add follow_up_days to lead_statuses
--    0 = no auto-event, N = create event N days after status is set
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS follow_up_days INTEGER NOT NULL DEFAULT 0;

-- 2. Create lead_events table
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

CREATE INDEX IF NOT EXISTS idx_lead_events_due
  ON lead_events(due_date, is_done);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead
  ON lead_events(lead_id);

-- 3. Add is_default flag to lead_statuses
--    Only ONE status should have is_default = TRUE at a time
--    This status is auto-assigned when a new lead is created
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- 4. Allow leads.status to be NULL
--    NULL means "New Lead" — no status assigned yet
ALTER TABLE leads
  ALTER COLUMN status DROP NOT NULL;
