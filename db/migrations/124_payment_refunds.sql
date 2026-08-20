-- Migration 124: payment_refunds.
--
-- WHY A REFUND IS ITS OWN ROW AND NEVER AN EDIT
-- ─────────────────────────────────────────────
-- The obvious implementation of "refund ₹500 of a ₹2000 payment" is to update
-- the payment to ₹1500. That is wrong for three separate reasons:
--
--   1. It destroys history. The customer paid ₹2000. That happened. An invoice
--      that later reads "₹1500 paid" cannot explain the ₹2000 debit on the
--      customer's bank statement, and the accountant has nothing to reconcile
--      the gateway settlement against.
--   2. It breaks GST. The original tax invoice was issued for the full amount;
--      a refund is a credit event with its own date and its own reporting
--      period. Rewriting the payment silently moves money between periods.
--   3. It is unauditable. There is no row that says who refunded, when, why, or
--      whether the gateway actually sent the money back.
--
-- So: customer_invoice_payments rows are append-only for gateway money.
-- amount_paid on the invoice is derived as SUM(payments) − SUM(processed
-- refunds), never by mutating a payment.
--
-- THE STATUS LIFECYCLE MATTERS
-- ────────────────────────────
-- A refund is asynchronous. Razorpay accepts the request immediately and moves
-- the money over the following days. If the invoice were marked unpaid the
-- moment a refund was REQUESTED, the CRM would show an outstanding balance for
-- money the customer has not received back — and if the refund then fails, the
-- invoice is wrong in the other direction with nothing to correct it.
--
--   pending    → requested, gateway has it, nothing has moved
--   processed  → the refund.processed webhook confirmed it. ONLY NOW does the
--                invoice's amount_paid come down.
--   failed     → gateway rejected or reversed it; the invoice never moved
--
-- This mirrors the rule already applied on the way in: the invoice becomes PAID
-- only after the backend verifies the payment, never on a client's word.

CREATE TABLE IF NOT EXISTS payment_refunds (
  id                     SERIAL PRIMARY KEY,

  -- RESTRICT, not CASCADE. Deleting a captured transaction that has refunds
  -- against it should be impossible, and the database is a better place to say
  -- so than a code comment.
  payment_transaction_id INTEGER      NOT NULL
                           REFERENCES payment_transactions(id) ON DELETE RESTRICT,

  -- The ledger row this refund reduces. Nullable because a refund can be
  -- recorded against a transaction whose ledger row was written by an older
  -- path, and because the link is informational — the arithmetic is done by
  -- summing, not by following this pointer.
  ledger_payment_id      INTEGER      REFERENCES customer_invoice_payments(id) ON DELETE SET NULL,

  -- Denormalised so refund lists and KPIs never need a two-hop join.
  customer_invoice_id    INTEGER      REFERENCES customer_invoices(id) ON DELETE SET NULL,
  hub_id                 INTEGER      REFERENCES hubs(id) ON DELETE SET NULL,

  amount                 NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency               VARCHAR(3)   NOT NULL DEFAULT 'INR',

  -- NOT NULL by design. A refund with no stated reason is the one a future
  -- audit asks about, and "the person who did it has left" is not an answer.
  reason                 TEXT         NOT NULL,

  status                 VARCHAR(20)  NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processed','failed')),

  gateway_refund_id      VARCHAR(100),
  error_code             VARCHAR(60),
  error_description      TEXT,
  raw_response           JSONB,

  requested_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at           TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Same idempotency guard as the capture path: refund.processed and
-- refund.failed can both be delivered more than once, and a retried webhook
-- must not create a second refund row (which would double-reduce amount_paid).
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_gateway_id
  ON payment_refunds (gateway_refund_id)
  WHERE gateway_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refund_txn
  ON payment_refunds (payment_transaction_id);
CREATE INDEX IF NOT EXISTS idx_refund_invoice
  ON payment_refunds (customer_invoice_id);
CREATE INDEX IF NOT EXISTS idx_refund_hub_created
  ON payment_refunds (hub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_status
  ON payment_refunds (status);

COMMENT ON TABLE payment_refunds IS
  'Append-only refund records. A refund NEVER edits the original customer_invoice_payments row — amount_paid is derived as SUM(payments) - SUM(processed refunds) so payment history stays immutable and auditable.';
COMMENT ON COLUMN payment_refunds.status IS
  'The invoice balance only moves on processed. A pending refund is money the customer has not received back yet, and a failed one never left.';
