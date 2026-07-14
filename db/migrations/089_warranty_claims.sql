-- 089: Warranty Claims
-- Claims are registered against a PAID customer invoice line item, validated
-- against the warranty snapshot frozen on that item, and (when approved)
-- spawn a redo job that flows through the normal APT → EST → PI → CI pipeline.

CREATE TABLE IF NOT EXISTS warranty_claims (
  id                        SERIAL PRIMARY KEY,
  claim_code                TEXT UNIQUE,               -- WC-00001, set right after insert
  customer_invoice_id       INTEGER NOT NULL REFERENCES customer_invoices(id),
  customer_invoice_item_id  INTEGER NOT NULL REFERENCES customer_invoice_items(id),
  hub_id                    INTEGER REFERENCES hubs(id),

  -- Denormalized for display/search
  customer_name    TEXT,
  mobile           TEXT,
  vehicle_number   TEXT,
  item_description TEXT,

  -- Warranty snapshot copied from the CI item at claim time (audit trail)
  warranty_months INTEGER,
  warranty_days   INTEGER,
  warranty_km     INTEGER,
  warranty_text   TEXT,

  -- Claim intake
  claim_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  current_km  INTEGER,
  reason      TEXT NOT NULL,

  -- Auto-validation result (computed at registration, stored for audit)
  service_date        DATE,
  service_odometer_km INTEGER,
  within_time BOOLEAN,
  within_km   BOOLEAN,
  validation  TEXT NOT NULL DEFAULT 'manual'
              CHECK (validation IN ('valid','expired','manual')),

  -- Decision
  status TEXT NOT NULL DEFAULT 'registered'
         CHECK (status IN ('registered','under_review','approved','rejected','resolved','cancelled')),
  decided_by          INTEGER REFERENCES users(id),
  decided_at          TIMESTAMPTZ,
  rejection_reason    TEXT,
  resolution_type     TEXT CHECK (resolution_type IN ('free_redo','discounted_redo','no_action')),
  redo_charge_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  cost_bearer         TEXT CHECK (cost_bearer IN ('hub','company')),

  -- Redo pipeline links
  redo_appointment_id INTEGER REFERENCES appointments(id),
  redo_estimate_id    INTEGER REFERENCES estimates(id),

  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one OPEN claim per invoice item (resolved/rejected/cancelled can repeat)
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_claim_per_item
  ON warranty_claims (customer_invoice_item_id)
  WHERE status IN ('registered','under_review','approved');

CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims (status);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_hub    ON warranty_claims (hub_id);

-- Redo flags on the pipeline
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS is_warranty_redo  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warranty_claim_id INTEGER REFERENCES warranty_claims(id);

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS warranty_claim_id INTEGER REFERENCES warranty_claims(id);
