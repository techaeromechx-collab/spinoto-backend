-- 100_invoice_backdating.sql
--
-- Phases 2 and 3 of SPEC_backdated_customer_invoice.md. Migration 099 made
-- invoice_date a real column that everything reads; this one adds what is
-- needed to WRITE a different value into it safely.
--
-- Two independent things:
--   1. The books lock — the only mechanism that can stop a backdated entry
--      landing in a period already filed with GST. Useful on its own.
--   2. Backdate provenance — who moved a date, when, from what, and why.
--
-- Provenance lives on the row as well as in activity_logs because
-- activity_logs has only a free-text description column (no old/new value
-- fields), and "show me every backdated invoice and its reason" needs to be a
-- query, not a text search.

-- ── Books lock + the backdating window (company_settings) ───────────────────

ALTER TABLE company_settings
  -- Books are closed on and before this date. NULL = nothing locked, which is
  -- the correct starting state: locking retroactively on install would block
  -- corrections to periods the company never agreed were closed.
  ADD COLUMN IF NOT EXISTS books_locked_through DATE,
  ADD COLUMN IF NOT EXISTS books_locked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS books_locked_at      TIMESTAMPTZ,

  -- How far back a normal user may date an invoice. The books lock is the
  -- real protection; this is the everyday guard rail that stops a typo
  -- ("2025" instead of "2026") becoming an accounting problem.
  ADD COLUMN IF NOT EXISTS backdate_max_days    INTEGER NOT NULL DEFAULT 30;

ALTER TABLE company_settings
  DROP CONSTRAINT IF EXISTS chk_backdate_max_days;
ALTER TABLE company_settings
  ADD CONSTRAINT chk_backdate_max_days
    CHECK (backdate_max_days >= 0 AND backdate_max_days <= 3650);

-- ── Backdate provenance (customer_invoices) ─────────────────────────────────

ALTER TABLE customer_invoices
  -- The date this invoice WOULD have had. Set once, on the first backdate, and
  -- never overwritten by later corrections — so it always answers "what did
  -- this become, from what", not "what was it last time someone touched it".
  ADD COLUMN IF NOT EXISTS original_invoice_date DATE,
  ADD COLUMN IF NOT EXISTS backdate_reason       TEXT,
  ADD COLUMN IF NOT EXISTS backdated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backdated_at          TIMESTAMPTZ,
  -- This table has never recorded who changed it. It does now.
  ADD COLUMN IF NOT EXISTS updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS original_invoice_date DATE,
  ADD COLUMN IF NOT EXISTS backdate_reason       TEXT,
  ADD COLUMN IF NOT EXISTS backdated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backdated_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Partial indexes: backdated invoices are the exception, so the index only
-- carries them. Powers the compliance report and the "backdated" filter.
CREATE INDEX IF NOT EXISTS idx_ci_backdated
  ON customer_invoices (invoice_date DESC, id DESC)
  WHERE original_invoice_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pi_backdated
  ON purchase_invoices (invoice_date DESC, id DESC)
  WHERE original_invoice_date IS NOT NULL;

-- ── Why there is no "not in the future" CHECK constraint ────────────────────
--
-- The obvious guard rail would be CHECK (invoice_date <= CURRENT_DATE), but
-- Postgres rejects it: functions in a CHECK constraint must be IMMUTABLE and
-- CURRENT_DATE is only STABLE (error 42P17). That restriction is correct —
-- a row valid at INSERT would silently become invalid tomorrow, and a dump
-- and restore could then fail to reload rows the database itself created.
--
-- So "not in the future" is enforced in the application only, in
-- utils/invoiceDate.js, which every write path goes through.
