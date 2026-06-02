-- Migration 054: Add sac_code to services, hsn_code to parts

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS sac_code VARCHAR(20) DEFAULT NULL;

ALTER TABLE parts
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20) DEFAULT NULL;
