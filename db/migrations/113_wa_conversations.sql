-- 113_wa_conversations.sql
--
-- The 24-hour session window, one row per customer number.
--
-- WhatsApp allows free-form (non-template) messages only within 24 hours of the
-- customer's last inbound message. Outside that window, everything must be an
-- approved template.
--
-- Nothing in v1 uses this. It exists now because the alternative — discovering
-- later that the window was never recorded — means replying to a customer who
-- just messaged you by firing another template at them.
--
-- See docs/whatsapp-integration-plan.md §6.4.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_conversations (
    id                SERIAL      PRIMARY KEY,

    -- E.164, from utils/phone.js. Same normalisation as wa_messages.to_number
    -- or the two will not join.
    mobile            VARCHAR(20) NOT NULL UNIQUE,

    last_inbound_at   TIMESTAMPTZ,

    -- last_inbound_at + 24h, stored rather than computed so a query can filter
    -- on it with an index instead of an expression over every row.
    window_expires_at TIMESTAMPTZ,

    last_message_at   TIMESTAMPTZ,

    -- Who a reply from this number notifies. Resolved from the most recent open
    -- lead or appointment at the time the reply arrives, then remembered — so a
    -- back-and-forth stays with one person instead of re-routing on every
    -- message.
    assigned_user_id  INTEGER     REFERENCES users(id),

    -- Denormalised for the notification text. A reply saying only
    -- "+919876543210 replied" makes staff go and look the number up.
    customer_name     VARCHAR(160),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_window
  ON wa_conversations (window_expires_at DESC)
  WHERE window_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_conversations_assigned
  ON wa_conversations (assigned_user_id);

COMMENT ON TABLE wa_conversations IS
  'One row per customer number. Tracks the 24-hour free-form messaging window and who owns replies from that number.';
COMMENT ON COLUMN wa_conversations.window_expires_at IS
  'last_inbound_at + 24h. Past this, only approved templates may be sent.';

CREATE OR REPLACE FUNCTION set_wa_conversations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_conversations_updated_at ON wa_conversations;
CREATE TRIGGER trg_wa_conversations_updated_at
  BEFORE UPDATE ON wa_conversations
  FOR EACH ROW EXECUTE FUNCTION set_wa_conversations_updated_at();

COMMIT;
