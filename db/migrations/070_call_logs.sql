-- Migration 070: Call logs for leads
-- Adds logs_call flag to lead_statuses and creates call_logs table

-- 1. Add logs_call column to lead_statuses
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS logs_call BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Create call_logs table
CREATE TABLE IF NOT EXISTS call_logs (
  id           SERIAL PRIMARY KEY,
  lead_id      INT          NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  called_by    INT          NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  called_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  outcome      TEXT         NOT NULL DEFAULT 'answered',  -- answered | no_answer | busy | callback
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id   ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_called_by ON call_logs(called_by);
CREATE INDEX IF NOT EXISTS idx_call_logs_called_at ON call_logs(called_at);
