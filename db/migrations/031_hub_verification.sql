-- ── Migration 031: Hub Verification Workflow ─────────────────────────────────
--
-- Adds a verification lifecycle to hubs:
--   pending   → newly created, awaiting review
--   verified  → approved by admin / MANAGE_HUBS user (can now be activated)
--   rejected  → rejected with a reason; employee can edit → resets to pending
--
-- is_active default changed to FALSE so new hubs are inactive until verified
-- and explicitly activated.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add verification columns
ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS verification_status  VARCHAR(15)  NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  ADD COLUMN IF NOT EXISTS verified_by          INTEGER      REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT;

-- 2. All existing hubs are already live — mark them verified so nothing breaks
UPDATE hubs
  SET verification_status = 'verified',
      verified_at         = NOW()
  WHERE deleted_at IS NULL;

-- 3. Change is_active default to FALSE for new hubs
ALTER TABLE hubs
  ALTER COLUMN is_active SET DEFAULT FALSE;

-- 4. Index for fast filtering by status
CREATE INDEX IF NOT EXISTS idx_hubs_verification_status
  ON hubs (verification_status)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN hubs.verification_status IS 'pending = awaiting review; verified = approved; rejected = needs rework';
COMMENT ON COLUMN hubs.verified_by         IS 'User ID who verified or rejected this hub';
COMMENT ON COLUMN hubs.verified_at         IS 'Timestamp of last verification action';
COMMENT ON COLUMN hubs.rejection_reason    IS 'Reason given when hub was rejected';

COMMIT;
