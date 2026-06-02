-- =====================================================================
-- Migration 001 — Add segment_id + body_type_id to vehicle_models
--
-- Run with:  psql spinoto -f migrations/001_vehicle_models_segment_bodytype.sql
-- Safe to run multiple times (uses IF NOT EXISTS / column existence check).
-- =====================================================================

BEGIN;

-- Add segment_id column (nullable FK → segments)
ALTER TABLE vehicle_models
  ADD COLUMN IF NOT EXISTS segment_id INTEGER
  REFERENCES segments(id) ON DELETE SET NULL;

-- Add body_type_id column (nullable FK → body_types)
ALTER TABLE vehicle_models
  ADD COLUMN IF NOT EXISTS body_type_id INTEGER
  REFERENCES body_types(id) ON DELETE SET NULL;

-- Supporting indexes
CREATE INDEX IF NOT EXISTS idx_models_segment  ON vehicle_models (segment_id);
CREATE INDEX IF NOT EXISTS idx_models_bodytype ON vehicle_models (body_type_id);

COMMIT;
