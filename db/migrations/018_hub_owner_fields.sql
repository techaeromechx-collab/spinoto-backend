-- =====================================================================
-- Migration 018: Add owner fields to hubs table
-- =====================================================================
-- Run with: psql spinoto -f backend/db/migrations/018_hub_owner_fields.sql
-- =====================================================================

BEGIN;

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS owner_name   VARCHAR(120),
  ADD COLUMN IF NOT EXISTS owner_mobile VARCHAR(10);

COMMIT;
