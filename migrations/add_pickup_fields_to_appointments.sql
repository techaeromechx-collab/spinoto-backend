ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pickup_required  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pickup_address   TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pickup_timestamp TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN appointments.pickup_required  IS 'Whether the customer requires vehicle pickup and drop service.';
COMMENT ON COLUMN appointments.pickup_address   IS 'Customer address for vehicle pickup. Required when pickup_required = TRUE.';
COMMENT ON COLUMN appointments.pickup_timestamp IS 'Timestamp when the hub marked the vehicle as picked up.';
