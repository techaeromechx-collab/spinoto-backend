-- ── Migration 028: Work Execution — estimate work_status & status expansion ──
--
-- ABSORBED INTO MIGRATION 052: estimate_items is now created with work_status
-- and estimates is created with the full status list in 052_estimates.sql.
--
-- On existing DBs where these tables already exist without these columns/constraints,
-- the DO blocks below apply the changes safely. On fresh DBs they are no-ops.

-- 1. Add work_status to estimate_items if missing
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'estimate_items')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'estimate_items' AND column_name = 'work_status')
  THEN
    ALTER TABLE estimate_items
      ADD COLUMN work_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (work_status IN ('pending', 'in_progress', 'completed'));
  END IF;
END $$;

-- 2. Expand estimates.status to include work states if table exists
DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'estimates') THEN
    FOR r IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'estimates'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%'
        AND pg_get_constraintdef(oid) NOT LIKE '%work_in_progress%'
    LOOP
      EXECUTE 'ALTER TABLE estimates DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'estimates'::regclass AND conname = 'estimates_status_check'
    ) THEN
      ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
        CHECK (status IN (
          'draft','pending_company_review','sent_to_customer',
          'partially_approved','fully_approved','revision_requested',
          'work_in_progress','work_completed'
        ));
    END IF;
  END IF;
END $$;
