-- ── Migration 035: System Logs ────────────────────────────────────────────────
-- login_logs   : records every successful / failed login attempt
-- activity_logs: records key write actions (create / update / delete)

-- ── 1. Login logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_logs (
  id         BIGSERIAL    PRIMARY KEY,
  user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  email      VARCHAR(200),
  success    BOOLEAN      NOT NULL DEFAULT TRUE,
  ip_address VARCHAR(60),
  user_agent TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_logs_user_id_idx ON login_logs(user_id);
CREATE INDEX IF NOT EXISTS login_logs_created_idx ON login_logs(created_at DESC);

-- ── 2. Activity logs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  user_name   VARCHAR(200),
  action      VARCHAR(20)  NOT NULL,   -- CREATE | UPDATE | DELETE | STATUS
  entity      VARCHAR(60)  NOT NULL,   -- e.g. 'lead', 'appointment', 'invoice'
  entity_id   VARCHAR(40),             -- the record's id as string
  description TEXT,                    -- human-readable summary
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_logs_user_id_idx ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS activity_logs_entity_idx  ON activity_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS activity_logs_created_idx ON activity_logs(created_at DESC);
