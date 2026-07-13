-- 086_customer_identities.sql
--
-- Gives every customer a stable, opaque, non-PII routing identifier
-- (public_token) so /customers/:token URLs never expose a mobile number.
--
-- Deliberately a NEW table, not a column on customer_profiles:
-- customer_profiles represents filled-in profile data (display name,
-- email, notes, B2B details) and may legitimately not have a row for a
-- mobile number that has only ever appeared on an appointment/estimate/
-- invoice. A "customer" in this app is really just a mobile number shared
-- across appointments, customer_invoices, and standalone estimates — the
-- token identity needs to exist for ALL of those mobiles, whether or not a
-- customer_profiles row has ever been created for them.
--
-- Backfilled once (see backend/scripts/backfill-tokens.js) from every
-- distinct mobile seen across appointments, customer_invoices, and
-- standalone estimates. New mobiles get a row created the first time
-- they're seen (wired into the relevant create-controllers).

CREATE TABLE IF NOT EXISTS customer_identities (
  mobile        VARCHAR(20)  PRIMARY KEY,
  public_token  VARCHAR(20)  NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_identities_public_token
  ON customer_identities(public_token);
