-- ── Migration 030: Hub — new operational & bank detail fields ────────────────
--
-- Adds:
--   hubs.bank_account_number  — bank account number
--   hubs.bank_ifsc            — IFSC code
--   hubs.bank_name            — bank / branch name
--   hubs.account_holder_name  — account holder name
--   hubs.vehicle_capacity     — max vehicles serviceable at one time
--   hubs.workshop_area_sqft   — workshop floor area (sq ft)
--   hubs.no_of_mechanics      — number of mechanics at the hub
--
-- hub_documents.doc_type:
--   Adds 'hub_image' and 'bank_proof' to the allowed CHECK values.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. New columns on hubs ────────────────────────────────────────────────────

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS bank_account_number  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS bank_ifsc            VARCHAR(11),
  ADD COLUMN IF NOT EXISTS bank_name            VARCHAR(150),
  ADD COLUMN IF NOT EXISTS account_holder_name  VARCHAR(150),
  ADD COLUMN IF NOT EXISTS vehicle_capacity     INTEGER CHECK (vehicle_capacity >= 0),
  ADD COLUMN IF NOT EXISTS workshop_area_sqft   NUMERIC(10,2) CHECK (workshop_area_sqft >= 0),
  ADD COLUMN IF NOT EXISTS no_of_mechanics      INTEGER CHECK (no_of_mechanics >= 0);

COMMENT ON COLUMN hubs.bank_account_number IS 'Hub bank account number for payouts';
COMMENT ON COLUMN hubs.bank_ifsc           IS 'IFSC code of the hub bank branch';
COMMENT ON COLUMN hubs.bank_name           IS 'Bank name / branch name';
COMMENT ON COLUMN hubs.account_holder_name IS 'Name as on the bank account';
COMMENT ON COLUMN hubs.vehicle_capacity    IS 'Max number of vehicles that can be serviced simultaneously';
COMMENT ON COLUMN hubs.workshop_area_sqft  IS 'Total operational floor area of the workshop in square feet';
COMMENT ON COLUMN hubs.no_of_mechanics     IS 'Number of mechanics employed at this hub';

-- ── 2. Expand hub_documents.doc_type CHECK constraint ────────────────────────
-- PostgreSQL does not support ALTER COLUMN ... SET CHECK on an existing
-- named constraint in-place. We drop the old one and add a new one.

ALTER TABLE hub_documents
  DROP CONSTRAINT IF EXISTS hub_documents_doc_type_check;

ALTER TABLE hub_documents
  ADD CONSTRAINT hub_documents_doc_type_check
    CHECK (doc_type IN (
      'aadhaar',
      'pan',
      'driving_license',
      'agreement',
      'gst_certificate',
      'hub_image',
      'bank_proof'
    ));

COMMIT;
