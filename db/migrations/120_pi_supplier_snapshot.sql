-- Migration 120: supplier identity and GST determination snapshotted onto
-- purchase invoices.
--
-- WHY EACH COLUMN EXISTS
-- ──────────────────────
-- A purchase invoice IS the hub's sales invoice — the hub supplies, Spinoto
-- buys. Everything a tax invoice says about the supplier therefore has to be
-- frozen at the moment the invoice is raised, exactly as customer_name and
-- vehicle_number are already frozen onto customer_invoices. If a hub moves
-- premises, corrects its GSTIN, or registers for GST next March, an invoice
-- issued last year must not silently change to say so.
--
-- Until now PI_SELECT joined `hubs` live for hub_name and gst_number, which
-- means every historical invoice re-renders with today's values.
--
--   hub_legal_name / hub_address / hub_gstin
--       The supplier block. hub_address is denormalised to text on purpose:
--       reconstructing it later from address_line1 + city + state + pincode
--       would re-introduce the live-join problem for four more columns.
--
--   hub_has_gst
--       Decides tax invoice vs bill of supply. A hub that registers later must
--       not retroactively grow a tax line on old documents.
--
--   supplier_state_code / place_of_supply_code / place_of_supply_name
--       The CGST+SGST vs IGST determination. Migration 097 added place-of-
--       supply columns to customer_invoices and estimates and skipped purchase
--       invoices, so this document had nowhere to record its own answer and
--       fell back to computing it from the WRONG party — Spinoto's state on
--       both sides of the comparison. On a hub's invoice the supplier is the
--       hub and the recipient is Spinoto, so a Maharashtra hub billing a
--       Gujarat company owes IGST while the document printed CGST+SGST. Right
--       total, wrong heads, and it propagates into the hub's GSTR-1.
--
-- All nullable. Existing rows keep NULL and the render falls back to the live
-- join, so nothing breaks before the backfill runs and no invoice is left
-- blank in the meantime.

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS hub_legal_name        VARCHAR(200),
  ADD COLUMN IF NOT EXISTS hub_address           TEXT,
  ADD COLUMN IF NOT EXISTS hub_gstin             VARCHAR(15),
  ADD COLUMN IF NOT EXISTS hub_has_gst           BOOLEAN,
  ADD COLUMN IF NOT EXISTS supplier_state_code   VARCHAR(2),
  ADD COLUMN IF NOT EXISTS place_of_supply_code  VARCHAR(2),
  ADD COLUMN IF NOT EXISTS place_of_supply_name  VARCHAR(60);

-- Backfill what can be known truthfully.
--
-- hub_has_gst and hub_gstin come from the hub's CURRENT state, which is the
-- best available: the flag was never recorded per invoice, so there is no
-- historical value to recover. Deliberately NOT backfilling hub_address —
-- migration 119 only just added those columns, so every hub's address is NULL
-- and writing an empty snapshot would make the render think it has a real
-- (blank) address instead of falling through to the live join.
--
-- supplier_state_code is derived from the GSTIN's leading two digits, which is
-- what the code already does for the company. That IS the registered state, so
-- it is correct rather than approximate.
UPDATE purchase_invoices pi
   SET hub_has_gst         = COALESCE(pi.hub_has_gst, COALESCE(h.has_gst, FALSE)),
       hub_gstin           = COALESCE(pi.hub_gstin, NULLIF(TRIM(h.gst_number), '')),
       hub_legal_name      = COALESCE(pi.hub_legal_name, NULLIF(TRIM(h.company_name), ''), h.hub_name),
       supplier_state_code = COALESCE(
         pi.supplier_state_code,
         CASE WHEN h.gst_number ~ '^[0-9]{2}' THEN SUBSTRING(TRIM(h.gst_number) FROM 1 FOR 2) END
       )
  FROM hubs h
 WHERE h.id = pi.hub_id
   AND (pi.hub_has_gst IS NULL OR pi.hub_gstin IS NULL OR pi.hub_legal_name IS NULL OR pi.supplier_state_code IS NULL);

-- place_of_supply is left NULL: it is Spinoto's own state, which lives in
-- company_settings, and is resolved at render time. Storing it here would
-- freeze a value that has exactly one correct answer anyway.

COMMENT ON COLUMN purchase_invoices.hub_has_gst IS
  'Hub GST registration AS AT invoice date. FALSE renders a Bill of Supply with no tax. Never recompute from hubs.has_gst.';
COMMENT ON COLUMN purchase_invoices.supplier_state_code IS
  'GST state code of the SUPPLIER (the hub), from its GSTIN. Compared against the recipient (Spinoto) to choose CGST+SGST vs IGST.';
