-- 088: Odometer capture
-- Baseline km at service time — needed by warranty claims to validate the
-- "within X KM" condition. Optional everywhere; NULL = not captured.

ALTER TABLE appointments      ADD COLUMN IF NOT EXISTS odometer_km INTEGER;
ALTER TABLE estimates         ADD COLUMN IF NOT EXISTS odometer_km INTEGER;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS odometer_km INTEGER;
