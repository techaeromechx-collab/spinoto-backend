-- 091: Warranty/guarantee exclusion rules
-- A service/part-level entry flagged is_exclusion=TRUE means "NO warranty
-- (or guarantee) for this item", overriding a broader category-level rule —
-- the lookup ladder already lets service beat category, this lets it beat it
-- with "nothing". Exclusions occupy the same uniqueness slot as normal rules.

ALTER TABLE warranty_master
  ADD COLUMN IF NOT EXISTS is_exclusion BOOLEAN NOT NULL DEFAULT FALSE;

-- The substance check ("must have a duration or custom text") doesn't apply
-- to exclusion rows — they intentionally promise nothing.
ALTER TABLE warranty_master DROP CONSTRAINT IF EXISTS warranty_master_check;
ALTER TABLE warranty_master DROP CONSTRAINT IF EXISTS warranty_master_substance_check;
ALTER TABLE warranty_master ADD CONSTRAINT warranty_master_substance_check
  CHECK (is_exclusion
         OR duration_months IS NOT NULL OR duration_days IS NOT NULL
         OR duration_km IS NOT NULL OR custom_text IS NOT NULL);
