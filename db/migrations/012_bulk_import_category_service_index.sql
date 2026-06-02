-- Migration 012: Indexes to support category-aware bulk pricing import
--
-- The bulk pricing upload (POST /api/import/pricing) now supports two modes:
--
--   Mode A — category + service  → service-level pricing rule
--     The import controller looks up the service by name WITHIN a specific
--     category to confirm it belongs there before creating a service-level rule.
--     Query:  SELECT id FROM services WHERE LOWER(name) = LOWER($1) AND category_id = $2
--
--   Mode B — category only       → category-level pricing rule
--     No service lookup needed; category is resolved directly.
--
-- Without an index, Mode A scans the entire services table for every row in
-- the uploaded file. This migration adds a composite index on
-- (category_id, lower(name)) so that lookup is instant.
--
-- It also adds a plain lower(name) index on services so the "does this service
-- exist in ANY category?" fallback check is equally fast.
--
-- No schema changes — all columns and constraints were added in migrations
-- 004 (category_id on pricing, pricing_target_check, partial unique indexes)
-- and 007 (cc_category_id added to those partial unique indexes).
--
-- Run with:
--   psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/012_bulk_import_category_service_index.sql

BEGIN;

-- 1. Composite index: service lookup by (category_id, lower name)
--    Used by bulk import Mode A:
--      SELECT id FROM services WHERE LOWER(name) = LOWER($1) AND category_id = $2
CREATE INDEX IF NOT EXISTS idx_services_category_name
  ON services (category_id, LOWER(name));

-- 2. Name-only index on services: used by the fallback check that tells the
--    user "this service exists but it's in a different category"
--      SELECT sc.name FROM services s JOIN service_categories sc ...
--      WHERE LOWER(s.name) = LOWER($1)
CREATE INDEX IF NOT EXISTS idx_services_name_lower
  ON services (LOWER(name));

-- 3. Name-only index on service_categories: used when resolving category by
--    name during bulk import (both modes)
--      SELECT id FROM service_categories WHERE LOWER(name) = LOWER($1)
CREATE INDEX IF NOT EXISTS idx_service_categories_name_lower
  ON service_categories (LOWER(name));

-- 4. Verify the pricing_target_check constraint is in place
--    (added in 004 — this is a no-op safety assertion, not a schema change)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pricing_target_check'
       AND conrelid = 'pricing'::regclass
  ) THEN
    RAISE EXCEPTION
      'pricing_target_check constraint is missing. '
      'Run migration 004_pricing_category_rules.sql first.';
  END IF;
END;
$$;

-- 5. Verify partial unique indexes include cc_category_id
--    (rebuilt in 007 — this is a no-op safety assertion)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'pricing_service_unique'
       AND tablename = 'pricing'
       AND indexdef   LIKE '%cc_category_id%'
  ) THEN
    RAISE EXCEPTION
      'pricing_service_unique index is missing cc_category_id. '
      'Run migration 007_cc_category_pricing.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'pricing_category_unique'
       AND tablename = 'pricing'
       AND indexdef   LIKE '%cc_category_id%'
  ) THEN
    RAISE EXCEPTION
      'pricing_category_unique index is missing cc_category_id. '
      'Run migration 007_cc_category_pricing.sql first.';
  END IF;
END;
$$;

COMMIT;
