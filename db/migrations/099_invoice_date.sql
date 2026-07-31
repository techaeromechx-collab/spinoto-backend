-- 099_invoice_date.sql
--
-- Separates the LEGAL date of an invoice from the SYSTEM record of when the
-- row was made. Phase 1 of the backdated-invoice work (SPEC_backdated_customer
-- _invoice.md) — this migration and the retrofit that accompanies it change no
-- behaviour at all: invoice_date is backfilled to exactly the date created_at
-- already displayed, and nothing can write a different value yet.
--
-- Why a new column rather than letting created_at be edited:
--
--   * created_at is the only evidence that a backdate ever happened. Overwrite
--     it and the audit trail is gone — permanently, and precisely for the rows
--     an auditor would ask about.
--   * utils/math.js switches rounding mode on a hardcoded 2026-07-07 cutover,
--     keyed on created_at. syncCustomerInvoiceFromEstimate re-runs that on
--     every re-sync. If created_at could move to before the cutover, re-syncing
--     a backdated invoice would silently change the totals of a document
--     already issued to a customer.
--   * The customer timeline, vehicle history and price history all order by
--     created_at and want genuine chronology, not the claimed date.
--
-- The rule the codebase now follows:
--
--   invoice_date  — the legal/accounting date. Everything a customer,
--                   accountant or auditor sees: reports, list filters, CSV
--                   export, the printed document, warranty start.
--   created_at    — the system record. Ordering of internal events, the
--                   rounding cutover, "when did this row appear".
--
-- purchase_invoices gets the same column because a PI's date follows its CI's
-- when the user opts in (decision 5). The PI is a real document with its own
-- date, so it needs its own field rather than reading through to the CI.

-- ── customer_invoices ───────────────────────────────────────────────────────

-- DATE, not TIMESTAMPTZ. An invoice date is a calendar day, not an instant.
-- The pool sets no session timezone (Neon defaults to UTC) while the business
-- runs on IST, so any timestamp here would reopen the midnight-boundary bug
-- class that utils/payoutSchedule.js already had to be fixed for once. A DATE
-- has no time-of-day to be shifted.
ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS invoice_date DATE;

-- Backfill in IST, not UTC. An invoice raised at 01:30 IST is stored as the
-- previous day in UTC; created_at::date would silently move it back a day for
-- roughly 5.5 hours of every day's invoices.
UPDATE customer_invoices
   SET invoice_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
 WHERE invoice_date IS NULL;

-- Default applied only after the backfill, so existing rows take their real
-- date rather than today's.
ALTER TABLE customer_invoices
  ALTER COLUMN invoice_date SET DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  ALTER COLUMN invoice_date SET NOT NULL;

-- ── purchase_invoices ───────────────────────────────────────────────────────

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS invoice_date DATE;

UPDATE purchase_invoices
   SET invoice_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
 WHERE invoice_date IS NULL;

ALTER TABLE purchase_invoices
  ALTER COLUMN invoice_date SET DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  ALTER COLUMN invoice_date SET NOT NULL;

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- The id tiebreaker is not decoration. Many invoices share a date, and
-- ORDER BY invoice_date DESC alone gives Postgres no stable order between
-- them — which makes keyset/OFFSET pagination duplicate and skip rows.
-- Every ORDER BY on this column in the app carries the same tiebreaker.
CREATE INDEX IF NOT EXISTS idx_ci_invoice_date
  ON customer_invoices (invoice_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_pi_invoice_date
  ON purchase_invoices (invoice_date DESC, id DESC);
