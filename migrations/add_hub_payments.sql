-- Add payment tracking columns to purchase_invoices
ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status  VARCHAR(30)   NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','partially_paid','paid'));

-- Hub payments table (company pays hub)
CREATE TABLE IF NOT EXISTS hub_payments (
  id                    SERIAL PRIMARY KEY,
  purchase_invoice_id   INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  hub_id                INTEGER NOT NULL REFERENCES hubs(id),
  amount                NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method                VARCHAR(30) NOT NULL DEFAULT 'bank_transfer'
                          CHECK (method IN ('cash','upi','card','bank_transfer','other')),
  reference_no          VARCHAR(100),
  paid_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                 TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hub_payments_pi  ON hub_payments(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_hub_payments_hub ON hub_payments(hub_id);

COMMENT ON TABLE hub_payments IS 'Payments made by the company to the hub against approved purchase invoices.';
COMMENT ON COLUMN purchase_invoices.amount_paid    IS 'Total amount paid to hub so far (sum of hub_payments).';
COMMENT ON COLUMN purchase_invoices.payment_status IS 'Hub payment status: pending → partially_paid → paid.';
