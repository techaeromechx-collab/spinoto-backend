ALTER TABLE services
  ADD COLUMN IF NOT EXISTS customer_rate NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gst_percent   NUMERIC(5,2)  DEFAULT NULL;

COMMENT ON COLUMN services.customer_rate IS 'Customer price ex-GST. Used in estimates and invoices.';
COMMENT ON COLUMN services.gst_percent   IS 'GST percentage applicable to this service (e.g. 18.00 for 18%). Fixed per service.';
