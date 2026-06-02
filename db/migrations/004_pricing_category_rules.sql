-- Migration 004: Category-level pricing rules
-- Allows a pricing rule to target an entire service category instead of a single service.
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/004_pricing_category_rules.sql

BEGIN;

-- 1. Make service_id nullable (category rules won't have one)
ALTER TABLE pricing
  ALTER COLUMN service_id DROP NOT NULL;

-- 2. Add category_id column with FK to service_categories
ALTER TABLE pricing
  ADD COLUMN IF NOT EXISTS category_id INT REFERENCES service_categories(id) ON DELETE CASCADE;

-- 3. Enforce exactly one of service_id / category_id is set (never both, never neither)
ALTER TABLE pricing
  ADD CONSTRAINT pricing_target_check CHECK (
    (service_id IS NOT NULL AND category_id IS NULL) OR
    (service_id IS NULL     AND category_id IS NOT NULL)
  );

-- 4. Drop the old single UNIQUE constraint (covers only service rules)
--    Drop explicit name from migration 002 plus common auto-generated variants.
ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_unique_combination;
ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_service_id_vehicle_type_id_body_type_id_segment_id_ma_key;
ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_service_id_vehicle_type_id_body_type_id_segment_id_key;
ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_unique;

-- 5a. Partial UNIQUE index for service-level rules
CREATE UNIQUE INDEX IF NOT EXISTS pricing_service_unique
  ON pricing (service_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id)
  WHERE service_id IS NOT NULL;

-- 5b. Partial UNIQUE index for category-level rules
CREATE UNIQUE INDEX IF NOT EXISTS pricing_category_unique
  ON pricing (category_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id)
  WHERE category_id IS NOT NULL;

-- 6. Index for fast category_id lookups
CREATE INDEX IF NOT EXISTS pricing_category_id_idx ON pricing (category_id);

COMMIT;
