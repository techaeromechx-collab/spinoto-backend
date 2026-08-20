-- 144_hub_payout_identity.sql
--
-- The gateway's handles for a hub, and whether that hub can actually be paid.
--
-- ── WHAT IS ALREADY HERE, AND WHAT IS NOT ────────────────────────────────────
-- hubs has had bank details since migration 030: bank_account_number, bank_ifsc,
-- bank_name, account_holder_name. They are captured on the Hub form today and
-- printed on paperwork. So this migration does NOT add bank columns — adding a
-- second account number beside the one people have been filling in for a year
-- is how money reaches the wrong account.
--
-- What is missing is everything about PAYING that account through a provider:
--
--   payout_contact_id       the provider's id for "this hub, as a payee"
--   payout_fund_account_id  the provider's id for "this hub's bank account"
--   payout_status           whether the pair above is usable
--
-- ── WHY THE IDS ARE STORED RATHER THAN LOOKED UP ─────────────────────────────
-- Creating a fund account at the provider is NOT idempotent. Re-creating one on
-- every payout leaves a trail of duplicate payees on their side that cannot be
-- cleaned up from here, and each duplicate is a candidate the next lookup might
-- pick. Stored once, reused, and re-created only when the underlying account
-- actually changes.
--
-- ── payout_status, AND WHY A TRIGGER RESETS IT ───────────────────────────────
-- 'unverified' is the default and every existing hub gets it. That is not a
-- defect to hide: on day one nothing is registered with the provider, so nothing
-- is payable, and the screen has to say which hubs are ready rather than failing
-- at the moment somebody presses Pay.
--
-- The account number is money-critical and effectively write-once. If someone
-- edits it while payout_status still reads 'verified', the next payout goes to
-- the OLD registered fund account — the provider has no idea our column changed.
-- The reset is therefore a trigger, not a line in updateHub: hubs are edited
-- from the admin form, from the hub's own self-service PATCH, from an import,
-- and from psql at 2am. A trigger cannot be forgotten by the path added next
-- year; a controller check can, and its failure is silent and expensive.

BEGIN;

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS payout_contact_id      VARCHAR(60),
  ADD COLUMN IF NOT EXISTS payout_fund_account_id VARCHAR(60),
  ADD COLUMN IF NOT EXISTS payout_status          VARCHAR(20) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS payout_registered_at   TIMESTAMPTZ;

COMMENT ON COLUMN hubs.payout_contact_id IS
  'Payout provider''s contact id for this hub. Set by registration, cleared when the bank account changes.';
COMMENT ON COLUMN hubs.payout_fund_account_id IS
  'Payout provider''s fund-account id for this hub''s bank account. Never reused across a changed account.';
COMMENT ON COLUMN hubs.payout_status IS
  'unverified = not registered with the provider (cannot be paid automatically); pending = registration in flight; verified = payable; failed = the provider rejected the account.';

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and this file has to be
-- re-runnable like every other migration here.
DO $$ BEGIN
  ALTER TABLE hubs
    ADD CONSTRAINT hub_payout_status_check
      CHECK (payout_status IN ('unverified','pending','verified','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── The reset trigger ────────────────────────────────────────────────────────
--
-- IS DISTINCT FROM, not <>. A NULL account number becoming '00123' is exactly
-- the case that matters most (a hub getting bank details for the first time),
-- and `NULL <> '00123'` is NULL — which is not true, so a plain <> would skip
-- it. The same trap migration 143's backfill had to avoid.
--
-- The fund account id is cleared as well as the status. Leaving it would mean a
-- re-registration finds a stale id in the column and a payout is sent to the
-- account the hub just stopped using.
CREATE OR REPLACE FUNCTION hub_payout_reset_on_bank_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number
     OR NEW.bank_ifsc IS DISTINCT FROM OLD.bank_ifsc
     OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name
  THEN
    NEW.payout_status          := 'unverified';
    NEW.payout_fund_account_id := NULL;
    NEW.payout_registered_at   := NULL;
    -- payout_contact_id SURVIVES. A contact is the hub as a payee — the name and
    -- the reference — and it does not change when the account behind it does.
    -- Re-creating one per account edit is the duplicate-payee problem this
    -- migration exists to avoid, one level up.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hub_payout_reset ON hubs;
CREATE TRIGGER trg_hub_payout_reset
  BEFORE UPDATE ON hubs
  FOR EACH ROW
  EXECUTE FUNCTION hub_payout_reset_on_bank_change();

-- The payouts screen asks "which hubs can I pay" on every load.
CREATE INDEX IF NOT EXISTS idx_hubs_payout_status
  ON hubs (payout_status) WHERE payout_status <> 'unverified';

COMMIT;
