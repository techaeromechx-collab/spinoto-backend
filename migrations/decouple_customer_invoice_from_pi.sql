-- ── Migration: Decouple customer_invoices from purchase_invoices ──────────────
-- Customer invoices are now generated directly from estimates (before PI exists).
-- 1. Make purchase_invoice_id nullable
-- 2. Drop the old UNIQUE(purchase_invoice_id) — NULLs break one-per-estimate intent
-- 3. Add UNIQUE(estimate_id) so only one CI per estimate is enforced at DB level
-- 4. Add index on estimate_id for fast lookups
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop NOT NULL constraint on purchase_invoice_id
ALTER TABLE customer_invoices
  ALTER COLUMN purchase_invoice_id DROP NOT NULL;

-- 2. Drop the old unique constraint that only made sense when every CI had a PI
--    (name may differ — try both common names, ignore if not found)
DO $$
BEGIN
  -- Try the unnamed constraint generated from UNIQUE(purchase_invoice_id)
  ALTER TABLE customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_purchase_invoice_id_key;
EXCEPTION WHEN undefined_object THEN NULL;
END$$;

-- 3. Enforce: at most one CI per estimate (NULL estimate_id rows are excluded)
ALTER TABLE customer_invoices
  DROP CONSTRAINT IF EXISTS uq_ci_estimate_id;

ALTER TABLE customer_invoices
  ADD CONSTRAINT uq_ci_estimate_id UNIQUE (estimate_id);

-- 4. Index for fast PI→CI lookup when a PI links to a CI later
CREATE INDEX IF NOT EXISTS idx_ci_estimate ON customer_invoices(estimate_id);
