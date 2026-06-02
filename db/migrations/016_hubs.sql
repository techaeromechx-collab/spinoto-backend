-- =====================================================================
-- Migration 016: HUB (Aggregator) table
-- =====================================================================
-- Run with: psql spinoto -f backend/db/migrations/016_hubs.sql
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hubs (
    id              SERIAL PRIMARY KEY,

    -- Core fields
    hub_name        VARCHAR(150) NOT NULL,
    person_name     VARCHAR(120) NOT NULL,
    contact_number  VARCHAR(10)  NOT NULL,

    -- Location references (from Location Master)
    state_id        INTEGER NOT NULL REFERENCES states(id),
    city_id         INTEGER NOT NULL REFERENCES cities(id),
    area_id         INTEGER NOT NULL REFERENCES areas(id),

    -- Relationship Manager (must be an active user)
    rm_user_id      INTEGER NOT NULL REFERENCES users(id),

    -- Status & meta
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_by      INTEGER REFERENCES users(id),
    deleted_at      TIMESTAMPTZ,          -- soft delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique hub name (case-insensitive, among non-deleted rows)
CREATE UNIQUE INDEX IF NOT EXISTS idx_hubs_hub_name_unique
    ON hubs (LOWER(hub_name))
    WHERE deleted_at IS NULL;

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_hubs_state    ON hubs (state_id);
CREATE INDEX IF NOT EXISTS idx_hubs_city     ON hubs (city_id);
CREATE INDEX IF NOT EXISTS idx_hubs_area     ON hubs (area_id);
CREATE INDEX IF NOT EXISTS idx_hubs_rm       ON hubs (rm_user_id);
CREATE INDEX IF NOT EXISTS idx_hubs_active   ON hubs (is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hubs_deleted  ON hubs (deleted_at);

COMMIT;
