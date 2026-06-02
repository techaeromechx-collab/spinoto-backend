-- Migration 009: Add vehicle_class to services
-- vehicle_class controls which vehicle class a service applies to:
--   'both' = shown for 2W and 4W  (default — safe for all existing rows)
--   'fw'   = Four-Wheeler only    (e.g. AC Service, Power Steering)
--   'tw'   = Two-Wheeler only     (e.g. Chain Lubrication, Sprocket Set)
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/009_service_vehicle_class.sql

BEGIN;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS vehicle_class VARCHAR(4)
    NOT NULL DEFAULT 'both'
    CHECK (vehicle_class IN ('tw', 'fw', 'both'));

CREATE INDEX IF NOT EXISTS idx_services_vehicle_class ON services (vehicle_class);

COMMIT;
