-- Migration 052: Estimates + Estimate Items tables

CREATE TABLE IF NOT EXISTS estimates (
  id               SERIAL PRIMARY KEY,
  appointment_id   INTEGER NOT NULL REFERENCES appointments(id),
  hub_id           INTEGER NOT NULL REFERENCES hubs(id),
  status           VARCHAR(50) NOT NULL DEFAULT 'draft'
                     CHECK (status IN (
                       'draft','pending_company_review','sent_to_customer',
                       'partially_approved','fully_approved','revision_requested',
                       'work_in_progress','work_completed'   -- added by migration 028 logic
                     )),
  notes            TEXT,
  subtotal_ex_gst  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gst        NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total      NUMERIC(12,2) NOT NULL DEFAULT 0,
  reviewed_by      INTEGER REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS estimate_items (
  id                  SERIAL PRIMARY KEY,
  estimate_id         INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  item_type           VARCHAR(20) NOT NULL CHECK (item_type IN ('service','part')),
  service_id          INTEGER REFERENCES services(id),
  part_id             INTEGER REFERENCES parts(id),
  description         VARCHAR(300) NOT NULL,
  quantity            NUMERIC(10,2) NOT NULL DEFAULT 1,
  customer_rate       NUMERIC(10,2) NOT NULL,
  gst_percent         NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_inc_gst       NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_from_appointment BOOLEAN NOT NULL DEFAULT FALSE,
  customer_approved   BOOLEAN DEFAULT NULL,
  work_status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (work_status IN ('pending','in_progress','completed')),  -- migration 028
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estimates_appointment ON estimates(appointment_id);
CREATE INDEX IF NOT EXISTS idx_estimates_hub         ON estimates(hub_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status      ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimate_items_est    ON estimate_items(estimate_id);
