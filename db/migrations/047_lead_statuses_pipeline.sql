-- Migration 047: Add is_pipeline flag to lead_statuses

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_pipeline BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE lead_statuses
SET is_pipeline = FALSE
WHERE LOWER(name) ILIKE '%lost%'
   OR LOWER(name) ILIKE '%convert%'
   OR LOWER(name) ILIKE '%cancel%';
