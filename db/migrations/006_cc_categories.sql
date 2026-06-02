-- Migration 006: CC Categories for Two-Wheeler engine capacity segmentation
-- Creates a master table for engine CC ranges (C1–C6) with:
--   • PostgreSQL exclusion constraint (btree_gist) to prevent overlapping ranges
--   • Computed int4range column for fast overlap checks
--   • Default seed data matching the spec
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/006_cc_categories.sql

BEGIN;

-- Required for GIST exclusion constraint on integer ranges
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS cc_categories (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(20)  NOT NULL,
  min_cc      INT          NOT NULL,
  max_cc      INT          NOT NULL,
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT cc_categories_name_unique UNIQUE (name),
  CONSTRAINT cc_range_valid CHECK (min_cc >= 0 AND max_cc > 0 AND min_cc < max_cc)
);

-- Computed range column — used by the overlap exclusion constraint
ALTER TABLE cc_categories
  ADD COLUMN IF NOT EXISTS cc_range int4range
  GENERATED ALWAYS AS (int4range(min_cc, max_cc, '[]')) STORED;

-- Exclusion constraint: no two ACTIVE categories may share any CC value
ALTER TABLE cc_categories
  ADD CONSTRAINT cc_no_overlap
  EXCLUDE USING GIST (cc_range WITH &&)
  WHERE (is_active = TRUE);

-- Index for status-filtered lookups (classify endpoint)
CREATE INDEX IF NOT EXISTS idx_cc_categories_active ON cc_categories (is_active);

-- ── Seed default categories ───────────────────────────────────────────────────
INSERT INTO cc_categories (name, min_cc, max_cc, description) VALUES
  ('C1',    0,    130, '0–130 cc — entry-level scooters & mopeds'),
  ('C2',  131,    190, '131–190 cc — standard commuter bikes'),
  ('C3',  191,    270, '191–270 cc — mid-range commuters'),
  ('C4',  271,    500, '271–500 cc — performance & adventure segment'),
  ('C5',  501,   1000, '501–1000 cc — super bikes'),
  ('C6', 1001,   9999, '1001–9999 cc — premium & large displacement')
ON CONFLICT (name) DO NOTHING;

COMMIT;
