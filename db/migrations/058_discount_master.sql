-- Migration 058: Discount Master
-- Creates the discount_master table (central discount configuration)
-- and adds discount columns to estimate_items & customer_invoice_items

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. discount_master
--    Discounts can be applied at three levels (priority: part > service > category)
--    discount_type: 'percent' (e.g. 10 = 10%) | 'flat' (e.g. 500 = ₹500)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discount_master (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(200)  NOT NULL,           -- e.g. "Monsoon Offer"
  discount_type    VARCHAR(10)   NOT NULL CHECK (discount_type IN ('percent', 'flat')),
  discount_value   NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),
  applies_to       VARCHAR(20)   NOT NULL CHECK (applies_to IN ('category', 'service', 'part')),
  ref_id           INTEGER       NOT NULL,            -- FK to service_categories.id / services.id / parts.id
  valid_from       DATE          NOT NULL DEFAULT CURRENT_DATE,
  valid_until      DATE          DEFAULT NULL,        -- NULL = no expiry
  is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Prevent duplicate active discount for the same target
CREATE UNIQUE INDEX IF NOT EXISTS uq_discount_master_target
  ON discount_master (applies_to, ref_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_dm_applies_to ON discount_master (applies_to, ref_id);
CREATE INDEX IF NOT EXISTS idx_dm_valid      ON discount_master (valid_until, is_active);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'discount_master_updated_at') THEN
    CREATE TRIGGER discount_master_updated_at
    BEFORE UPDATE ON discount_master
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. estimate_items — add discount columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS discount_type    VARCHAR(10)   DEFAULT NULL CHECK (discount_type IN ('percent', 'flat')),
  ADD COLUMN IF NOT EXISTS discount_value   NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_source  VARCHAR(10)   DEFAULT NULL CHECK (discount_source IN ('master', 'manual'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. customer_invoice_items — add discount columns
--    Guard: created in migration 065; no-op on fresh DBs (columns included in 065)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_invoice_items') THEN
    ALTER TABLE customer_invoice_items
      ADD COLUMN IF NOT EXISTS discount_type    VARCHAR(10)   DEFAULT NULL CHECK (discount_type IN ('percent', 'flat')),
      ADD COLUMN IF NOT EXISTS discount_value   NUMERIC(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_source  VARCHAR(10)   DEFAULT NULL CHECK (discount_source IN ('master', 'manual'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. estimates header — add overall header discount
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS header_discount_type   VARCHAR(10)   DEFAULT NULL CHECK (header_discount_type IN ('percent', 'flat')),
  ADD COLUMN IF NOT EXISTS header_discount_value  NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS header_discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. customer_invoices header — add overall header discount
--    Guard: created in migration 065; no-op on fresh DBs (columns included in 065)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_invoices') THEN
    ALTER TABLE customer_invoices
      ADD COLUMN IF NOT EXISTS header_discount_type   VARCHAR(10)   DEFAULT NULL CHECK (header_discount_type IN ('percent', 'flat')),
      ADD COLUMN IF NOT EXISTS header_discount_value  NUMERIC(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS header_discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;
