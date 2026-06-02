-- ── Migration 020: Hub Operating Hours ───────────────────────────────────────
-- Adds open_time, close_time, and working_days to the hubs table so each
-- HUB can store its operating schedule.

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS open_time    TIME,
  ADD COLUMN IF NOT EXISTS close_time   TIME,
  ADD COLUMN IF NOT EXISTS working_days TEXT;
-- working_days stores a comma-separated list of day abbreviations,
-- e.g. "Mon,Tue,Wed,Thu,Fri,Sat"
