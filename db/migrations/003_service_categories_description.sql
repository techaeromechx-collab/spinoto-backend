-- Migration 003: Add description column to service_categories
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/003_service_categories_description.sql

BEGIN;

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMIT;
