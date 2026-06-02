-- Company settings (single-row configuration table)
CREATE TABLE IF NOT EXISTS company_settings (
  id               SERIAL PRIMARY KEY,
  company_name     TEXT        NOT NULL DEFAULT '',
  address_line1    TEXT        NOT NULL DEFAULT '',
  address_line2    TEXT        NOT NULL DEFAULT '',
  city             TEXT        NOT NULL DEFAULT '',
  state            TEXT        NOT NULL DEFAULT '',
  pincode          VARCHAR(10) NOT NULL DEFAULT '',
  phone            VARCHAR(20) NOT NULL DEFAULT '',
  email            TEXT        NOT NULL DEFAULT '',
  gstin            VARCHAR(20) NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one empty row so GET always returns something
INSERT INTO company_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
