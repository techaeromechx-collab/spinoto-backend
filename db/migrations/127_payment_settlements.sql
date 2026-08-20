-- Migration 127: gateway settlements.
--
-- A SETTLEMENT IS NOT A PAYMENT
-- ─────────────────────────────
-- This distinction is the whole reason the table exists, and getting it wrong
-- is how a set of accounts stops balancing:
--
--   payment     one customer, one invoice, the moment their money leaves their
--               bank. Recorded in payment_transactions and the ledger.
--   settlement  the GATEWAY transferring its accumulated balance into Spinoto's
--               bank account. One transfer, covering many payments, arriving
--               two or three days later, MINUS the gateway's fees and the GST
--               on those fees.
--
-- So the money in the bank never equals the money collected, and it never
-- arrives on the same day. A system that treats a settlement as revenue
-- double-counts; one that ignores settlements can never explain why the bank
-- statement and the CRM disagree by a few percent.
--
-- READ-ONLY, ALWAYS
-- ─────────────────
-- Nothing in this system creates a settlement. Rows are fetched from the
-- gateway and stored for reconciliation. There is no endpoint to add or edit
-- one, deliberately: a hand-typed settlement is a number that agrees with
-- nothing.
--
-- MERCHANT OF RECORD
-- ──────────────────
-- This shape assumes all customer money lands in SPINOTO's gateway account, and
-- that hubs are paid separately through hub_payment_batches (migration 105).
-- That is the confirmed model. If money ever needs to land in a hub's own bank
-- account, that is Razorpay Route — a different product, with per-hub KYC and a
-- different settlement shape — and it would need its own migration rather than
-- columns bolted onto this one.

CREATE TABLE IF NOT EXISTS payment_settlements (
  id                    SERIAL PRIMARY KEY,

  gateway               VARCHAR(20)  NOT NULL DEFAULT 'razorpay',
  gateway_settlement_id VARCHAR(100) NOT NULL,

  -- What actually landed in the bank, after fees and tax.
  amount                NUMERIC(14,2) NOT NULL,
  -- The gateway's commission, and the GST charged on that commission. Kept
  -- separately because they are an expense that has to be accounted for — not
  -- a discount on revenue.
  fees                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax                   NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency              VARCHAR(3)   NOT NULL DEFAULT 'INR',

  -- The bank's own reference for the transfer. This is the ONE field an
  -- accountant matches against a bank statement line, so it earns its own
  -- column rather than living inside raw_response.
  utr                   VARCHAR(60),

  status                VARCHAR(20),
  settled_at            TIMESTAMPTZ,

  raw_response          JSONB,
  fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Refetching an overlapping date window is normal — the sync is re-run to pick
-- up late arrivals — so the same settlement will be offered repeatedly and must
-- update rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_gateway_id
  ON payment_settlements (gateway, gateway_settlement_id);

CREATE INDEX IF NOT EXISTS idx_settlement_settled
  ON payment_settlements (settled_at DESC);

-- Which payments a settlement covered. The gateway reports this separately from
-- the settlement itself, and without it a settlement is a number with no
-- explanation — "₹48,210 arrived" and no way to say which jobs it paid for.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS settlement_id INTEGER;

ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS fk_paytxn_settlement;
ALTER TABLE payment_transactions
  ADD CONSTRAINT fk_paytxn_settlement
  FOREIGN KEY (settlement_id) REFERENCES payment_settlements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_paytxn_settlement
  ON payment_transactions (settlement_id)
  WHERE settlement_id IS NOT NULL;

COMMENT ON TABLE payment_settlements IS
  'Transfers of collected money from the gateway into the company bank account. NOT revenue — one settlement covers many payments, arrives days later, and is net of the gateway fees. Read-only: rows are fetched from the gateway, never entered by hand.';
COMMENT ON COLUMN payment_settlements.utr IS
  'The bank reference for the transfer. This is the field an accountant matches against a bank statement line.';
