-- ── Migration 022: Invoices ──────────────────────────────────────────────────
-- Creates invoices table (one per appointment) and invoice_services (line items).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. invoices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id               SERIAL PRIMARY KEY,

  -- Source appointment (one-to-one ideally, but not enforced so manual invoices can be added later)
  appointment_id   INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  lead_id          INTEGER REFERENCES leads(id)        ON DELETE SET NULL,

  -- Customer snapshot
  customer_name    VARCHAR(160),
  mobile           VARCHAR(20)  NOT NULL,
  vehicle_number   VARCHAR(30),

  -- Hub
  hub_id           INTEGER REFERENCES hubs(id) ON DELETE SET NULL,

  -- Status (FK to invoice_statuses)
  status_id        INTEGER REFERENCES invoice_statuses(id) ON DELETE SET NULL,

  -- Financials
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Notes / remarks
  notes            TEXT,

  -- Audit
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_appointment ON invoices (appointment_id);
CREATE INDEX IF NOT EXISTS idx_inv_lead        ON invoices (lead_id);
CREATE INDEX IF NOT EXISTS idx_inv_mobile      ON invoices (mobile);
CREATE INDEX IF NOT EXISTS idx_inv_hub         ON invoices (hub_id);
CREATE INDEX IF NOT EXISTS idx_inv_status      ON invoices (status_id);
CREATE INDEX IF NOT EXISTS idx_inv_created_at  ON invoices (created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_updated_at') THEN
    CREATE TRIGGER invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. invoice_services  (line items)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_services (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id)  ON DELETE CASCADE,
  service_id   INTEGER          REFERENCES services(id)  ON DELETE SET NULL,
  category_id  INTEGER          REFERENCES service_categories(id) ON DELETE SET NULL,
  description  VARCHAR(200),   -- free-text fallback if service_id is null
  qty          NUMERIC(8,2)    NOT NULL DEFAULT 1,
  unit_price   NUMERIC(12,2)   NOT NULL DEFAULT 0,
  total_price  NUMERIC(12,2)   NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_svc_invoice  ON invoice_services (invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_svc_service  ON invoice_services (service_id);
