-- 105_hub_payment_batches.sql
--
-- Group the rows a single bulk payment creates.
--
-- One bulk payment of ₹22,527.98 across three invoices is three rows in
-- hub_payments, and it has to stay that way: purchase_invoice_id is NOT NULL and
-- _recalcHubPaymentStatus derives every invoice's amount_paid and payment_status
-- by summing this table PER INVOICE. Collapsing them into one row would break
-- that, and with it the split-installment waterfall, the purchase-invoice
-- detail drawer, and the "hub already paid" guard that stops a customer-invoice
-- payment being deleted out from under a payout.
--
-- So the rows stay and gain a shared id. The history screen groups on it and
-- shows one line — which is how the money actually moved — while the accounting
-- underneath stays per invoice.
--
-- ── Why a real column and not a heuristic ────────────────────────────────
-- Grouping by (paid_at, method, reference_no, created_by) would need no
-- migration, but two unrelated payments recorded in the same second with the
-- same method and no reference would silently merge into a batch that never
-- happened. An explicit id cannot be wrong about that.
--
-- NULL means "not part of a batch": every single-invoice payment, and every row
-- that already existed before this migration. Those are not retro-grouped —
-- there is no reliable way to tell which historical rows belonged together, and
-- guessing would invent batches.

ALTER TABLE hub_payments
  ADD COLUMN IF NOT EXISTS payment_batch_id TEXT;

COMMENT ON COLUMN hub_payments.payment_batch_id IS
  'Shared id for rows created by one bulk payment. NULL for single payments.';

-- The history groups and the batch-delete both look rows up by this, and it is
-- highly selective (a handful of rows per value). Partial: the NULL rows are
-- the majority and are never queried by this column.
CREATE INDEX IF NOT EXISTS idx_hub_payments_batch
  ON hub_payments (payment_batch_id)
  WHERE payment_batch_id IS NOT NULL;

-- paid_at is the ORDER BY on every payment-history query and the filter column
-- for the date range, and had no index at all.
CREATE INDEX IF NOT EXISTS idx_hub_payments_paid_at
  ON hub_payments (paid_at DESC);

ANALYZE hub_payments;
