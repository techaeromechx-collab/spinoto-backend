-- ── Invoice: GST rate + discount type ────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS gst_rate      NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10)  NOT NULL DEFAULT 'flat';

-- Recalculate existing totals (gst_rate=0 so existing data unaffected)
-- New total formula: total = MAX(0, subtotal - discount_amount) + gst_amount
-- where discount_amount = flat discount or (subtotal * discount_pct / 100)
-- and   gst_amount      = (subtotal - discount_amount) * gst_rate / 100

-- ── Appointments: cancellation reason ─────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- ── Appointment reminders: track which reminders were already sent ─────────────
CREATE TABLE IF NOT EXISTS appointment_reminder_log (
  id             SERIAL PRIMARY KEY,
  appointment_id INT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  hours_before   INT NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (appointment_id, hours_before)
);
