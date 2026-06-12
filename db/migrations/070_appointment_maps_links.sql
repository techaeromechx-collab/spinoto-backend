-- ── Migration 070: Add Google Maps link fields to appointments ────────────────
-- Adds optional pickup_maps_link and drop_maps_link columns
-- These store a Google Maps URL for the pickup/drop location
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pickup_maps_link TEXT,
  ADD COLUMN IF NOT EXISTS drop_maps_link   TEXT;
