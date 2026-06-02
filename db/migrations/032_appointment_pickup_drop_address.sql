-- ── Migration 032: Structured Pickup & Drop Address Fields ───────────────────
--
-- Replaces the single pickup_address text column with proper structured fields:
--   pickup_address_line1   — street / flat / building (required when pickup on)
--   pickup_address_line2   — landmark / area (optional)
--   pickup_city            — city (optional)
--   pickup_pincode         — 6-digit pincode (optional)
--
-- Adds drop logistics:
--   drop_required          — boolean flag (mirrors pickup_required)
--   drop_address_line1     — street / flat / building (required when drop on)
--   drop_address_line2     — landmark / area (optional)
--   drop_city              — city (optional)
--   drop_pincode           — 6-digit pincode (optional)
--
-- Existing pickup_address data is migrated → pickup_address_line1 so no
-- historical records are lost, then the old column is dropped.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add new pickup structured columns
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pickup_address_line1  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS pickup_address_line2  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS pickup_city           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pickup_pincode        VARCHAR(10);

-- 2. Migrate existing free-text pickup_address → pickup_address_line1
--    Guard: pickup_address only exists on DBs that ran the old unnumbered migration.
--    On fresh DBs this column doesn't exist yet, so skip the data migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments' AND column_name = 'pickup_address'
  ) THEN
    UPDATE appointments
      SET pickup_address_line1 = pickup_address
      WHERE pickup_address IS NOT NULL AND pickup_address <> '';
  END IF;
END $$;

-- 3. Drop the old single-field column
ALTER TABLE appointments
  DROP COLUMN IF EXISTS pickup_address;

-- 4. Add drop logistics columns
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS drop_required         BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS drop_address_line1    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS drop_address_line2    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS drop_city             VARCHAR(100),
  ADD COLUMN IF NOT EXISTS drop_pincode          VARCHAR(10);

-- 5. Add pickup_required if it wasn't added by the old unnumbered migration,
--    then create indexes. On fresh DBs pickup_required doesn't exist yet.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pickup_required  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pickup_timestamp TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_appts_pickup_required
  ON appointments (pickup_required)
  WHERE pickup_required = TRUE;

CREATE INDEX IF NOT EXISTS idx_appts_drop_required
  ON appointments (drop_required)
  WHERE drop_required = TRUE;

COMMENT ON COLUMN appointments.pickup_address_line1 IS 'Street / flat / building for pickup';
COMMENT ON COLUMN appointments.pickup_address_line2 IS 'Landmark or area for pickup (optional)';
COMMENT ON COLUMN appointments.pickup_city          IS 'City for pickup (optional)';
COMMENT ON COLUMN appointments.pickup_pincode       IS '6-digit pincode for pickup (optional)';
COMMENT ON COLUMN appointments.drop_required        IS 'TRUE when vehicle needs to be dropped back to customer';
COMMENT ON COLUMN appointments.drop_address_line1   IS 'Street / flat / building for drop';
COMMENT ON COLUMN appointments.drop_address_line2   IS 'Landmark or area for drop (optional)';
COMMENT ON COLUMN appointments.drop_city            IS 'City for drop (optional)';
COMMENT ON COLUMN appointments.drop_pincode         IS '6-digit pincode for drop (optional)';

COMMIT;
