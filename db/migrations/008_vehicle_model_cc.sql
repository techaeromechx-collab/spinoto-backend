-- Migration 008: Add engine CC and CC category to vehicle_models
-- engine_cc      — raw engine displacement in cubic centimetres
-- cc_category_id — auto-classified category FK (set by app on create/update)
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/008_vehicle_model_cc.sql

BEGIN;

ALTER TABLE vehicle_models
  ADD COLUMN IF NOT EXISTS engine_cc      INT,
  ADD COLUMN IF NOT EXISTS cc_category_id INT
    REFERENCES cc_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_models_cc_category ON vehicle_models (cc_category_id);

COMMIT;
