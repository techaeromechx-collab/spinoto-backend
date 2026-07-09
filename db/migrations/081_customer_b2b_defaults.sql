-- Migration 081: Saved B2B billing defaults on customer_profiles
--
-- Lets a customer's GST billing details (set on an estimate) be reused as an
-- autofill default on their future estimates, without re-typing every time.
-- This is a convenience cache, not the source of truth — the estimate's own
-- is_b2b/b2b_* fields (added in migration 080) always win for that invoice.

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS default_is_b2b            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_b2b_company_name  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS default_b2b_gst_number    VARCHAR(15),
  ADD COLUMN IF NOT EXISTS default_b2b_address       TEXT;
