-- Migration 066: Add hub_id to users
-- Links a user account to a specific hub for hub portal login.
-- Absorbed from unnumbered /backend/migrations/add_hub_id_to_users.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_hub_id ON users (hub_id);
