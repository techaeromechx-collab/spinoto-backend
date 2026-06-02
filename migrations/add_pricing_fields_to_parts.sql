ALTER TABLE parts
  ADD COLUMN IF NOT EXISTS customer_rate NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gst_percent   NUMERIC(5,2)  DEFAULT NULL;

COMMENT ON COLUMN parts.customer_rate IS 'Customer price ex-GST. Used in estimates and invoices.';
COMMENT ON COLUMN parts.gst_percent   IS 'GST percentage applicable to this part (e.g. 28.00 for 28%). Fixed per part.';
