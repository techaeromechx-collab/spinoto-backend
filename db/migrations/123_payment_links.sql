-- Migration 123: payment_links — a shareable "pay this invoice" URL.
--
-- WHY A SEPARATE TABLE AND NOT customer_invoices.public_token
-- ───────────────────────────────────────────────────────────
-- customer_invoices already has a public_token, used by
-- /api/public/documents/customer-invoice/:token to serve the invoice PDF. That
-- token is permanent and printed on paper — the QR on every invoice resolves to
-- it. A payment link needs the opposite properties: it expires, it can be
-- cancelled without invalidating the printed invoice, and a hub or a customer
-- may be issued several over time (first request, reminder, final notice).
--
-- Overloading the invoice token with payment semantics would mean that
-- cancelling a payment request also breaks the QR code on a document already in
-- a customer's hands.
--
-- WHAT A LINK HOLDER CAN SEE
-- ──────────────────────────
-- Anyone with the URL. So the public endpoint returns invoice number, amount
-- due, hub name and a MASKED mobile — never line items, cost prices, hub
-- margins, the customer's address or their full number. The amount is read from
-- the invoice at request time, not from this row: `amount` here is the amount
-- the link was CREATED for, kept for audit, and it goes stale the moment a part
-- payment lands.

CREATE TABLE IF NOT EXISTS payment_links (
  id            SERIAL PRIMARY KEY,

  -- Same generator as every other public token in this system
  -- (utils/publicToken.js): 10 random bytes, base64url, ~80 bits. Guessing is
  -- not the threat model this defends against — abuse is, which is why the
  -- public routes are rate-limited.
  token         VARCHAR(64)  NOT NULL UNIQUE,

  entity_type   VARCHAR(30)  NOT NULL DEFAULT 'customer_invoice'
                  CHECK (entity_type IN ('customer_invoice')),
  entity_id     INTEGER      NOT NULL,

  hub_id        INTEGER      REFERENCES hubs(id) ON DELETE SET NULL,

  -- The balance at the moment the link was created. Audit value only — the pay
  -- page recomputes what is actually owed.
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency      VARCHAR(3)   NOT NULL DEFAULT 'INR',

  --   active     usable
  --   paid       the invoice reached its balance through this link
  --   expired    past expires_at (set lazily on read, and by the sweep)
  --   cancelled  a human revoked it
  status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paid','expired','cancelled')),

  -- NOT NULL: an immortal payment URL is a liability. The default window is set
  -- in code (PAYMENT_LINK_TTL_DAYS, default 7) so it can be changed without a
  -- migration.
  expires_at    TIMESTAMPTZ  NOT NULL,

  -- Support signal, not analytics. "I never got the link" is answerable when
  -- this is 0; "I paid twice" is explained when it is 9.
  opened_count  INTEGER      NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ,

  notes         TEXT,
  created_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Token lookup is the hot path: every hit on the public pay page starts here.
CREATE INDEX IF NOT EXISTS idx_paylink_entity
  ON payment_links (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_paylink_hub
  ON payment_links (hub_id, created_at DESC);
-- Partial: the sweep and the "outstanding requests" list only ever ask about
-- active links, and those are a small minority once the system has run a while.
CREATE INDEX IF NOT EXISTS idx_paylink_active
  ON payment_links (status, expires_at)
  WHERE status = 'active';

-- Deferred from migration 122, which cannot reference a table that did not yet
-- exist. ON DELETE SET NULL, never CASCADE: deleting a link must not delete the
-- record of a payment made through it.
ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS fk_paytxn_payment_link;
ALTER TABLE payment_transactions
  ADD CONSTRAINT fk_paytxn_payment_link
  FOREIGN KEY (payment_link_id) REFERENCES payment_links(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_paytxn_link
  ON payment_transactions (payment_link_id)
  WHERE payment_link_id IS NOT NULL;

COMMENT ON TABLE payment_links IS
  'Shareable pay-this-invoice URLs. Separate from customer_invoices.public_token, which is permanent and printed on the invoice QR — cancelling a payment request must not break a document already in a customer''s hands.';
COMMENT ON COLUMN payment_links.amount IS
  'Balance when the link was created — audit only. The pay page recomputes what is owed, so a part payment in between cannot be exploited.';
