-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 074: Add role_id to users
-- Stores which custom role was assigned to a user so it can be displayed
-- correctly instead of being inferred from permissions.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
