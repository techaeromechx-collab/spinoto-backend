-- Migration 002: Add vehicle_type_id and segment_id to pricing table
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/002_pricing_vehicle_type_segment.sql

BEGIN;

-- 1. Add the two new dimension columns
ALTER TABLE pricing
  ADD COLUMN IF NOT EXISTS vehicle_type_id INTEGER
    REFERENCES vehicle_types(id) ON DELETE SET NULL;

ALTER TABLE pricing
  ADD COLUMN IF NOT EXISTS segment_id INTEGER
    REFERENCES segments(id) ON DELETE SET NULL;

-- 2. Drop the old 4-column unique constraint
ALTER TABLE pricing
  DROP CONSTRAINT IF EXISTS pricing_service_id_body_type_id_make_id_model_id_key;

-- 3. Add the new 6-column unique constraint covering all dimensions
ALTER TABLE pricing
  ADD CONSTRAINT pricing_unique_combination
  UNIQUE (service_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id);

-- 4. Add indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_pricing_vehicle_type ON pricing (vehicle_type_id);
CREATE INDEX IF NOT EXISTS idx_pricing_segment      ON pricing (segment_id);

COMMIT;
