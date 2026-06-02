-- Add SAC code to services (Service Accounting Code — GST for services)
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS sac_code VARCHAR(20) DEFAULT NULL;

-- Add HSN code to parts (Harmonized System of Nomenclature — GST for goods)
ALTER TABLE parts
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20) DEFAULT NULL;
