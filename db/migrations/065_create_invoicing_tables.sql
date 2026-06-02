-- Migration 065: Create invoicing tables (canonical numbered migration)
--
-- Ports the unnumbered /backend/migrations/create_invoicing_tables.sql into the
-- numbered series, with all columns accumulated by later ALTER migrations included
-- from the start so a fresh Neon DB gets a complete schema in one pass.
--
-- Columns absorbed from other migrations:
--   029  → purchase_invoices.payout_due_date, payout_schedule
--          + pi_payment_schedule table
--   033  → purchase_invoices.rate_mode
--   036  → customer_invoices status CHECK includes 'approved'
--   055  → customer_invoices.purchase_invoice_id nullable; uq_ci_estimate_id
--   056  → customer_invoice_items.hsn_sac
--   058  → customer_invoice_items discount columns
--          + customer_invoices header discount columns
--
-- All statements use IF NOT EXISTS / IF EXISTS so this is safe to re-run on
-- existing DBs that already have tables from the old unnumbered migration.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Purchase Invoices ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                  SERIAL PRIMARY KEY,
  estimate_id         INTEGER NOT NULL REFERENCES estimates(id),
  appointment_id      INTEGER REFERENCES appointments(id),
  hub_id              INTEGER NOT NULL REFERENCES hubs(id),
  commission_percent  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  rate_mode           VARCHAR(20)   NOT NULL DEFAULT 'commission',   -- from 033
  status              VARCHAR(30)   NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval','approved','cancelled')),
  subtotal_ex_gst     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gst           NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_due_date     DATE,                                           -- from 029
  payout_schedule     VARCHAR(10)   DEFAULT 'lump_sum'
                        CHECK (payout_schedule IN ('lump_sum','split')),  -- from 029
  notes               TEXT,
  approved_by         INTEGER REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(estimate_id)
);

-- ── Purchase Invoice Items ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id                    SERIAL PRIMARY KEY,
  purchase_invoice_id   INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  estimate_item_id      INTEGER REFERENCES estimate_items(id),
  item_type             VARCHAR(20)   NOT NULL,
  description           VARCHAR(300)  NOT NULL,
  quantity              NUMERIC(10,2) NOT NULL,
  customer_rate         NUMERIC(10,2) NOT NULL,
  commission_percent    NUMERIC(5,2)  NOT NULL,
  hub_rate              NUMERIC(10,2) NOT NULL,
  gst_percent           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_payable         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── PI Payment Schedule (from migration 029) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS pi_payment_schedule (
  id                   SERIAL        PRIMARY KEY,
  purchase_invoice_id  INTEGER       NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  installment_no       INTEGER       NOT NULL,
  amount_due           NUMERIC(12,2) NOT NULL,
  due_date             DATE          NOT NULL,
  paid_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  status               VARCHAR(15)   NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','partially_paid','paid')),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_invoice_id, installment_no)
);

-- ── Customer Invoices ─────────────────────────────────────────────────────────
-- purchase_invoice_id is nullable (decoupled per migration 055)
-- status includes 'approved' (added in migration 036)
-- header discount columns from migration 058
CREATE TABLE IF NOT EXISTS customer_invoices (
  id                      SERIAL PRIMARY KEY,
  purchase_invoice_id     INTEGER REFERENCES purchase_invoices(id),  -- nullable (055)
  estimate_id             INTEGER REFERENCES estimates(id),
  appointment_id          INTEGER REFERENCES appointments(id),
  hub_id                  INTEGER REFERENCES hubs(id),
  customer_name           VARCHAR(160),
  mobile                  VARCHAR(20),
  vehicle_number          VARCHAR(30),
  status                  VARCHAR(30) NOT NULL DEFAULT 'generated'
                            CHECK (status IN ('generated','approved','partially_paid','paid','cancelled')),
  subtotal_ex_gst         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gst               NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total             NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid             NUMERIC(12,2) NOT NULL DEFAULT 0,
  header_discount_type    VARCHAR(10)   DEFAULT NULL
                            CHECK (header_discount_type IN ('percent','flat')),  -- from 058
  header_discount_value   NUMERIC(10,2) NOT NULL DEFAULT 0,                      -- from 058
  header_discount_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,                      -- from 058
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ci_estimate_id UNIQUE (estimate_id)                -- from 055
);

-- ── Customer Invoice Items ────────────────────────────────────────────────────
-- hsn_sac from migration 056; discount columns from migration 058
CREATE TABLE IF NOT EXISTS customer_invoice_items (
  id                    SERIAL PRIMARY KEY,
  customer_invoice_id   INTEGER       NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  estimate_item_id      INTEGER       REFERENCES estimate_items(id),
  item_type             VARCHAR(20)   NOT NULL,
  description           VARCHAR(300)  NOT NULL,
  quantity              NUMERIC(10,2) NOT NULL,
  customer_rate         NUMERIC(10,2) NOT NULL,
  gst_percent           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_inc_gst         NUMERIC(10,2) NOT NULL DEFAULT 0,
  hsn_sac               VARCHAR(20)   DEFAULT NULL,                  -- from 056
  discount_type         VARCHAR(10)   DEFAULT NULL
                          CHECK (discount_type IN ('percent','flat')),  -- from 058
  discount_value        NUMERIC(10,2) NOT NULL DEFAULT 0,             -- from 058
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,             -- from 058
  discount_source       VARCHAR(10)   DEFAULT NULL
                          CHECK (discount_source IN ('master','manual')),  -- from 058
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Customer Invoice Payments ─────────────────────────────────────────────────
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

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pi_estimate        ON purchase_invoices(estimate_id);
CREATE INDEX IF NOT EXISTS idx_pi_hub             ON purchase_invoices(hub_id);
CREATE INDEX IF NOT EXISTS idx_pi_schedule_pi_id  ON pi_payment_schedule(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_pi_schedule_due    ON pi_payment_schedule(due_date);
CREATE INDEX IF NOT EXISTS idx_pi_schedule_status ON pi_payment_schedule(status);
CREATE INDEX IF NOT EXISTS idx_ci_pi              ON customer_invoices(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_ci_estimate        ON customer_invoices(estimate_id);
CREATE INDEX IF NOT EXISTS idx_ci_mobile          ON customer_invoices(mobile);
CREATE INDEX IF NOT EXISTS idx_cip_invoice        ON customer_invoice_payments(customer_invoice_id);

COMMIT;
