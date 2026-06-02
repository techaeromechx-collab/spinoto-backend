-- ── Migration 021: Appointments ──────────────────────────────────────────────
-- Creates the appointments table (one row per customer visit / booking)
-- and appointment_services (line items snapshotted at booking time).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. appointments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id               SERIAL PRIMARY KEY,

  -- Source lead (nullable — future: walk-in appointments with no lead)
  lead_id          INTEGER REFERENCES leads(id) ON DELETE SET NULL,

  -- Customer snapshot (copied from lead at time of booking)
  customer_name    VARCHAR(160),
  mobile           VARCHAR(20)  NOT NULL,
  whatsapp         VARCHAR(20),

  -- Vehicle details (copied from lead + vehicle_number asked fresh)
  vehicle_number   VARCHAR(30),
  vehicle_type_id  INTEGER REFERENCES vehicle_types(id) ON DELETE SET NULL,
  make_id          INTEGER REFERENCES vehicle_makes(id)  ON DELETE SET NULL,
  model_id         INTEGER REFERENCES vehicle_models(id) ON DELETE SET NULL,
  body_type_id     INTEGER REFERENCES body_types(id)     ON DELETE SET NULL,
  segment_ids      INTEGER[]   DEFAULT '{}',   -- fuel types for 4W
  cc_category_id   INTEGER     REFERENCES cc_categories(id) ON DELETE SET NULL, -- for 2W

  -- Hub & schedule
  hub_id           INTEGER REFERENCES hubs(id) ON DELETE SET NULL,
  scheduled_date   DATE         NOT NULL,
  scheduled_time   TIME,

  -- Status (FK to appointment_statuses)
  status_id        INTEGER REFERENCES appointment_statuses(id) ON DELETE SET NULL,

  -- Financials
  total_price      NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Notes
  notes            TEXT,

  -- Audit
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appt_lead        ON appointments (lead_id);
CREATE INDEX IF NOT EXISTS idx_appt_mobile      ON appointments (mobile);
CREATE INDEX IF NOT EXISTS idx_appt_hub         ON appointments (hub_id);
CREATE INDEX IF NOT EXISTS idx_appt_status      ON appointments (status_id);
CREATE INDEX IF NOT EXISTS idx_appt_date        ON appointments (scheduled_date DESC);
CREATE INDEX IF NOT EXISTS idx_appt_created_by  ON appointments (created_by);

-- updated_at auto-trigger
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'appointments_updated_at'
  ) THEN
    CREATE TRIGGER appointments_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. appointment_services  (line items)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointment_services (
  id                SERIAL PRIMARY KEY,
  appointment_id    INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id        INTEGER NOT NULL REFERENCES services(id)     ON DELETE CASCADE,
  category_id       INTEGER          REFERENCES service_categories(id) ON DELETE SET NULL,
  price             NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appt_svc_appt    ON appointment_services (appointment_id);
CREATE INDEX IF NOT EXISTS idx_appt_svc_service ON appointment_services (service_id);
