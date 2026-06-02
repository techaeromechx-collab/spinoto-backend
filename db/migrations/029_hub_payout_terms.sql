-- ── Migration 029: Hub Payout Terms & PI Payment Schedule ────────────────────

-- 1. Add payout terms to hubs
ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS payout_terms       VARCHAR(20)  DEFAULT 'net_30'
    CHECK (payout_terms IN ('weekly','fortnightly','net_30','net_60','net_90','net_180','net_365','custom')),
  ADD COLUMN IF NOT EXISTS payout_cycle_days  INTEGER      DEFAULT 30;

COMMENT ON COLUMN hubs.payout_terms      IS 'How often this hub is paid: weekly=7d, fortnightly=14d, net_30=30d, etc.';
COMMENT ON COLUMN hubs.payout_cycle_days IS 'Used when payout_terms=custom. Number of days from PI approval to payout due.';

-- 2. Add payout fields to purchase_invoices
--    Guard: purchase_invoices is created in migration 065 (after estimates in 052).
--    On fresh DBs this table doesn't exist yet; columns will be included in 065.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_invoices') THEN
    ALTER TABLE purchase_invoices
      ADD COLUMN IF NOT EXISTS payout_due_date  DATE,
      ADD COLUMN IF NOT EXISTS payout_schedule  VARCHAR(10) DEFAULT 'lump_sum';

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'purchase_invoices'::regclass AND conname = 'purchase_invoices_payout_schedule_check'
    ) THEN
      ALTER TABLE purchase_invoices
        ADD CONSTRAINT purchase_invoices_payout_schedule_check
        CHECK (payout_schedule IN ('lump_sum','split'));
    END IF;
  END IF;
END $$;

-- 3. Create pi_payment_schedule for split installments
--    REFERENCES purchase_invoices — safe only after that table exists.
--    On fresh DBs this is deferred to migration 065.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_invoices')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pi_payment_schedule')
  THEN
    CREATE TABLE pi_payment_schedule (
      id                   SERIAL        PRIMARY KEY,
      purchase_invoice_id  INTEGER       NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      installment_no       INTEGER       NOT NULL,
      amount_due           NUMERIC(12,2) NOT NULL,
      due_date             DATE          NOT NULL,
      paid_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
      status               VARCHAR(15)   NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','partially_paid','paid')),
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (purchase_invoice_id, installment_no)
    );
    CREATE INDEX idx_pi_schedule_pi_id    ON pi_payment_schedule(purchase_invoice_id);
    CREATE INDEX idx_pi_schedule_due_date ON pi_payment_schedule(due_date);
    CREATE INDEX idx_pi_schedule_status   ON pi_payment_schedule(status);
  END IF;
END $$;
