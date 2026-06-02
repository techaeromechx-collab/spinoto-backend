-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: create_roles
-- Adds a named "Role" concept — a reusable bundle of permission codes that
-- can be applied to any user to set their permissions in one click.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id           SERIAL       PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  permissions  TEXT[]       NOT NULL DEFAULT '{}',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Case-insensitive unique index on role name
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_lower_idx ON roles (LOWER(name));

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS roles_updated_at ON roles;
CREATE TRIGGER roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
