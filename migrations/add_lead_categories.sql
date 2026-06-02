-- Migration: add lead_categories table
-- Allows a lead to have category-level interest recorded
-- (e.g. "interested in AC services") without requiring a specific service to be chosen.

CREATE TABLE IF NOT EXISTS lead_categories (
    id          SERIAL PRIMARY KEY,
    lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lead_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_categories_lead     ON lead_categories (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_categories_category ON lead_categories (category_id);
