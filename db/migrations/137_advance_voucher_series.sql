-- Migration 137: the advance receipt number series.
--
-- WHY THIS SHIPS BEFORE ANYTHING PRINTS
-- ─────────────────────────────────────
-- The receipt document itself is built in a later phase. The NUMBER is not
-- deferrable: it has to be issued from the very first advance ever taken.
--
-- Adding a consecutive series afterwards means numbering tax receipts that
-- were already given to customers, retrospectively, in whatever order a
-- backfill query happens to produce. That is precisely the thing a consecutive
-- series exists to make impossible. So the sequence exists from the start and
-- every advance draws from it, whether or not a PDF is rendered yet.
--
-- THE THREE RULES
-- ───────────────
-- 1. ISSUED ON CAPTURE, NEVER ON CREATION.
--    A customer who opens a payment link and closes it must not consume a
--    number. Otherwise the series has holes, and a hole in a tax series is
--    something somebody has to explain later.
--
-- 2. ISSUED UNDER A ROW LOCK, INSIDE THE CAPTURE TRANSACTION.
--    Two customers paying in the same second must not receive the same number.
--    SELECT … FOR UPDATE on the sequence row serialises them; the unique index
--    on customer_invoice_payments.voucher_no (migration 135) is the guarantee
--    behind it, because it does not depend on application code being correct.
--
-- 3. NEVER RENUMBERED, NEVER REUSED.
--    A cancelled advance keeps its number and is answered by a refund voucher,
--    not by deleting the original.
--
-- PER HUB OR COMPANY-WIDE?
-- ────────────────────────
-- hub_id is nullable and the unique key is (hub_id, fy), which supports both:
--
--   company-wide   every row has hub_id NULL — one series per year
--   per hub        one row per hub per year, as hub_invoice_sequences does
--
-- The service decides by reading company settings. Company-wide is the default
-- because an advance is a customer-facing receipt like a tax invoice, and
-- customer invoices in this system are numbered company-wide. Purchase
-- invoices are per hub because a hub is the supplier on those.
--
-- Deliberately a separate table from hub_invoice_sequences rather than a
-- doc_type column added to it: that table serialises purchase invoice writes,
-- and making advance receipts contend for the same rows would couple two
-- unrelated flows at their busiest moment.

CREATE TABLE IF NOT EXISTS advance_voucher_sequences (
  id          SERIAL PRIMARY KEY,

  -- NULL = the company-wide series. Not a foreign key gap: a hub deleted after
  -- issuing receipts must not take its numbering with it.
  hub_id      INTEGER REFERENCES hubs(id) ON DELETE SET NULL,

  -- Indian financial year, April to March: '2026-27'.
  fy          VARCHAR(9) NOT NULL,

  -- The NEXT number to hand out. Read and incremented under FOR UPDATE.
  next_seq    INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),

  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per series. The partial index handles the company-wide case, because
-- a plain UNIQUE treats every NULL hub_id as distinct and would let a second
-- company-wide row be created for the same year — two rows handing out the
-- same numbers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_avs_hub_fy
  ON advance_voucher_sequences (hub_id, fy) WHERE hub_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_avs_company_fy
  ON advance_voucher_sequences (fy) WHERE hub_id IS NULL;

COMMENT ON TABLE advance_voucher_sequences IS
  'Consecutive receipt numbers for advance payments, per financial year. hub_id NULL is the company-wide series (the default). Numbers are issued ON CAPTURE only, under SELECT … FOR UPDATE, inside the capturing transaction — an abandoned payment link must never consume one, because a gap in a tax series has to be accounted for.';
COMMENT ON COLUMN advance_voucher_sequences.next_seq IS
  'The next number to issue, not the last issued. Read and incremented in one locked step.';
