-- Migration 130: widen customer_invoice_payments.amount to match the invoice
-- it settles.
--
-- WHAT WAS INCONSISTENT
-- ─────────────────────
-- The ledger column was NUMERIC(10,2) while everything it is compared against
-- is NUMERIC(12,2):
--
--   customer_invoices.grand_total   NUMERIC(12,2)   (migration 065)
--   customer_invoices.amount_paid   NUMERIC(12,2)   (migration 065)
--   payment_transactions.amount     NUMERIC(12,2)   (migration 122)
--   payment_refunds.amount          NUMERIC(12,2)   (migration 124)
--
-- So the one column that records money actually received was the narrowest in
-- the chain, capped at ₹99,999,999.99 against an invoice that can hold
-- ₹9,999,999,999.99.
--
-- HOW MUCH THIS MATTERS, HONESTLY
-- ───────────────────────────────
-- Not much today. No vehicle service invoice reaches ten crore, and a single
-- payment can never exceed the invoice balance, so the cap is unreachable in
-- practice. This is not a bug being fixed; it is an inconsistency being closed
-- before it becomes one.
--
-- It is worth doing anyway because of where it would surface if it ever did:
-- recalcInvoiceState computes amount_paid as SUM(payments) − SUM(refunds), and
-- an overflow on INSERT is a 22003 from Postgres in the middle of a payment
-- transaction — a 500 at the till, on the one operation where a confusing
-- error makes somebody try again and risk a double entry.
--
-- WHY THIS IS SAFE
-- ────────────────
-- Widening a NUMERIC is not a rewrite. Postgres treats an increase in
-- precision with unchanged scale as a no-op on the stored data: the table is
-- not rewritten, no value is re-encoded, and no row is touched. It takes a
-- brief ACCESS EXCLUSIVE lock to update the catalog and returns immediately,
-- even on a large table. The reverse — narrowing — would rewrite and could
-- fail, which is why this migration only goes one way.
--
-- The CHECK (amount > 0) from migration 065 is unaffected: altering a column's
-- type does not drop constraints that do not depend on its width.

ALTER TABLE customer_invoice_payments
  ALTER COLUMN amount TYPE NUMERIC(12,2);

COMMENT ON COLUMN customer_invoice_payments.amount IS
  'Money received, in rupees. NUMERIC(12,2) to match customer_invoices.grand_total, payment_transactions.amount and payment_refunds.amount — every figure this one is summed alongside or compared against. Always positive; a reversal is a payment_refunds row, never a negative payment.';
