-- 085_public_tokens.sql
--
-- Adds a random, non-enumerable "public_token" identifier to the entities
-- that will get real, shareable, bookmarkable detail-page URLs
-- (e.g. /estimates/:token instead of state-only navigation).
--
-- This is deliberately separate from the existing appointment_code/hub_code
-- columns (084_hub_appointment_codes.sql): those are sequential,
-- human-readable BUSINESS codes meant for display. public_token is an
-- opaque, random ROUTING identifier with no business meaning — it exists
-- purely so a URL can point at a record without exposing the row's
-- sequential numeric id (enumerable) or any PII.
--
-- The existing numeric `id` columns are untouched and remain the internal
-- FK/join key everywhere. public_token is purely an additive lookup key.
--
-- Customers are handled separately in 086_customer_identities.sql, since
-- customer_profiles.mobile is itself the primary key (no surrogate id, and
-- no profile row exists for many mobiles that only appear via appointments).
--
-- See: backend/src/utils/publicToken.js

ALTER TABLE leads ADD COLUMN IF NOT EXISTS public_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_public_token
  ON leads(public_token) WHERE public_token IS NOT NULL;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS public_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_public_token
  ON appointments(public_token) WHERE public_token IS NOT NULL;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS public_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_public_token
  ON estimates(public_token) WHERE public_token IS NOT NULL;

ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS public_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_invoices_public_token
  ON purchase_invoices(public_token) WHERE public_token IS NOT NULL;

ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS public_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_invoices_public_token
  ON customer_invoices(public_token) WHERE public_token IS NOT NULL;
