-- Migration 184: store the place of supply on every customer invoice.
--
-- WHY THE COLUMN IS EMPTY ON ALL 264 EXISTING INVOICES
-- ────────────────────────────────────────────────────
-- Not because nobody filled it in. customer_invoices.controller.js calls
-- stateName(code) when saving the field, but stateName was never added to the
-- require on line 32 — only resolvePlaceOfSupply, isInterState and splitGst
-- were. Any attempt to set a place of supply threw ReferenceError, the
-- transaction rolled back, and the column stayed NULL. That import is fixed in
-- the same change as this migration; without the fix, this backfill would be
-- undone the first time anyone edited an invoice.
--
-- WHY THE DATA IS RECOVERABLE
-- ───────────────────────────
-- The place of supply was never unknown, only unstored. utils/gstStates.js has
-- resolved it at render time all along, in this order:
--
--   1. an explicit place_of_supply_code on the row   (nothing to do)
--   2. the B2B customer's GSTIN — first two digits ARE the state code
--   3. the supplier's own state — an unregistered walk-in at the workshop is
--      an intra-state supply, which is the ordinary case here
--
-- This migration writes down what that function already returns. It is not a
-- guess and it is not a new rule: the PDF has been computing exactly this.
--
-- ON THE CURRENT DATA this resolves to 24 (Gujarat) for every single invoice.
-- The company GSTIN starts 24, and all 24 B2B customer GSTINs start 24 too —
-- every supply to date is intra-state, CGST + SGST, no IGST anywhere.
--
-- SCOPE — deliberately narrow
-- ───────────────────────────
-- Only rows where place_of_supply_code IS NULL or blank. An explicit code
-- somebody chose by hand is never overwritten. Nothing else on the invoice is
-- touched — no totals, no status, no dates. Idempotent: the second run matches
-- no rows.
--
-- The states table is deliberately NOT touched. It holds one row (Gujarat,
-- 'GJ') and drives the customer address cascade, which is a different concern
-- from GST state codes. gstStates.js is the single source of truth for those.

BEGIN;

-- The code→name map, as of this migration. A snapshot on purpose: a document
-- keeps the state name it was issued with even if the map is later corrected.
-- Mirrors STATE_CODES in src/utils/gstStates.js.
CREATE TEMP TABLE _gst_states (code TEXT PRIMARY KEY, name TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO _gst_states (code, name) VALUES
  ('01','Jammu and Kashmir'), ('02','Himachal Pradesh'), ('03','Punjab'),
  ('04','Chandigarh'), ('05','Uttarakhand'), ('06','Haryana'), ('07','Delhi'),
  ('08','Rajasthan'), ('09','Uttar Pradesh'), ('10','Bihar'), ('11','Sikkim'),
  ('12','Arunachal Pradesh'), ('13','Nagaland'), ('14','Manipur'),
  ('15','Mizoram'), ('16','Tripura'), ('17','Meghalaya'), ('18','Assam'),
  ('19','West Bengal'), ('20','Jharkhand'), ('21','Odisha'),
  ('22','Chhattisgarh'), ('23','Madhya Pradesh'), ('24','Gujarat'),
  ('25','Daman and Diu'), ('26','Dadra and Nagar Haveli and Daman and Diu'),
  ('27','Maharashtra'), ('28','Andhra Pradesh (Old)'), ('29','Karnataka'),
  ('30','Goa'), ('31','Lakshadweep'), ('32','Kerala'), ('33','Tamil Nadu'),
  ('34','Puducherry'), ('35','Andaman and Nicobar Islands'), ('36','Telangana'),
  ('37','Andhra Pradesh'), ('38','Ladakh'), ('96','Other Country'),
  ('97','Other Territory');

-- The supplier's own state, from the company GSTIN. NULL if the GSTIN is not
-- set or not a recognised code — in which case rule 3 below cannot fire and
-- those rows are left alone rather than being given a made-up state.
CREATE TEMP TABLE _supplier (code TEXT) ON COMMIT DROP;
INSERT INTO _supplier (code)
SELECT s.code
  FROM company_settings cs
  JOIN _gst_states s ON s.code = LEFT(TRIM(cs.gstin), 2)
 WHERE NULLIF(TRIM(cs.gstin), '') IS NOT NULL
 LIMIT 1;

-- ── Rule 2: a registered B2B recipient — the GSTIN carries the state ────────
UPDATE customer_invoices ci
   SET place_of_supply_code = s.code,
       place_of_supply_name = s.name,
       updated_at           = NOW()
  FROM _gst_states s
 WHERE NULLIF(TRIM(ci.place_of_supply_code), '') IS NULL
   AND ci.is_b2b
   AND NULLIF(TRIM(ci.b2b_gst_number), '') IS NOT NULL
   AND s.code = LEFT(TRIM(ci.b2b_gst_number), 2);

-- ── Rule 3: everyone else — the workshop's own state ────────────────────────
UPDATE customer_invoices ci
   SET place_of_supply_code = s.code,
       place_of_supply_name = s.name,
       updated_at           = NOW()
  FROM _supplier sup
  JOIN _gst_states s ON s.code = sup.code
 WHERE NULLIF(TRIM(ci.place_of_supply_code), '') IS NULL;

-- ── Report what happened, and refuse to hide a failure ──────────────────────
DO $$
DECLARE
  n_total   INTEGER;
  n_blank   INTEGER;
  n_sup     INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_sup   FROM _supplier;
  SELECT COUNT(*) INTO n_total FROM customer_invoices;
  SELECT COUNT(*) INTO n_blank FROM customer_invoices
   WHERE NULLIF(TRIM(place_of_supply_code), '') IS NULL;

  IF n_sup = 0 THEN
    RAISE WARNING '184: company_settings.gstin is not set to a recognised state code. '
                  'Only B2B invoices could be resolved; % of % invoice(s) are still blank. '
                  'Set the company GSTIN and re-run this migration.', n_blank, n_total;
  ELSIF n_blank > 0 THEN
    RAISE WARNING '184: % of % invoice(s) still have no place of supply.', n_blank, n_total;
  ELSE
    RAISE NOTICE '184: place of supply stored on all % customer invoice(s)', n_total;
  END IF;
END $$;

COMMIT;
