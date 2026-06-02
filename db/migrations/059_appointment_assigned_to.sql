-- Migration 059: Add assigned_to to appointments
-- When a lead is converted to an appointment, the assigned agent carries over.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_assigned_to ON appointments(assigned_to);
