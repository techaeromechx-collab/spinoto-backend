-- Add hub_id to users — links a user account to a hub for hub login
ALTER TABLE users ADD COLUMN IF NOT EXISTS hub_id INTEGER REFERENCES hubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_hub_id ON users (hub_id);
