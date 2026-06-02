-- Migration 056: Add hsn_sac column to estimate_items and customer_invoice_items
--
-- estimate_items is created in 052 (fresh DBs); customer_invoice_items in 065.
-- Guard customer_invoice_items operations so fresh DBs don't fail.

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS hsn_sac VARCHAR(20) DEFAULT NULL;

-- Back-fill estimate_items (table always exists at this point — created in 052)
UPDATE estimate_items ei
SET hsn_sac = COALESCE(
  (SELECT sac_code FROM services s WHERE s.id = ei.service_id),
  (SELECT hsn_code FROM parts   p WHERE p.id = ei.part_id)
)
WHERE hsn_sac IS NULL;

-- customer_invoice_items: guard — created in migration 065
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_invoice_items') THEN
    ALTER TABLE customer_invoice_items
      ADD COLUMN IF NOT EXISTS hsn_sac VARCHAR(20) DEFAULT NULL;

    UPDATE customer_invoice_items ci
    SET hsn_sac = COALESCE(
      (SELECT sac_code FROM services s
       WHERE s.id = (SELECT service_id FROM estimate_items ei WHERE ei.id = ci.estimate_item_id)),
      (SELECT hsn_code FROM parts p
       WHERE p.id = (SELECT part_id FROM estimate_items ei WHERE ei.id = ci.estimate_item_id))
    )
    WHERE hsn_sac IS NULL AND estimate_item_id IS NOT NULL;
  END IF;
END $$;
