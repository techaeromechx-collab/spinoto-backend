-- ============================================================
-- Migration: Smart Alert Fields
-- Run once: psql spinoto -f backend/migrations/add_smart_alert_fields.sql
-- ============================================================

-- 1. Add priority to leads
--    Values: 'normal' | 'high' | 'urgent' | 'vip'
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';

-- 2. Add tags to leads (text array, e.g. '{VIP, Premium}')
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- 3. Add daily_target to users
--    Used for Daily Target Alert (#4): number of activities expected per day
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_target INTEGER NOT NULL DEFAULT 10;

-- 4. Index for fast priority lookups
CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
