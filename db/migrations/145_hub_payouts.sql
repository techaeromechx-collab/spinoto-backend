-- 145_hub_payouts.sql
--
-- MONEY OUT, AS ITS OWN ATTEMPT TABLE.
--
-- The money-in side of this system is two tables and works because of it:
--
--     payment_transactions        the ATTEMPT — every try, succeeded or not
--     customer_invoice_payments   the MONEY   — written only on confirmed capture
--
-- Money out gets the same split:
--
--     hub_payouts     the ATTEMPT — created, queued, processing, processed,
--                                   failed, reversed, cancelled
--     hub_payments    the MONEY   — the table that already exists, unchanged
--
-- ── WHY NOT JUST ADD status AND gateway_payout_id TO hub_payments ────────────
-- Because hub_payments means MONEY THAT LEFT. A queued payout has not left. A
-- reversed one left and came back. Putting either in that table makes "what have
-- we paid this hub" a question that can no longer be answered with a SUM — and
-- that SUM is the only thing hub_payments exists for. _recalcHubPaymentStatus
-- derives every purchase invoice's amount_paid and payment_status from it; the
-- split-installment waterfall and the "hub already paid" guard both sit on top.
--
-- ── 'reversed' IS THE STATUS MONEY-IN NEVER NEEDED ───────────────────────────
-- A payout can bounce back days later — wrong account, name mismatch, closed
-- account — after the hub has already been told it was paid. Nothing in the
-- current schema can represent that, and it is the single strongest reason this
-- is a table rather than a column.

BEGIN;

CREATE TABLE IF NOT EXISTS hub_payouts (
  id                      SERIAL PRIMARY KEY,

  -- Our own reference, the way txn_ref is on the way in. Quoted to the hub, put
  -- in the provider's notes, and searchable here — so a support conversation
  -- never has to start from a provider id nobody has written down.
  payout_ref              VARCHAR(40)  NOT NULL UNIQUE,

  gateway                 VARCHAR(20)  NOT NULL DEFAULT 'razorpayx',
  -- Snapshotted from the adapter at creation, exactly as payment_transactions
  -- does. Test rows must stay identifiable as test rows for ever, including
  -- after the keys are swapped for live ones.
  mode                    VARCHAR(10)  NOT NULL DEFAULT 'test',

  hub_id                  INTEGER      NOT NULL REFERENCES hubs(id),
  amount                  NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency                VARCHAR(3)   NOT NULL DEFAULT 'INR',
  status                  VARCHAR(20)  NOT NULL DEFAULT 'created',

  -- 'bank_transfer' for NEFT/RTGS/IMPS, 'upi' where the provider supports it.
  -- The ledger's own vocabulary (migration 078), so the hub_payments row written
  -- on confirmation can copy it straight across without a mapping table.
  method                  VARCHAR(20)  NOT NULL DEFAULT 'bank_transfer',

  gateway_payout_id       VARCHAR(100),
  -- WHICH fund account this actually went to, snapshotted. hubs
  -- .payout_fund_account_id is the CURRENT one and is cleared the moment the
  -- bank details change — so without this column, a payout made last month
  -- could not be traced to the account it reached.
  gateway_fund_account_id VARCHAR(60),
  utr                     VARCHAR(60),
  failure_reason          TEXT,
  raw_response            JSONB,
  notes                   TEXT,

  requested_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  processed_at            TIMESTAMPTZ,
  reversed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT hub_payouts_status_check CHECK (status IN
    ('created','queued','processing','processed','failed','reversed','cancelled'))
);

-- The same backstop uq_cip_payment_transaction provides on the way in: a
-- redelivered webhook cannot produce a second record, whatever the application
-- code does. Partial, because 'created' rows have no provider id yet and there
-- are legitimately many of them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_payout_gateway_id
  ON hub_payouts (gateway_payout_id) WHERE gateway_payout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hub_payout_hub
  ON hub_payouts (hub_id, created_at DESC);

-- "What is still in flight" — asked on every load of the payouts screen, and by
-- the refresh action. Partial so it stays tiny as history accumulates.
CREATE INDEX IF NOT EXISTS idx_hub_payout_open
  ON hub_payouts (status) WHERE status IN ('created','queued','processing');

COMMENT ON TABLE hub_payouts IS
  'The ATTEMPT to pay a hub. hub_payments is the money, and is written only when the gateway confirms.';

-- ── WHICH INVOICES A PAYOUT IS FOR ───────────────────────────────────────────
--
-- This table is not optional and it is not denormalisation.
--
-- hub_payments rows are written only when the gateway CONFIRMS. Between pressing
-- Pay and that confirmation — which is minutes at best and days at worst —
-- hub_payouts knows the hub and the amount, and nothing at all knows WHICH
-- purchase invoices the money was meant to settle. Without this table, a payout
-- that fails after two days cannot even tell you what it was trying to pay.
--
-- It is also what makes the intended split survive a restart, a redeployment,
-- and the webhook arriving on a different process from the one that sent the
-- request.
CREATE TABLE IF NOT EXISTS hub_payout_lines (
  id                  SERIAL PRIMARY KEY,
  hub_payout_id       INTEGER NOT NULL REFERENCES hub_payouts(id) ON DELETE CASCADE,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_hub_payout_line UNIQUE (hub_payout_id, purchase_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_payout_lines_pi
  ON hub_payout_lines (purchase_invoice_id);

-- ── WHY THERE IS NO UNIQUE INDEX STOPPING TWO OPEN PAYOUTS PER INVOICE ───────
-- The dangerous case is two Pay clicks on the same purchase invoice producing
-- two transfers. It cannot be expressed as a partial unique index here: the
-- condition lives on hub_payouts.status, which is a different table, and index
-- predicates cannot reach it.
--
-- Mirroring the status onto this row to make the index possible would create a
-- copy that drifts — and an idempotency guard that is sometimes wrong is worse
-- than one that is honest about where it lives.
--
-- So the guard is in services/payouts.service.js, and it is a real one: the
-- purchase_invoices row is taken with SELECT … FOR UPDATE inside the same
-- transaction that inserts here, and the open-payout check happens under that
-- lock. Two concurrent requests take the same lock and the second one sees the
-- first one's line. Every path that creates a payout goes through that function
-- — that is the invariant to protect in review, not this index.

COMMIT;
