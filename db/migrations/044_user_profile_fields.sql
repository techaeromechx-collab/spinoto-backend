-- Migration 044: User Profile Fields

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mobile                VARCHAR(20),
  ADD COLUMN IF NOT EXISTS department            VARCHAR(80),
  ADD COLUMN IF NOT EXISTS joining_date          DATE,
  ADD COLUMN IF NOT EXISTS profile_photo         TEXT,
  ADD COLUMN IF NOT EXISTS last_login            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_settings JSONB NOT NULL DEFAULT '{}';
