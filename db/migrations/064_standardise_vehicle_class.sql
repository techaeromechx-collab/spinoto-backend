-- Migration 064: Standardise vehicle_class values to '2W' / '4W' / 'both' everywhere
--
-- Before this migration:
--   services / service_categories  → 'tw' | 'fw' | 'both'
--   hubs                           → '2w' | '4w' | 'both'
--   parts                          → '2W' | '4W' | 'both'  ← already correct
--
-- After this migration EVERYTHING uses: '2W' | '4W' | 'both'

BEGIN;

-- ─── 1. service_categories ────────────────────────────────────────────────────
ALTER TABLE service_categories
  DROP CONSTRAINT IF EXISTS service_categories_vehicle_class_check;

UPDATE service_categories SET vehicle_class = '2W' WHERE vehicle_class = 'tw';
UPDATE service_categories SET vehicle_class = '4W' WHERE vehicle_class = 'fw';

ALTER TABLE service_categories
  ADD CONSTRAINT service_categories_vehicle_class_check
  CHECK (vehicle_class IN ('2W', '4W', 'both'));

-- ─── 2. services ──────────────────────────────────────────────────────────────
ALTER TABLE services
  DROP CONSTRAINT IF EXISTS services_vehicle_class_check;

UPDATE services SET vehicle_class = '2W' WHERE vehicle_class = 'tw';
UPDATE services SET vehicle_class = '4W' WHERE vehicle_class = 'fw';

ALTER TABLE services
  ADD CONSTRAINT services_vehicle_class_check
  CHECK (vehicle_class IN ('2W', '4W', 'both'));

-- ─── 3. hubs ──────────────────────────────────────────────────────────────────
ALTER TABLE hubs
  DROP CONSTRAINT IF EXISTS hubs_vehicle_class_check;

UPDATE hubs SET vehicle_class = '2W' WHERE vehicle_class = '2w';
UPDATE hubs SET vehicle_class = '4W' WHERE vehicle_class = '4w';

ALTER TABLE hubs
  ADD CONSTRAINT hubs_vehicle_class_check
  CHECK (vehicle_class IN ('2W', '4W', 'both'));

-- ─── 4. hub_service_mappings (if it has its own vehicle_class column) ─────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hub_service_mappings' AND column_name = 'vehicle_class'
  ) THEN
    ALTER TABLE hub_service_mappings
      DROP CONSTRAINT IF EXISTS hub_service_mappings_vehicle_class_check;

    UPDATE hub_service_mappings SET vehicle_class = '2W' WHERE vehicle_class = '2w';
    UPDATE hub_service_mappings SET vehicle_class = '4W' WHERE vehicle_class = '4w';

    ALTER TABLE hub_service_mappings
      ADD CONSTRAINT hub_service_mappings_vehicle_class_check
      CHECK (vehicle_class IN ('2W', '4W', 'both'));
  END IF;
END $$;

COMMIT;
