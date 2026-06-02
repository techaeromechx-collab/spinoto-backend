-- ── Migration 034: Custom Roles ───────────────────────────────────────────────
-- Creates the roles table and seeds the four built-in role templates.
-- A "Role" is a named bundle of permission codes that can be applied to any
-- user to set their permissions in one click from the Super Admin panel.

-- ── 1. Table ─────────────────────────────────────────────────────────────────
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

-- Trigger to keep updated_at fresh (reuse existing function if it exists)
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

-- ── 2. Seed built-in roles ───────────────────────────────────────────────────
-- Uses ON CONFLICT DO NOTHING so re-running is safe.

INSERT INTO roles (name, description, permissions, is_active)
VALUES
  (
    'Caller',
    'Field agent who captures and manages their own leads.',
    ARRAY[
      'CREATE_LEAD', 'VIEW_OWN_LEADS', 'EDIT_LEAD',
      'VIEW_VEHICLE', 'VIEW_SERVICE', 'VIEW_PRICING_RULE'
    ],
    TRUE
  ),
  (
    'Manager',
    'Team lead who monitors and edits leads from their assigned callers.',
    ARRAY[
      'CREATE_LEAD', 'VIEW_TEAM_LEADS', 'EDIT_LEAD',
      'VIEW_VEHICLE', 'VIEW_SERVICE', 'VIEW_PRICING_RULE',
      'VIEW_REPORTS', 'EXPORT_LEADS'
    ],
    TRUE
  ),
  (
    'Senior Manager',
    'Full lead access, pricing control, and reporting.',
    ARRAY[
      'CREATE_LEAD', 'VIEW_LEAD', 'EDIT_LEAD', 'DELETE_LEAD',
      'VIEW_VEHICLE', 'VIEW_SERVICE',
      'VIEW_PRICING_RULE', 'TOGGLE_PRICING_STATUS',
      'MANAGE_MASTER_DATA', 'VIEW_REPORTS', 'EXPORT_LEADS'
    ],
    TRUE
  ),
  (
    'Admin',
    'Full system access — manages users, master data, pricing, and all leads.',
    ARRAY[
      'MANAGE_USERS', 'MANAGE_MASTER_DATA', 'MANAGE_PRICING',
      'CREATE_LEAD', 'VIEW_LEAD', 'EDIT_LEAD', 'DELETE_LEAD', 'EXPORT_LEADS',
      'CREATE_VEHICLE', 'VIEW_VEHICLE', 'UPDATE_VEHICLE', 'DELETE_VEHICLE', 'BULK_UPLOAD_VEHICLE',
      'CREATE_SERVICE', 'VIEW_SERVICE', 'UPDATE_SERVICE', 'DELETE_SERVICE',
      'CREATE_PRICING_RULE', 'VIEW_PRICING_RULE', 'UPDATE_PRICING_RULE',
      'DELETE_PRICING_RULE', 'TOGGLE_PRICING_STATUS', 'BULK_UPLOAD_PRICING',
      'BULK_UPLOAD', 'VIEW_REPORTS'
    ],
    TRUE
  )
ON CONFLICT DO NOTHING;
