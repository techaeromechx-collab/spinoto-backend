-- Migration: add is_pipeline flag to lead_statuses
-- Run: psql spinoto -f add_is_pipeline_to_lead_statuses.sql

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_pipeline BOOLEAN NOT NULL DEFAULT TRUE;

-- Auto-set common "closed" status names to FALSE
-- (admin can always toggle these in the Lead Statuses master page)
UPDATE lead_statuses
SET is_pipeline = FALSE
WHERE LOWER(name) ILIKE '%lost%'
   OR LOWER(name) ILIKE '%convert%'
   OR LOWER(name) ILIKE '%cancel%';

-- Verify result
SELECT id, name, is_pipeline FROM lead_statuses ORDER BY sort_order, id;
