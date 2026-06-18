-- Migration 076: Add company_name to hubs table
-- Stores the registered business / company name for a hub (optional field)

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(200);
