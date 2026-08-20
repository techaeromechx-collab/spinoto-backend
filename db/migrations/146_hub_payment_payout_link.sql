-- 146_hub_payment_payout_link.sql
--
-- Ties a confirmed payout to the ledger rows it produced.
--
-- ── WHY THE UNIQUE INDEX IS ON THE PAIR, NOT ON hub_payout_id ALONE ──────────
-- One payout can settle several purchase invoices — that is the whole point of
-- paying a hub once for a fortnight's work. hub_payments.purchase_invoice_id is
-- NOT NULL and _recalcHubPaymentStatus sums this table PER INVOICE, so a batch
-- payout must write one row per invoice (migration 105 spells out why those rows
-- can never be collapsed).
--
-- A unique index on hub_payout_id alone would therefore forbid exactly the case
-- this feature is built for. On the pair it still gives the guarantee that
-- matters: a redelivered payout.processed webhook cannot write a second row for
-- an invoice it has already paid.
--
-- ── AND WHY THE BATCH ID IS REUSED ───────────────────────────────────────────
-- payment_batch_id (migration 105) already groups the rows one bulk payment
-- creates, and the history screen already renders that grouping. A gateway
-- payout writing its payout_ref there means the existing screen shows it as one
-- line, correctly, with no new rendering code. What it must NOT inherit is the
-- batch DELETE — reversing a gateway payout by hand would leave hub_payouts
-- saying 'processed' over a ledger that no longer has the money in it. That
-- refusal is enforced in purchase_invoices.controller.js, on both delete paths.

BEGIN;

ALTER TABLE hub_payments
  ADD COLUMN IF NOT EXISTS hub_payout_id INTEGER REFERENCES hub_payouts(id) ON DELETE SET NULL;

COMMENT ON COLUMN hub_payments.hub_payout_id IS
  'The gateway payout that produced this row. NULL for every payment recorded by hand — which is most of them, and always will be.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_payment_payout_invoice
  ON hub_payments (hub_payout_id, purchase_invoice_id)
  WHERE hub_payout_id IS NOT NULL;

-- The Payouts tab reads the ledger back through the payout. Partial: the NULL
-- rows are the majority and are never looked up by this column.
CREATE INDEX IF NOT EXISTS idx_hub_payments_payout
  ON hub_payments (hub_payout_id) WHERE hub_payout_id IS NOT NULL;

COMMIT;
