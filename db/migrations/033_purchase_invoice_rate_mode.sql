-- Migration 033: Add rate_mode to purchase_invoices
-- Tracks whether the invoice was calculated using commission % or tech rates (service/parts separately)
-- Values: 'commission' | 'tech_rate'

-- Guard: purchase_invoices is created in migration 065.
-- On fresh DBs this table doesn't exist yet; rate_mode will be included in 065.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_invoices') THEN
    ALTER TABLE purchase_invoices
      ADD COLUMN IF NOT EXISTS rate_mode VARCHAR(20) NOT NULL DEFAULT 'commission';
  END IF;
END $$;
