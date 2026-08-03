-- 103_api_keys.sql
--
-- Read-only API access to master data for systems outside this app: the
-- booking site today, outside partners later.
--
-- WHY A TABLE AND NOT ANOTHER ENV VAR
-- The existing integration (BOOKING_WEBHOOK_KEY) is one shared secret in .env.
-- That works for exactly one consumer. With two, revoking a partner means
-- rotating the value your own booking site depends on — so in practice nobody
-- revokes anything. A row per key makes revocation a local act.
--
-- THE KEY ITSELF IS NEVER STORED.
-- Same reasoning as passwords: anyone with database read access would
-- otherwise hold live credentials to the API. We keep a SHA-256 hash and a
-- short non-secret prefix for display, and show the full key exactly once at
-- creation. If it is lost, it is reissued, not recovered.
--
-- Bcrypt is deliberately NOT used here even though the codebase has bcryptjs
-- for passwords. Bcrypt is slow on purpose, which is right for a login typed
-- by a human a few times a day and wrong for a header verified on every API
-- request. The threat it defends against — offline cracking of a low-entropy
-- secret — does not apply: these keys are 32 random bytes, so a plain SHA-256
-- has nothing to brute force.

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,

  -- Human label, shown in the admin list. 'Booking site', 'Partner: XYZ'.
  name         VARCHAR(120) NOT NULL,

  -- The leading, non-secret part — e.g. 'spk_live_a1b2c3d4'. Two jobs:
  -- it is what the UI displays after creation, and it is the lookup key, so
  -- verification is one indexed row fetch rather than hashing every row.
  key_prefix   VARCHAR(32)  NOT NULL UNIQUE,

  -- SHA-256 of the whole key, hex.
  key_hash     TEXT         NOT NULL,

  -- What this key may read: 'services:read', 'pricing:read', …
  -- An array rather than a join table because scopes are a short fixed
  -- vocabulary owned by the code, not user-managed data.
  scopes       TEXT[]       NOT NULL DEFAULT '{}',

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Populated on use. The point is the admin screen: an unused key is one you
  -- can revoke without a conversation, and a key still in use months after a
  -- partner left is the one you need to find.
  last_used_at TIMESTAMPTZ,

  -- Both NULL-able and both meaning "still valid". Revocation is a timestamp
  -- rather than a boolean or a DELETE so the row survives as a record of what
  -- existed and when it stopped.
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  revoked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Free-text: which partner, which contact, why it was issued.
  notes        TEXT
);

-- The verification path: WHERE key_prefix = $1. UNIQUE already indexes it.

-- The admin list: live keys first, newest first.
CREATE INDEX IF NOT EXISTS idx_api_keys_active
  ON api_keys (created_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE  api_keys IS
  'Read-only master-data API credentials. Full key is never stored — only a SHA-256 hash and a display prefix.';
COMMENT ON COLUMN api_keys.scopes IS
  'e.g. {services:read,pricing:read}. Vocabulary lives in src/utils/apiScopes.js.';
COMMENT ON COLUMN api_keys.revoked_at IS
  'Non-NULL = dead. Rows are never deleted, so a revoked key stays auditable.';
