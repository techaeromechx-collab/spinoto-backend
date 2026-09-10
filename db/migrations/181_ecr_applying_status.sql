-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 181: allow the 'applying' status on estimate_change_requests
--
-- WHY THIS IS A SEPARATE MIGRATION AND NOT AN EDIT TO 180
-- ──────────────────────────────────────────────────────
-- 180 was written, applied, and only then edited to add 'applying' to its CHECK
-- constraint. That edit did nothing on any database where 180 had already run:
-- the whole statement is CREATE TABLE IF NOT EXISTS, so re-running it skips the
-- table entirely and the old constraint survives. Approving a change request
-- then failed on its very first write:
--
--   error: new row for relation "estimate_change_requests" violates check
--          constraint "estimate_change_requests_status_check"
--   detail: Failing row contains (..., applying, ...)
--
-- A migration that has been applied anywhere is history and must not be edited;
-- what it needs is a successor. This is that successor.
--
-- WHAT 'applying' IS FOR
-- ──────────────────────
-- It is the claim a reviewer takes before any writing starts. Approval is one
-- UPDATE that moves the row out of 'pending', so exactly one caller can win it:
-- two people pressing Approve in the same second would otherwise both read
-- 'pending', both pass the check, and both apply the change — discounting the
-- invoice twice.
--
-- A row left sitting in 'applying' means the process died mid-apply. Giving
-- that state a name is what makes it visible, instead of it being a lock
-- nobody can inspect after the fact.
--
-- SAFE TO RUN WHETHER OR NOT 180 ALREADY CARRIED IT
-- ─────────────────────────────────────────────────
-- DROP ... IF EXISTS then ADD, so this converges on the correct constraint from
-- either starting point: a database that ran the original 180, and a fresh one
-- that ran the corrected 180 and already has the full list.
--
-- The constraint name is Postgres's own default for a column CHECK
-- (<table>_<column>_check), which is what 180 produced by writing the CHECK
-- inline — and what the error message above names.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE estimate_change_requests
  DROP CONSTRAINT IF EXISTS estimate_change_requests_status_check;

ALTER TABLE estimate_change_requests
  ADD CONSTRAINT estimate_change_requests_status_check
  CHECK (status IN ('pending','applying','approved','rejected','superseded','failed'));

-- A request that was mid-approval when the old constraint rejected the write
-- was never actually moved — the UPDATE that would have set 'applying' is the
-- statement that failed, so it rolled back and the row is still 'pending'.
-- Nothing to repair. This reports the state so that is visible rather than
-- assumed.
DO $$
DECLARE stuck INT; waiting INT;
BEGIN
  SELECT COUNT(*) INTO stuck   FROM estimate_change_requests WHERE status = 'applying';
  SELECT COUNT(*) INTO waiting FROM estimate_change_requests WHERE status = 'pending';
  RAISE NOTICE 'estimate_change_requests: status check updated. % pending, % mid-apply.', waiting, stuck;
  IF stuck > 0 THEN
    RAISE NOTICE 'Rows in ''applying'' are from a process that died mid-apply. Approve or Reject each from the estimate to clear it.';
  END IF;
END $$;
