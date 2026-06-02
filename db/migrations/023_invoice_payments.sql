-- ── Migration 023: Invoice Payments ─────────────────────────────────────────
-- Adds amount_paid to invoices + creates invoice_payments table for multi-payment tracking.

-- 1. Add amount_paid to invoices (cached sum of all payments)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 2. invoice_payments table
CREATE TABLE IF NOT EXISTS invoice_payments (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method       VARCHAR(20)  NOT NULL DEFAULT 'cash',   -- cash | upi | card | other
  reference_no VARCHAR(80),   -- UPI transaction ID, card last 4, cheque no. etc.
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_pay_invoice ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_pay_paid_at ON invoice_payments (paid_at DESC);
