-- Migration 073: Add is_locked flag to lead_statuses
-- Locked statuses cannot be changed once a lead is set to them.

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Auto-lock existing Lost and Junk statuses (case-insensitive)
UPDATE lead_statuses
  SET is_locked = TRUE
  WHERE LOWER(name) IN ('lost', 'junk');
