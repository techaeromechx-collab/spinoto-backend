-- Increase customer_rate precision from 2dp to 4dp
-- so ex-GST back-calculations round correctly to the original inc-GST price
-- e.g. 508.4746 × 1.18 = 599.9999… → ₹600.00 (not 508.47 × 1.18 = 599.99)

ALTER TABLE estimate_items
  ALTER COLUMN customer_rate TYPE NUMERIC(10,4);
