-- ── Add hsn_sac column to estimate_items and customer_invoice_items ───────────
-- Services already have sac_code, Parts already have hsn_code.
-- We store a single hsn_sac field on the item level for invoicing.

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS hsn_sac VARCHAR(20) DEFAULT NULL;

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS hsn_sac VARCHAR(20) DEFAULT NULL;

-- Backfill estimate_items from linked services / parts
UPDATE estimate_items ei
SET hsn_sac = COALESCE(
  (SELECT sac_code FROM services s WHERE s.id = ei.service_id),
  (SELECT hsn_code FROM parts   p WHERE p.id = ei.part_id)
)
WHERE hsn_sac IS NULL;

-- Backfill customer_invoice_items via their estimate_item link
UPDATE customer_invoice_items ci
SET hsn_sac = COALESCE(
  (SELECT sac_code FROM services s
   WHERE s.id = (SELECT service_id FROM estimate_items ei WHERE ei.id = ci.estimate_item_id)),
  (SELECT hsn_code FROM parts p
   WHERE p.id = (SELECT part_id   FROM estimate_items ei WHERE ei.id = ci.estimate_item_id))
)
WHERE hsn_sac IS NULL AND estimate_item_id IS NOT NULL;
