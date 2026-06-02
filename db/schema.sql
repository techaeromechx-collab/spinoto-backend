-- =====================================================================
-- Spinoto — Lead Management & POS System
-- PostgreSQL schema (full system, all modules)
-- =====================================================================
-- Run with:  psql spinoto -f schema.sql
-- This file is idempotent for the most part: it drops and recreates
-- schema. DO NOT run on production data.
-- =====================================================================

BEGIN;

-- Drop in reverse-dependency order so re-runs work in dev.
DROP TABLE IF EXISTS lead_services      CASCADE;
DROP TABLE IF EXISTS leads              CASCADE;
DROP TABLE IF EXISTS pricing            CASCADE;
DROP TABLE IF EXISTS services           CASCADE;
DROP TABLE IF EXISTS service_categories CASCADE;
DROP TABLE IF EXISTS body_types         CASCADE;
DROP TABLE IF EXISTS segments           CASCADE;
DROP TABLE IF EXISTS vehicle_models     CASCADE;
DROP TABLE IF EXISTS vehicle_makes      CASCADE;
DROP TABLE IF EXISTS vehicle_types      CASCADE;
DROP TABLE IF EXISTS areas              CASCADE;
DROP TABLE IF EXISTS cities             CASCADE;
DROP TABLE IF EXISTS states             CASCADE;
DROP TABLE IF EXISTS user_permissions   CASCADE;
DROP TABLE IF EXISTS users              CASCADE;
DROP TYPE  IF EXISTS user_role          CASCADE;
DROP TYPE  IF EXISTS lead_status        CASCADE;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE lead_status AS ENUM ('new', 'in_progress', 'interested', 'converted', 'not_interested');

-- ---------------------------------------------------------------------
-- Users
--   Access control is permission-based. The is_super_admin flag bypasses
--   every permission check (so a Super Admin cannot accidentally lock
--   themselves out). All other users get explicit grants in user_permissions.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(180) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    is_super_admin  BOOLEAN     NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);

-- Permission codes are validated in the application layer (see
-- backend/src/utils/permissions.js). Storing them as plain strings means
-- adding a new permission is a backend code change, no migration needed.
CREATE TABLE user_permissions (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_code  VARCHAR(60) NOT NULL,
    granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, permission_code)
);
CREATE INDEX idx_user_perms_code ON user_permissions (permission_code);

-- ---------------------------------------------------------------------
-- Location master (State -> City -> Area)
-- ---------------------------------------------------------------------
CREATE TABLE states (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(120) NOT NULL UNIQUE,
    code       VARCHAR(10),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cities (
    id         SERIAL PRIMARY KEY,
    state_id   INTEGER NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    name       VARCHAR(120) NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (state_id, name)
);
CREATE INDEX idx_cities_state ON cities (state_id);

CREATE TABLE areas (
    id         SERIAL PRIMARY KEY,
    city_id    INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    name       VARCHAR(120) NOT NULL,
    pincode    VARCHAR(20),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (city_id, name)
);
CREATE INDEX idx_areas_city ON areas (city_id);

-- ---------------------------------------------------------------------
-- Vehicle master (Type -> Make -> Model, plus Segment & Body Type)
-- ---------------------------------------------------------------------
CREATE TABLE vehicle_types (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(60) NOT NULL UNIQUE,   -- e.g., Two-Wheeler, Four-Wheeler, Commercial
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicle_makes (
    id              SERIAL PRIMARY KEY,
    vehicle_type_id INTEGER NOT NULL REFERENCES vehicle_types(id) ON DELETE CASCADE,
    name            VARCHAR(80) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (vehicle_type_id, name)
);
CREATE INDEX idx_makes_type ON vehicle_makes (vehicle_type_id);

CREATE TABLE segments (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(40) NOT NULL UNIQUE,    -- Petrol, Diesel, CNG, Electric...
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE body_types (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(60) NOT NULL UNIQUE,    -- Hatchback, Sedan, SUV, MUV...
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE vehicle_models (
    id            SERIAL PRIMARY KEY,
    make_id       INTEGER NOT NULL REFERENCES vehicle_makes(id)  ON DELETE CASCADE,
    name          VARCHAR(120) NOT NULL,
    segment_id    INTEGER      REFERENCES segments(id)            ON DELETE SET NULL,
    body_type_id  INTEGER      REFERENCES body_types(id)          ON DELETE SET NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (make_id, name)
);
CREATE INDEX idx_models_make     ON vehicle_models (make_id);
CREATE INDEX idx_models_segment  ON vehicle_models (segment_id);
CREATE INDEX idx_models_bodytype ON vehicle_models (body_type_id);


-- ---------------------------------------------------------------------
-- Service master
-- ---------------------------------------------------------------------
CREATE TABLE service_categories (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(120) NOT NULL UNIQUE,   -- Service Package, Repair, Detailing...
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE services (
    id          SERIAL PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    name        VARCHAR(160) NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (category_id, name)
);
CREATE INDEX idx_services_category ON services (category_id);

-- ---------------------------------------------------------------------
-- Pricing master
--   Pricing is keyed by (service, body_type, optional make, optional model).
--   The most specific match wins at lookup time:
--     model > make > body_type-only.
-- ---------------------------------------------------------------------
CREATE TABLE pricing (
    id            SERIAL PRIMARY KEY,
    service_id    INTEGER NOT NULL REFERENCES services(id)        ON DELETE CASCADE,
    body_type_id  INTEGER          REFERENCES body_types(id)      ON DELETE CASCADE,
    make_id       INTEGER          REFERENCES vehicle_makes(id)   ON DELETE CASCADE,
    model_id      INTEGER          REFERENCES vehicle_models(id)  ON DELETE CASCADE,
    price         NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    currency      VARCHAR(3) NOT NULL DEFAULT 'INR',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A given combination should only exist once.
    UNIQUE (service_id, body_type_id, make_id, model_id)
);
CREATE INDEX idx_pricing_service   ON pricing (service_id);
CREATE INDEX idx_pricing_body      ON pricing (body_type_id);
CREATE INDEX idx_pricing_make      ON pricing (make_id);
CREATE INDEX idx_pricing_model     ON pricing (model_id);

-- ---------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------
CREATE TABLE leads (
    id              SERIAL PRIMARY KEY,
    -- Basic details
    name            VARCHAR(160) NOT NULL,
    mobile          VARCHAR(20)  NOT NULL,
    whatsapp        VARCHAR(20),
    -- Location
    state_id        INTEGER REFERENCES states(id),
    city_id         INTEGER REFERENCES cities(id),
    area_id         INTEGER REFERENCES areas(id),
    -- Vehicle
    vehicle_type_id INTEGER REFERENCES vehicle_types(id),
    make_id         INTEGER REFERENCES vehicle_makes(id),
    model_id        INTEGER REFERENCES vehicle_models(id),
    body_type_id    INTEGER REFERENCES body_types(id),
    segment_ids     INTEGER[] DEFAULT '{}',  -- multi-select fuel types
    -- Lead context
    lead_source     VARCHAR(80),
    status          lead_status NOT NULL DEFAULT 'new',
    total_price     NUMERIC(12, 2) NOT NULL DEFAULT 0,
    notes           TEXT,
    -- Audit
    created_by      INTEGER REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_leads_status     ON leads (status);
CREATE INDEX idx_leads_created_by ON leads (created_by);
CREATE INDEX idx_leads_mobile     ON leads (mobile);
CREATE INDEX idx_leads_created_at ON leads (created_at DESC);

CREATE TABLE lead_services (
    id          SERIAL PRIMARY KEY,
    lead_id     INTEGER NOT NULL REFERENCES leads(id)    ON DELETE CASCADE,
    service_id  INTEGER NOT NULL REFERENCES services(id),
    price       NUMERIC(12, 2) NOT NULL,        -- snapshot of price at time of save
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lead_services_lead    ON lead_services (lead_id);
CREATE INDEX idx_lead_services_service ON lead_services (service_id);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at   BEFORE UPDATE ON users   FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER pricing_updated_at BEFORE UPDATE ON pricing FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER leads_updated_at   BEFORE UPDATE ON leads   FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

COMMIT;
