-- ── Migration: Appointment Status Workflow ────────────────────────────────────
-- 1. Add slug + is_system to appointment_statuses
-- 2. Seed 11 system statuses for the full workflow
-- 3. Add 'approved' to customer_invoices allowed statuses (app-level, no enum)
-- 4. Add index on slug for fast auto-advance lookups
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add new columns (safe to re-run)
ALTER TABLE appointment_statuses
  ADD COLUMN IF NOT EXISTS slug      VARCHAR(60) UNIQUE,
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Mark existing "Scheduled" as the first system status
UPDATE appointment_statuses
  SET slug = 'scheduled', is_system = TRUE
  WHERE LOWER(name) = 'scheduled';

-- 3. Insert/upsert remaining 10 system statuses
--    ON CONFLICT (name) ensures safe re-runs
INSERT INTO appointment_statuses (name, slug, color, bg_color, sort_order, is_system, is_active, is_default)
VALUES
  ('Vehicle Picked',     'vehicle-picked',     '#0891b2', '#e0f2fe', 12, TRUE, TRUE, FALSE),
  ('At Workshop',        'at-workshop',         '#7c3aed', '#ede9fe', 13, TRUE, TRUE, FALSE),
  ('Estimate Submitted', 'estimate-submitted',  '#f59e0b', '#fef3c7', 14, TRUE, TRUE, FALSE),
  ('Estimate Approved',  'estimate-approved',   '#16a34a', '#dcfce7', 15, TRUE, TRUE, FALSE),
  ('Work In Progress',   'work-in-progress',    '#d97706', '#fff7ed', 16, TRUE, TRUE, FALSE),
  ('Work Completed',     'work-completed',      '#0f766e', '#ccfbf1', 17, TRUE, TRUE, FALSE),
  ('Invoice Generated',  'invoice-generated',   '#6366f1', '#eef2ff', 18, TRUE, TRUE, FALSE),
  ('Invoice Approved',   'invoice-approved',    '#8b5cf6', '#f5f3ff', 19, TRUE, TRUE, FALSE),
  ('Invoice Paid',       'invoice-paid',        '#16a34a', '#dcfce7', 20, TRUE, TRUE, FALSE),
  ('Closed',             'closed',              '#374151', '#f3f4f6', 21, TRUE, TRUE, FALSE)
ON CONFLICT (name) DO UPDATE
  SET slug      = EXCLUDED.slug,
      is_system = TRUE,
      color     = EXCLUDED.color,
      bg_color  = EXCLUDED.bg_color;

-- 4. Fast lookup index
CREATE INDEX IF NOT EXISTS idx_appt_statuses_slug ON appointment_statuses (slug);

-- 5. Add 'approved' to customer_invoices status CHECK constraint
--    Drop the old constraint and recreate it with the new allowed value
ALTER TABLE customer_invoices
  DROP CONSTRAINT IF EXISTS customer_invoices_status_check;

ALTER TABLE customer_invoices
  ADD CONSTRAINT customer_invoices_status_check
  CHECK (status IN ('generated', 'approved', 'partially_paid', 'paid', 'cancelled'));
