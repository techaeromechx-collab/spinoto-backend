-- Migration 125: link the money ledger to the gateway, without changing it.
--
-- customer_invoice_payments (migration 065) stays exactly what it is: the one
-- place that answers "how much has this invoice been paid". Nine files read it
-- — hub payouts, warranty preflight, purchase invoices, public documents,
-- appointments, estimates, dashboards — and none of them are touched by this
-- module. That is the whole point.
--
-- Two columns are added, both nullable or defaulted, so every existing row
-- stays valid and every existing query keeps returning what it returned
-- yesterday.
--
--   payment_transaction_id  which gateway capture produced this row
--                           (NULL for cash, UPI-in-person, bank transfer —
--                            i.e. everything recorded before today)
--   source                  'manual' | 'gateway'
--
-- WHY `source` AND NOT JUST "payment_transaction_id IS NOT NULL"
-- ─────────────────────────────────────────────────────────────
-- They will diverge. A staff member can record a manual payment for money that
-- WAS taken through the gateway on a different day (a customer paid the hub's
-- own QR code, say), and a gateway row can exist whose transaction was later
-- purged. `source` states intent; the FK states provenance. Reports group by
-- the first and reconcile with the second.
--
-- The `method` CHECK is deliberately NOT changed. It already allows
-- cash/upi/card/bank_transfer/other/app_payment (migration 078), which covers
-- everything Razorpay reports — the adapter maps the gateway's vocabulary onto
-- those existing values. Widening a CHECK that nine readers depend on, to say
-- something `source` already says, would be a real cost for no gain.

ALTER TABLE customer_invoice_payments
  ADD COLUMN IF NOT EXISTS payment_transaction_id INTEGER,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';

-- Applied after the ADD so it validates the defaulted rows too.
ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS customer_invoice_payments_source_check;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT customer_invoice_payments_source_check
  CHECK (source IN ('manual','gateway'));

-- ON DELETE SET NULL: a transaction record disappearing must never take the
-- record of received money with it. The ledger outlives the gateway.
ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS fk_cip_payment_transaction;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT fk_cip_payment_transaction
  FOREIGN KEY (payment_transaction_id) REFERENCES payment_transactions(id) ON DELETE SET NULL;

-- ── The second half of the duplicate-payment guard ─────────────────────────
-- Migration 122 stops the same gateway payment being RECORDED twice as a
-- transaction. This stops one transaction producing two LEDGER rows — which is
-- the failure that would actually double an invoice's amount_paid, and the one
-- a race between the browser callback and the webhook would cause.
--
-- Enforced by the database, not by a check-then-insert in application code:
-- check-then-insert is exactly the pattern two concurrent requests defeat.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cip_payment_transaction
  ON customer_invoice_payments (payment_transaction_id)
  WHERE payment_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cip_source
  ON customer_invoice_payments (source);

COMMENT ON COLUMN customer_invoice_payments.payment_transaction_id IS
  'The verified gateway capture that produced this row. NULL for manually recorded money. Unique where not null — one capture can never produce two ledger rows.';
COMMENT ON COLUMN customer_invoice_payments.source IS
  'manual = a human recorded it; gateway = the backend wrote it after verifying a signature. Defaults to manual so every pre-existing row is correct.';
