-- Migration 082: Standalone estimates (no appointment required)
--
-- Historically every estimate required a linked appointment
-- (estimates.appointment_id NOT NULL), and all customer/vehicle context was
-- read via `LEFT JOIN appointments a ON a.id = e.appointment_id`.
--
-- This migration lets an estimate exist on its own: appointment_id becomes
-- nullable, and estimates gains its own copy of the customer + vehicle
-- columns (mirroring appointments' shape exactly) so a standalone estimate
-- can carry its own context instead of borrowing an appointment's.
--
-- When appointment_id IS NOT NULL, these new columns are left null and the
-- appointment remains the source of truth (unchanged behavior).
-- When appointment_id IS NULL, these new columns ARE the source of truth.
-- Application-level validation (estimates.controller.js) enforces that at
-- least one of the two is present — this is not enforced by a DB CHECK
-- constraint because it would need to special-case NULL appointment_id
-- alongside NOT NULL mobile, which Zod already does more clearly.

ALTER TABLE estimates
  ALTER COLUMN appointment_id DROP NOT NULL;

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(160),
  ADD COLUMN IF NOT EXISTS mobile           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS whatsapp         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS vehicle_number   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS vehicle_type_id  INTEGER REFERENCES vehicle_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS make_id          INTEGER REFERENCES vehicle_makes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model_id         INTEGER REFERENCES vehicle_models(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS body_type_id     INTEGER REFERENCES body_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS segment_ids      INTEGER[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cc_category_id   INTEGER REFERENCES cc_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimates_mobile ON estimates (mobile);
