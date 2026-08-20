-- Migration 119: postal address on hubs
--
-- WHY
-- ───
-- The hub Sell Invoice is the hub's own GST tax invoice — the hub supplies the
-- work, Spinoto buys it. A tax invoice must carry the SUPPLIER's name, address
-- and GSTIN. Today `hubs` has no address at all: only state_id / city_id /
-- area_id, which are master-data references, plus map_url. "Gujarat ·
-- Ahmedabad · Satellite" is not an address.
--
-- These are nullable on purpose. Making them NOT NULL would fail on every
-- existing row, and the data has to be typed in per hub by a human — there is
-- nothing to derive it from. The document layer renders a visible gap when the
-- address is missing rather than quietly omitting the block, so an invoice
-- without a supplier address looks broken, because it is.
--
-- state/city/area stay as they are. They drive hub search and assignment, and
-- the GST state code comes from the first two digits of the GSTIN anyway (see
-- migration 120), so this is presentation only.

ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(200),
  ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(200),
  ADD COLUMN IF NOT EXISTS pincode       VARCHAR(10);

COMMENT ON COLUMN hubs.address_line1 IS
  'Supplier address printed on the hub''s GST tax invoice. Required for a valid invoice; nullable here because it must be entered per hub.';
