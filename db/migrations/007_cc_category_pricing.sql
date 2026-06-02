-- Migration 007: Add cc_category_id dimension to pricing rules
-- Extends the pricing table so rules can target a CC category (for 2W pricing).
-- Also drops and recreates the partial unique indexes to include cc_category_id.
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/007_cc_category_pricing.sql

BEGIN;

ALTER TABLE pricing
  ADD COLUMN IF NOT EXISTS cc_category_id INT
    REFERENCES cc_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pricing_cc_category ON pricing (cc_category_id);

-- Drop existing partial unique indexes (they must be rebuilt to include cc_category_id)
DROP INDEX IF EXISTS pricing_service_unique;
DROP INDEX IF EXISTS pricing_category_unique;

-- Recreate with cc_category_id included in the key
CREATE UNIQUE INDEX pricing_service_unique
  ON pricing (service_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id, cc_category_id)
  WHERE service_id IS NOT NULL;

CREATE UNIQUE INDEX pricing_category_unique
  ON pricing (category_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id, cc_category_id)
  WHERE category_id IS NOT NULL;

COMMIT;
