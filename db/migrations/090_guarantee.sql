-- 090: Guarantee support
-- A "guarantee" is a second promise type alongside "warranty". Both can be
-- active on the same item at once (e.g. 1-year guarantee on the part +
-- 6-month warranty on labour). They resolve independently through the same
-- lookup ladder and both get snapshotted onto estimate/invoice items.

-- 1) Promise type on the master
ALTER TABLE warranty_master
  ADD COLUMN IF NOT EXISTS promise_type TEXT NOT NULL DEFAULT 'warranty'
  CHECK (promise_type IN ('warranty','guarantee'));

-- One ACTIVE promise per TYPE per target per vehicle-type slot
DROP INDEX IF EXISTS uq_warranty_active_target;
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_active_target
  ON warranty_master (promise_type, applies_to, ref_id, COALESCE(vehicle_type_id, 0))
  WHERE is_active = TRUE;

-- 2) Guarantee snapshot columns (parallel to warranty_*)
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS guarantee_months INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_days   INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_km     INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_text   TEXT,
  ADD COLUMN IF NOT EXISTS guarantee_source TEXT;

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS guarantee_months INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_days   INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_km     INTEGER,
  ADD COLUMN IF NOT EXISTS guarantee_text   TEXT;

-- 3) Claims record WHICH promise was invoked
ALTER TABLE warranty_claims
  ADD COLUMN IF NOT EXISTS claim_type TEXT NOT NULL DEFAULT 'warranty'
  CHECK (claim_type IN ('warranty','guarantee'));

-- One open claim per item PER PROMISE TYPE (a guarantee claim doesn't block
-- a warranty claim on the same line and vice versa)
DROP INDEX IF EXISTS uq_open_claim_per_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_claim_per_item
  ON warranty_claims (customer_invoice_item_id, claim_type)
  WHERE status IN ('registered','under_review','approved');
