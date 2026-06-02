-- ============================================================
-- Migration: User Profile Fields
-- Run once: psql spinoto -f backend/migrations/add_user_profile_fields.sql
-- ============================================================

-- 1. Basic profile info
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mobile       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS department   VARCHAR(80),
  ADD COLUMN IF NOT EXISTS joining_date DATE,
  ADD COLUMN IF NOT EXISTS profile_photo TEXT;        -- base64 data-URI or URL

-- 2. Last login timestamp (updated on every successful login)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

-- 3. Notification preferences (JSON object)
--    e.g. { "overdue_lead": true, "daily_target": true, "new_lead": true }
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_settings JSONB NOT NULL DEFAULT '{}';
