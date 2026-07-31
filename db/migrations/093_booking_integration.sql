-- 093: Booking-panel integration (booking.spinoto.com → CRM appointments)
-- external_ref: the source system's order id ("booking:CH-1042") — the
-- idempotency key for the sync webhook. booking_source marks appointments
-- that arrived from outside the CRM (badge + reports filter).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS external_ref   TEXT,
  ADD COLUMN IF NOT EXISTS booking_source TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_external_ref
  ON appointments (external_ref) WHERE external_ref IS NOT NULL;
