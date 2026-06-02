-- Migration 062: Add segment_id to customer_vehicles
-- Stores which fuel/segment variant the customer's vehicle is (e.g. Diesel, Petrol, CNG)

ALTER TABLE customer_vehicles
  ADD COLUMN IF NOT EXISTS segment_id INT REFERENCES segments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_vehicles_segment ON customer_vehicles(segment_id);
