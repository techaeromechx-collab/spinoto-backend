-- Migration 010: Allow same make+model to exist in multiple segment variants
--
-- The old constraint UNIQUE(make_id, name) prevents e.g.
--   Honda Activa Petrol  AND  Honda Activa Electric
-- from coexisting.  We replace it with two partial unique indexes:
--
--   1. When segment_id IS NULL     → at most one null-segment record per make+model
--   2. When segment_id IS NOT NULL → at most one record per make+model+segment combo
--
-- This allows:  Honda Activa Petrol  +  Honda Activa Electric  (different segment_ids)
-- Still blocks: two Honda Activa rows both with NULL segment
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/010_vehicle_models_segment_unique.sql

BEGIN;

-- 1. Drop the old constraint
ALTER TABLE vehicle_models
  DROP CONSTRAINT IF EXISTS vehicle_models_make_id_name_key;

-- 2a. Unique index for records WITHOUT a segment (null-segment records stay unique per make+model)
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_models_no_segment
  ON vehicle_models (make_id, name)
  WHERE segment_id IS NULL;

-- 2b. Unique index for records WITH a segment (each segment variant is unique per make+model)
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_models_with_segment
  ON vehicle_models (make_id, name, segment_id)
  WHERE segment_id IS NOT NULL;

COMMIT;
