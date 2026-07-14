-- 087: Warranty Master
-- Warranties for categories / services / parts, optionally per vehicle type.
-- Lookup priority: part+vt > part > service+vt > service > category+vt > category.
-- Snapshot columns on estimate_items / customer_invoice_items freeze the
-- warranty at the time of sale (editing the master never changes old invoices).

CREATE TABLE IF NOT EXISTS warranty_master (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  applies_to       TEXT NOT NULL CHECK (applies_to IN ('category','service','part')),
  ref_id           INTEGER NOT NULL,
  vehicle_type_id  INTEGER REFERENCES vehicle_types(id),  -- NULL = all vehicle types
  duration_months  INTEGER CHECK (duration_months > 0),
  duration_days    INTEGER CHECK (duration_days > 0),
  duration_km      INTEGER CHECK (duration_km > 0),
  custom_text      TEXT,
  valid_from       DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until      DATE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (duration_months IS NOT NULL OR duration_days IS NOT NULL
         OR duration_km IS NOT NULL OR custom_text IS NOT NULL)
);

-- One ACTIVE warranty per target per vehicle-type slot (NULL-safe via COALESCE)
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_active_target
  ON warranty_master (applies_to, ref_id, COALESCE(vehicle_type_id, 0))
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_warranty_lookup
  ON warranty_master (applies_to, ref_id)
  WHERE is_active = TRUE;

-- Snapshot columns (Phase 2)
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS warranty_months INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_days   INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_km     INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_text   TEXT,
  ADD COLUMN IF NOT EXISTS warranty_source TEXT; -- 'master' | 'manual' | NULL

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS warranty_months INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_days   INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_km     INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_text   TEXT;
