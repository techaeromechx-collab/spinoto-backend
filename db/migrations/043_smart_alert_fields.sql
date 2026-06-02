-- Migration 043: Smart Alert Fields (priority, tags on leads; daily_target on users)

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS tags     TEXT[]      NOT NULL DEFAULT '{}';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_target INTEGER NOT NULL DEFAULT 10;

CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
