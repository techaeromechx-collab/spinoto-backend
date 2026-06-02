-- Migration 051: Add customer_rate + gst_percent to services

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS customer_rate NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gst_percent   NUMERIC(5,2)  DEFAULT NULL;
