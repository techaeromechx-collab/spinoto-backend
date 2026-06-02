-- Migration 011: Add vehicle_class to service_categories
-- Controls which pricing dimensions are available for the category.
--   'both' → show all options (default — safe for existing data)
--   'fw'   → 4W only: Body Type + Segment pricing; hide CC Category option
--   'tw'   → 2W only: CC Category pricing; hide Body Type + Segment options
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/011_service_categories_vehicle_class.sql

BEGIN;

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS vehicle_class VARCHAR(4)
    NOT NULL DEFAULT 'both'
    CHECK (vehicle_class IN ('tw', 'fw', 'both'));

COMMIT;
