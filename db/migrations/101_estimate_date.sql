-- 101_estimate_date.sql
--
-- Phase 5 of the backdating work (PLAN_backdated_job_chain.md). Gives the
-- estimate its own date, the same way 099 gave one to the invoices.
--
-- Why: phases 1-4 let you backdate a customer invoice, but the rule
-- "invoice_date >= estimate.created_at" made that useless for the case that
-- actually matters — entering a job that happened weeks ago. Doing so creates
-- the estimate TODAY, so the invoice could never be dated back to when the
-- work was done.
--
-- With estimate_date the rule becomes "invoice_date >= estimate.estimate_date",
-- which is the same guarantee (an invoice cannot predate the job it bills for)
-- without being an obstacle: backdate the estimate to the day of the work and
-- the whole chain follows.
--
-- Same column shape, same IST backfill and the same ::text-at-read convention
-- as 099/100, so there is one pattern in this codebase rather than two.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS estimate_date DATE;

-- IST, not UTC. created_at::date pushes roughly 5.5 hours of every day's rows
-- back a day; see the note in 099.
UPDATE estimates
   SET estimate_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
 WHERE estimate_date IS NULL;

ALTER TABLE estimates
  ALTER COLUMN estimate_date SET DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  ALTER COLUMN estimate_date SET NOT NULL;

-- Provenance. original_estimate_date is doing double duty: it records where
-- the estimate started, AND it is the flag that says "this job was entered
-- retroactively" — which is what decides whether a PI or CI generated later
-- inherits this date or uses today. See PLAN §2.1.
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS original_estimate_date DATE,
  ADD COLUMN IF NOT EXISTS backdate_reason        TEXT,
  ADD COLUMN IF NOT EXISTS backdated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backdated_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by             INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- id tiebreaker for the same reason as 099: many estimates share a date, and
-- ORDER BY date alone makes OFFSET pagination repeat and skip rows.
CREATE INDEX IF NOT EXISTS idx_est_estimate_date
  ON estimates (estimate_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_est_backdated
  ON estimates (estimate_date DESC, id DESC)
  WHERE original_estimate_date IS NOT NULL;
