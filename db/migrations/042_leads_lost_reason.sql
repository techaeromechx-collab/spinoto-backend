-- Migration 042: Add lost_reason to leads

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(120);
