-- Customer profile overrides
-- Stores editable fields per mobile number; takes precedence over appointment-derived data.
-- is_deleted = TRUE hides the customer from the list without destroying appointment history.
CREATE TABLE IF NOT EXISTS customer_profiles (
  mobile        VARCHAR(20) PRIMARY KEY,
  display_name  VARCHAR(200),
  whatsapp      VARCHAR(20),
  email         VARCHAR(200),
  notes         TEXT,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_deleted ON customer_profiles (is_deleted) WHERE is_deleted = TRUE;
