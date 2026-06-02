-- ============================================================
-- Migration: Lead Notes + Lead Activities (Timeline)
-- Run once against your Postgres database
-- ============================================================

-- 1. Quick notes log per lead
CREATE TABLE IF NOT EXISTS lead_notes (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead
  ON lead_notes(lead_id, created_at DESC);

-- 2. Activity timeline per lead
CREATE TABLE IF NOT EXISTS lead_activities (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,  -- 'created' | 'status_changed' | 'assigned' | 'note_added'
  old_value  TEXT,
  new_value  TEXT,
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead
  ON lead_activities(lead_id, created_at ASC);
