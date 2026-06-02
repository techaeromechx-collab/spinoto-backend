-- Migration 005: Add pricing_config to service_categories
-- pricing_config is a JSONB array of dimension keys that define how pricing
-- is structured for all services in this category.
-- Valid dimension values: 'vehicle_type', 'body_type', 'segment', 'make', 'model'
-- Example: '["body_type"]' or '["make","model","segment"]'

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS pricing_config JSONB NOT NULL DEFAULT '[]'::jsonb;
