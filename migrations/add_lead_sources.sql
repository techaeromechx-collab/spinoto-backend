-- Lead Sources master table
CREATE TABLE IF NOT EXISTS lead_sources (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_sources_name_unique UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_lead_sources_sort ON lead_sources (sort_order ASC);

-- Seed the default sources
INSERT INTO lead_sources (name, sort_order) VALUES
  ('Walk-in',      1),
  ('Phone Call',   2),
  ('Website',      3),
  ('Referral',     4),
  ('Social Media', 5),
  ('Exhibition',   6),
  ('Other',        7)
ON CONFLICT (name) DO NOTHING;
