-- =====================================================================
-- Migration 017: HUB vehicle_class + hub_category_mappings + hub_service_mappings
-- =====================================================================
-- REVISED VERSION — simplified mapping tables (no pricing, no availability).
-- Safe to re-run: drops and recreates both mapping tables cleanly.
--
-- Vehicle class values for HUBs: '2w', '4w', 'both'
-- (service_categories/services use 'tw'/'fw' — translation in app layer)
--
-- Run with: psql spinoto -f backend/db/migrations/017_hub_service_mapping.sql
-- =====================================================================

BEGIN;

-- ── Step 1: Add vehicle_class to hubs (idempotent) ────────────────────────────
ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS vehicle_class VARCHAR(4)
    NOT NULL DEFAULT 'both'
    CHECK (vehicle_class IN ('2w', '4w', 'both'));

CREATE INDEX IF NOT EXISTS idx_hubs_vehicle_class ON hubs (vehicle_class);

-- ── Step 2: HUB ↔ Category mapping ───────────────────────────────────────────
-- Records which categories a HUB handles.
CREATE TABLE IF NOT EXISTS hub_category_mappings (
    id          SERIAL PRIMARY KEY,
    hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (hub_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_hcm_hub      ON hub_category_mappings (hub_id);
CREATE INDEX IF NOT EXISTS idx_hcm_category ON hub_category_mappings (category_id);

-- ── Step 3: HUB ↔ Service mapping (simplified) ────────────────────────────────
-- Records which individual services a HUB is assigned to handle.
-- category_id is denormalised for fast group-by-category queries.
CREATE TABLE IF NOT EXISTS hub_service_mappings (
    id          SERIAL PRIMARY KEY,
    hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (hub_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_hsm_hub     ON hub_service_mappings (hub_id);
CREATE INDEX IF NOT EXISTS idx_hsm_service ON hub_service_mappings (service_id);
CREATE INDEX IF NOT EXISTS idx_hsm_hub_cat ON hub_service_mappings (hub_id, category_id);

COMMIT;
