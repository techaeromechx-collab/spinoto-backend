-- Migration 122: payment_transactions — the payment GATEWAY lifecycle.
--
-- WHY THIS IS NOT THE PAYMENT LEDGER
-- ──────────────────────────────────
-- `customer_invoice_payments` (migration 065) already IS the money ledger, and
-- nine files read from it: hub payouts (utils/payoutSchedule.js), warranty
-- preflight, purchase invoices, public documents, appointments, estimates and
-- the dashboards. If online payments were written to a NEW table instead, every
-- one of those would be blind to them — an invoice paid by card would show a
-- hub payout of zero and a warranty preflight that says "unpaid". Two sources
-- of truth for money is the single worst outcome available here.
--
-- So the rule is:
--
--   customer_invoice_payments  = money we actually have          (unchanged)
--   payment_transactions       = what the gateway is doing       (this table)
--
-- Most rows here never become money. A customer who opens checkout and closes
-- the tab leaves a real, useful record ('created' → never captured) that is not
-- a payment. Only on a VERIFIED capture does the backend write one
-- customer_invoice_payments row and point it back here via
-- customer_invoice_payments.payment_transaction_id (migration 125).
--
-- IDEMPOTENCY
-- ───────────
-- The two partial unique indexes at the bottom are the duplicate-payment guard,
-- not application logic. Razorpay tells us about a capture TWICE by design —
-- once through the browser callback and once through the webhook — and either
-- can arrive first, or the browser one can be missing entirely if the customer
-- closed the tab. Both paths INSERT; the second one hits 23505 and is treated
-- as "already recorded". This is the same mechanism booking_orders already uses
-- (migration 102), for the same reason.
--
-- GATEWAY-AGNOSTIC
-- ────────────────
-- Columns are named `gateway_order_id` / `gateway_payment_id`, not
-- `razorpay_*`. The word "razorpay" appears in exactly one place in this
-- codebase after this change — services/gateway/razorpay.adapter.js. Adding
-- Stripe later is a new adapter file, not a schema change.

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  SERIAL PRIMARY KEY,

  -- Our own reference. Safe to print on a screen, quote to a customer over the
  -- phone and put in a URL. The gateway's ids are NOT used for this: they leak
  -- which provider we use and change shape if we ever switch.
  txn_ref             VARCHAR(40)  NOT NULL UNIQUE,

  gateway             VARCHAR(20)  NOT NULL DEFAULT 'razorpay',
  -- 'test' | 'live'. Stored per row, not read from the environment at display
  -- time: after a go-live the historical test rows must keep saying 'test',
  -- otherwise the first live reconciliation counts play money as revenue.
  mode                VARCHAR(10)  NOT NULL DEFAULT 'test'
                        CHECK (mode IN ('test','live')),

  -- Polymorphic on purpose. 'customer_invoice' is the only producer today;
  -- 'booking' is reserved so the booking flow can migrate onto this table
  -- later without another migration. No FK — a FK cannot be polymorphic, and
  -- the deletion story differs per type (see the trigger note below).
  entity_type         VARCHAR(30)  NOT NULL
                        CHECK (entity_type IN ('customer_invoice','booking')),
  entity_id           INTEGER      NOT NULL,

  -- Denormalised from the invoice so the payments list can be hub-scoped with
  -- utils/hubScope.js without joining through customer_invoices on every row.
  -- ON DELETE SET NULL: losing a hub must never destroy the record of money
  -- that changed hands.
  hub_id              INTEGER      REFERENCES hubs(id) ON DELETE SET NULL,

  -- Customer identity in this system is a mobile number (there is no customers
  -- table — see customer_identities). Stored unmasked; masking is applied at
  -- the response layer by middleware/maskMobile.middleware.js for hub logins.
  mobile              VARCHAR(20),

  -- NUMERIC(12,2) in rupees, matching customer_invoices.grand_total. The
  -- gateway speaks paise; the conversion lives in the adapter, in one place,
  -- so no controller ever has to remember to multiply by 100.
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',

  --   created   order opened, customer has not paid yet
  --   attempted customer tried and the gateway is still deciding
  --   captured  money is ours — this is the ONLY status that writes a ledger row
  --   failed    declined, cancelled, or signature verification failed
  --   expired   order aged out without an attempt
  --   refunded / partially_refunded  set from payment_refunds (migration 124)
  status              VARCHAR(20)  NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','attempted','captured','failed',
                                          'expired','refunded','partially_refunded')),

  gateway_order_id    VARCHAR(100),
  gateway_payment_id  VARCHAR(100),

  -- What the gateway REPORTS the customer used ('upi','card','netbanking',
  -- 'wallet'…). Free text, not a CHECK: this is the gateway's vocabulary and it
  -- grows without asking us. The ledger's own `method` column stays constrained.
  method_detail       VARCHAR(40),

  error_code          VARCHAR(60),
  error_description   TEXT,

  -- Scrubbed before storage (services/gateway/razorpay.adapter.js). Kept for
  -- support: when a customer says "the bank debited me", this is what gets
  -- compared against the gateway dashboard.
  raw_response        JSONB,

  payment_link_id     INTEGER,      -- FK added in migration 123, which creates
                                    -- payment_links; declaring it there keeps
                                    -- each migration independently runnable.

  -- NULL means the customer paid from a public link with no staff involved.
  -- That is meaningful information, not missing data.
  created_by          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── The duplicate-payment guard ────────────────────────────────────────────
-- PARTIAL (WHERE NOT NULL) because a row exists before either id does. A plain
-- UNIQUE would let exactly one row sit in 'created' at a time across the whole
-- table, which is nonsense.
CREATE UNIQUE INDEX IF NOT EXISTS uq_paytxn_gateway_payment
  ON payment_transactions (gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paytxn_gateway_order
  ON payment_transactions (gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;

-- ── Read paths ─────────────────────────────────────────────────────────────
-- The invoice detail screen asks "every transaction for this invoice".
CREATE INDEX IF NOT EXISTS idx_paytxn_entity
  ON payment_transactions (entity_type, entity_id);
-- The payments list is hub-scoped and date-ordered.
CREATE INDEX IF NOT EXISTS idx_paytxn_hub_created
  ON payment_transactions (hub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paytxn_created
  ON payment_transactions (created_at DESC);
-- The overview KPIs group by status over a date window.
CREATE INDEX IF NOT EXISTS idx_paytxn_status
  ON payment_transactions (status);

COMMENT ON TABLE payment_transactions IS
  'Gateway lifecycle for payment attempts. NOT the money ledger — a captured transaction writes one customer_invoice_payments row and links to it. Most rows here never become money.';
COMMENT ON COLUMN payment_transactions.txn_ref IS
  'Our own reference, safe to show a customer. Never expose gateway_payment_id in customer-facing copy.';
COMMENT ON COLUMN payment_transactions.mode IS
  'test or live, snapshotted per row so historical test payments are never counted as revenue after go-live.';
COMMENT ON COLUMN payment_transactions.status IS
  'captured is the only status that means the money is ours, and it is only ever set after server-side signature verification.';
