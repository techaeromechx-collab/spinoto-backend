-- Migration 039: Lead Notes + Lead Activities (Timeline)

CREATE TABLE IF NOT EXISTS lead_notes (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead
  ON lead_notes(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_activities (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead
  ON lead_activities(lead_id, created_at ASC);
