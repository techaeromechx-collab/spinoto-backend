-- Migration 071: Call Outcome Master
-- Creates call_outcomes table and seeds default outcomes

CREATE TABLE IF NOT EXISTS call_outcomes (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INT  NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT call_outcomes_name_unique UNIQUE (name)
);

-- Seed default outcomes
INSERT INTO call_outcomes (name, sort_order, is_active) VALUES
  ('Connected',     1, TRUE),
  ('Not Connected', 2, TRUE),
  ('Busy',          3, TRUE),
  ('Callback',      4, TRUE)
ON CONFLICT (name) DO NOTHING;
