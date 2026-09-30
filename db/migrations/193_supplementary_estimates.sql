-- Migration 193: supplementary estimates.
--
-- ══ THE PROBLEM ════════════════════════════════════════════════════════════
--
-- Work discovered mid-job has nowhere to go. A car comes in for a service, the
-- wheel comes off and the disc is scored — and because migration 075 put a
-- UNIQUE index on estimates(appointment_id), the only way to bill the extra
-- work is to EDIT the estimate the customer already approved.
--
-- That is the worst possible answer. The document the customer agreed to is
-- silently rewritten, the approval now covers work they never saw, and there
-- is no record that anything was added.
--
-- ══ WHY THE GUARD BECOMES PARTIAL RATHER THAN DISAPPEARING ═════════════════
--
-- The obvious move is to drop uq_estimates_appointment_id. That would also
-- drop the protection it was added for: two estimates created for one
-- appointment BY ACCIDENT — a double-submitted form, a retried request — which
-- is what migration 075 exists to make impossible at the database level.
--
-- So the index is replaced, not removed:
--
--     UNIQUE (appointment_id) WHERE parent_estimate_id IS NULL
--
-- Exactly one ORIGINAL estimate per visit, still enforced by Postgres and
-- still impossible to violate from application code. Any number of
-- supplementaries, each of which must name the estimate it extends. An
-- accidental duplicate has no parent, so it still collides. A deliberate
-- supplementary does, so it does not.
--
-- ══ ON DELETE RESTRICT, NOT CASCADE ════════════════════════════════════════
--
-- parent_estimate_id RESTRICTs. Deleting an estimate that has supplementaries
-- hanging off it would orphan work that may already be invoiced and paid.
-- The supplementaries go first, deliberately, or nothing goes.

BEGIN;

ALTER TABLE estimates
  -- The estimate this one extends. NULL = this IS the original.
  ADD COLUMN IF NOT EXISTS parent_estimate_id INTEGER
    REFERENCES estimates(id) ON DELETE RESTRICT,
  -- Denormalised link to the visit's job card. Nullable and SET NULL: plenty
  -- of estimates have no job card (every one raised before this module, and
  -- every standalone estimate), and deleting a card must not delete the
  -- financial document that came out of the work.
  ADD COLUMN IF NOT EXISTS job_card_id INTEGER
    REFERENCES job_cards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimates_parent   ON estimates (parent_estimate_id)
  WHERE parent_estimate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_job_card ON estimates (job_card_id)
  WHERE job_card_id IS NOT NULL;

-- ── The guard, narrowed ────────────────────────────────────────────────────
-- Dropped and recreated in one transaction: between the two statements there
-- is no window in which a duplicate could be inserted, because nothing else
-- can see the intermediate state.
DROP INDEX IF EXISTS uq_estimates_appointment_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_appointment_original
  ON estimates (appointment_id)
  WHERE parent_estimate_id IS NULL;

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Every existing estimate is an original — there was no other kind — so
-- parent_estimate_id stays NULL and the new index accepts all of them
-- unchanged. Only job_card_id needs filling, and only where a card exists.
UPDATE estimates e
   SET job_card_id = jc.id
  FROM job_cards jc
 WHERE jc.appointment_id = e.appointment_id
   AND e.job_card_id IS NULL;

COMMENT ON COLUMN estimates.parent_estimate_id IS
  'The estimate this one extends. NULL means this IS the original. One level only - a supplementary cannot itself have supplementaries, enforced in the controller, so the total for a visit is always original + its direct children.';
COMMENT ON COLUMN estimates.job_card_id IS
  'The visit''s job card, denormalised. SET NULL on delete: an estimate is a financial document and must outlive the card it came from.';

DO $$
DECLARE n_est INTEGER; n_linked INTEGER; n_dupe INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_est    FROM estimates;
  SELECT COUNT(*) INTO n_linked FROM estimates WHERE job_card_id IS NOT NULL;
  -- If this is ever non-zero the new index would have refused to build, so it
  -- is really a statement that the migration could not have half-applied.
  SELECT COUNT(*) INTO n_dupe FROM (
    SELECT appointment_id FROM estimates
     WHERE appointment_id IS NOT NULL AND parent_estimate_id IS NULL
     GROUP BY appointment_id HAVING COUNT(*) > 1) d;
  RAISE NOTICE '193: supplementary estimates ready. % estimate(s), % linked to a job card, % duplicate original(s).',
               n_est, n_linked, n_dupe;
END $$;

COMMIT;
