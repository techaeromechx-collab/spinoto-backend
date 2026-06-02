-- ── Purchase Invoice (Company receives from Hub) ──────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                  SERIAL PRIMARY KEY,
  estimate_id         INTEGER NOT NULL REFERENCES estimates(id),
  appointment_id      INTEGER REFERENCES appointments(id),
  hub_id              INTEGER NOT NULL REFERENCES hubs(id),
  commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  status              VARCHAR(30) NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval','approved','cancelled')),
  subtotal_ex_gst     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gst           NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  approved_by         INTEGER REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(estimate_id)
);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id                    SERIAL PRIMARY KEY,
  purchase_invoice_id   INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  estimate_item_id      INTEGER REFERENCES estimate_items(id),
  item_type             VARCHAR(20) NOT NULL,
  description           VARCHAR(300) NOT NULL,
  quantity              NUMERIC(10,2) NOT NULL,
  customer_rate         NUMERIC(10,2) NOT NULL,
  commission_percent    NUMERIC(5,2)  NOT NULL,
  hub_rate              NUMERIC(10,2) NOT NULL,
  gst_percent           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_payable         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Customer Invoice (Company sends to Customer) ──────────────────────────────
CREATE TABLE IF NOT EXISTS customer_invoices (
  id                  SERIAL PRIMARY KEY,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
  estimate_id         INTEGER REFERENCES estimates(id),
  appointment_id      INTEGER REFERENCES appointments(id),
  hub_id              INTEGER REFERENCES hubs(id),
  customer_name       VARCHAR(160),
  mobile              VARCHAR(20),
  vehicle_number      VARCHAR(30),
  status              VARCHAR(30) NOT NULL DEFAULT 'generated'
                        CHECK (status IN ('generated','partially_paid','paid','cancelled')),
  subtotal_ex_gst     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gst           NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid         NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(purchase_invoice_id)
);

CREATE TABLE IF NOT EXISTS customer_invoice_items (
  id                    SERIAL PRIMARY KEY,
  customer_invoice_id   INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  estimate_item_id      INTEGER REFERENCES estimate_items(id),
  item_type             VARCHAR(20) NOT NULL,
  description           VARCHAR(300) NOT NULL,
  quantity              NUMERIC(10,2) NOT NULL,
  customer_rate         NUMERIC(10,2) NOT NULL,
  gst_percent           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_inc_gst         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_invoice_payments (
  id                    SERIAL PRIMARY KEY,
  customer_invoice_id   INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount                NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method                VARCHAR(30) NOT NULL DEFAULT 'cash'
                          CHECK (method IN ('cash','upi','card','bank_transfer','other')),
  reference_no          VARCHAR(100),
  paid_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                 TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_estimate   ON purchase_invoices(estimate_id);
CREATE INDEX IF NOT EXISTS idx_pi_hub        ON purchase_invoices(hub_id);
CREATE INDEX IF NOT EXISTS idx_ci_pi         ON customer_invoices(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_ci_mobile     ON customer_invoices(mobile);
CREATE INDEX IF NOT EXISTS idx_cip_invoice   ON customer_invoice_payments(customer_invoice_id);
