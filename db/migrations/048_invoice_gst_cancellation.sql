-- Migration 048: Invoice GST + discount type; appointment cancellation reason; reminder log

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS gst_rate      NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10)  NOT NULL DEFAULT 'flat';

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE TABLE IF NOT EXISTS appointment_reminder_log (
  id             SERIAL PRIMARY KEY,
  appointment_id INT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  hours_before   NUMERIC(4,2) NOT NULL,  -- NUMERIC so 0.5 (30-min) works; was INT, fixed here (migration 025 is a no-op)
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (appointment_id, hours_before)
);
