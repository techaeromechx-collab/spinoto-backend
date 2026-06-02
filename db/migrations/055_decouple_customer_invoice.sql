-- Migration 055: Decouple customer_invoices from purchase_invoices
--
-- Guard: customer_invoices is created in migration 065.
-- On fresh DBs it doesn't exist yet; purchase_invoice_id is already nullable in 065.
-- On existing DBs these ALTER statements apply the decoupling.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_invoices') THEN
    -- Make purchase_invoice_id nullable
    ALTER TABLE customer_invoices
      ALTER COLUMN purchase_invoice_id DROP NOT NULL;

    -- Drop the unique constraint on purchase_invoice_id if it exists
    ALTER TABLE customer_invoices
      DROP CONSTRAINT IF EXISTS customer_invoices_purchase_invoice_id_key;

    -- Reset unique constraint on estimate_id
    ALTER TABLE customer_invoices
      DROP CONSTRAINT IF EXISTS uq_ci_estimate_id;

    ALTER TABLE customer_invoices
      ADD CONSTRAINT uq_ci_estimate_id UNIQUE (estimate_id);

    CREATE INDEX IF NOT EXISTS idx_ci_estimate ON customer_invoices(estimate_id);
  END IF;
END $$;
