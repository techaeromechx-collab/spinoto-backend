-- Migration 015: Add manager_id to users table
-- Allows callers to be assigned to a manager.
-- Manager can then view all leads created by their assigned callers.

ALTER TABLE users ADD COLUMN manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_users_manager ON users (manager_id);
