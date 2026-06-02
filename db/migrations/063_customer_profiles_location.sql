-- Migration 063: Add state_id, city_id, area_id to customer_profiles

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS state_id INT REFERENCES states(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS city_id  INT REFERENCES cities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area_id  INT REFERENCES areas(id)  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_profiles_state ON customer_profiles(state_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_city  ON customer_profiles(city_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_area  ON customer_profiles(area_id);
