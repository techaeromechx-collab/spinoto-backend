-- Migration 027: Create parts master data table

CREATE TABLE IF NOT EXISTS parts (
  id           SERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  category     TEXT        DEFAULT NULL,
  vehicle_type TEXT        DEFAULT NULL CHECK (vehicle_type IN ('2W', '4W', 'both')),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS parts_name_lower_unique ON parts (LOWER(name));

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_parts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parts_updated_at ON parts;
CREATE TRIGGER parts_updated_at
  BEFORE UPDATE ON parts
  FOR EACH ROW EXECUTE FUNCTION update_parts_updated_at();
