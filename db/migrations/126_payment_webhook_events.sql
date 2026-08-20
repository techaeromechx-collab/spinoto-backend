-- Migration 126: a log of every webhook the gateway delivers.
--
-- WHY A TABLE AND NOT JUST A console.log
-- ──────────────────────────────────────
-- Three separate jobs, and only the first is obvious:
--
--   1. Idempotency. Gateways retry. Razorpay redelivers an event until it gets
--      a 2xx, and it can deliver the same event twice even after a 2xx. The
--      unique index on event_id turns a redelivery into a no-op instead of a
--      second capture.
--   2. Answering "did we ever hear about this?". When a customer says the money
--      left their account and the invoice says unpaid, the first question is
--      whether the webhook arrived at all. Without a log the answer is a shrug:
--      the gateway dashboard says "delivered", the CRM shows nothing, and there
--      is no way to tell a lost delivery from a handler that silently failed.
--   3. Replay. A handler bug can be fixed and the stored payload reprocessed,
--      rather than the payments it covered being reconstructed by hand.
--
-- WHAT IS DELIBERATELY NOT STORED
-- ───────────────────────────────
-- The signature header. It is a keyed digest of the body, and keeping it beside
-- the body it signs, forever, in a table an admin screen can read, adds nothing
-- to an investigation and gives an attacker with read access a large corpus of
-- known plaintext/digest pairs to work from.
--
-- The payload IS stored, but scrubbed by services/gateway/types.js before it
-- gets here — no email, no full mobile, no card data.

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id            SERIAL PRIMARY KEY,

  gateway       VARCHAR(20)  NOT NULL DEFAULT 'razorpay',

  -- The gateway's own event id where it sends one, otherwise a digest of the
  -- body. Razorpay's x-razorpay-event-id header is not guaranteed on every
  -- account or every event type, and an idempotency key that is sometimes NULL
  -- is not an idempotency key — the digest fallback means every delivery has a
  -- stable identity either way.
  event_id      VARCHAR(120) NOT NULL,
  event_type    VARCHAR(60)  NOT NULL,

  -- Set when the event could be tied to one of our transactions. NULL is a real
  -- and interesting state: an event we received but could not match, which is
  -- what a misconfigured webhook URL pointing at the wrong environment looks
  -- like.
  payment_transaction_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL,
  gateway_payment_id     VARCHAR(100),

  --   received   stored, not yet handled
  --   processed  handled successfully
  --   ignored    a valid event we have no handler for — not an error
  --   failed     the handler threw; payload retained for replay
  status        VARCHAR(20)  NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','processed','ignored','failed')),
  error_text    TEXT,

  payload       JSONB,
  received_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

-- The idempotency guard. Scoped per gateway so two providers cannot collide on
-- an id shape neither of them promised to keep distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_event
  ON payment_webhook_events (gateway, event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_txn
  ON payment_webhook_events (payment_transaction_id);
CREATE INDEX IF NOT EXISTS idx_webhook_received
  ON payment_webhook_events (received_at DESC);
-- Partial: the only routine query over this table is "what is stuck?", and
-- failures are a tiny fraction of rows.
CREATE INDEX IF NOT EXISTS idx_webhook_failed
  ON payment_webhook_events (status, received_at DESC)
  WHERE status = 'failed';

COMMENT ON TABLE payment_webhook_events IS
  'Every gateway webhook delivery. The unique index on (gateway, event_id) is the idempotency guard — gateways retry, and a redelivery must never produce a second capture.';
COMMENT ON COLUMN payment_webhook_events.event_id IS
  'The gateway event id, or a digest of the body when the gateway does not send one. Never NULL: an idempotency key that is sometimes absent is not one.';
