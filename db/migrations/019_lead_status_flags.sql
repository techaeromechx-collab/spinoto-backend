-- ── Migration 019: Lead Status Behaviour Flags + Appointment & Invoice Status Tables ──

-- 1. Add behaviour flags to lead_statuses
--    needs_follow_up        → opening this status on a lead triggers a follow-up scheduling form
--    converts_to_appointment → opening this status on a lead converts it into an Appointment
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS needs_follow_up         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS converts_to_appointment BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Remove old auto-follow-up timing columns (replaced by the flag above)
ALTER TABLE lead_statuses
  DROP COLUMN IF EXISTS follow_up_days,
  DROP COLUMN IF EXISTS follow_up_hours;

-- 3. Seed some sensible flag defaults on existing statuses
UPDATE lead_statuses SET needs_follow_up = TRUE
  WHERE name IN (
    'Call No Ans. (Day 1)', 'Call No Ans. (Day 2)', 'Call No Ans. (Day 3)',
    'Follow-Up', 'Retargeting', 'Future Lead',
    'No Show (Day 1)', 'No Show (Day 2)', 'No Show (Day 3)'
  );

UPDATE lead_statuses SET converts_to_appointment = TRUE
  WHERE name IN ('Appointment Scheduled');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Appointment Statuses table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointment_statuses (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  color      VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
  bg_color   VARCHAR(7)   NOT NULL DEFAULT '#f3f4f6',
  sort_order INTEGER      NOT NULL DEFAULT 0,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  is_default BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO appointment_statuses (name, color, bg_color, sort_order, is_default) VALUES
  ('Scheduled',   '#0891b2', '#cffafe', 1, TRUE),
  ('Confirmed',   '#16a34a', '#dcfce7', 2, FALSE),
  ('In Progress', '#d97706', '#fef3c7', 3, FALSE),
  ('Completed',   '#0f766e', '#ccfbf1', 4, FALSE),
  ('Cancelled',   '#dc2626', '#fee2e2', 5, FALSE),
  ('No Show',     '#ea580c', '#ffedd5', 6, FALSE),
  ('Rescheduled', '#7c3aed', '#ede9fe', 7, FALSE)
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Invoice Statuses table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_statuses (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  color      VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
  bg_color   VARCHAR(7)   NOT NULL DEFAULT '#f3f4f6',
  sort_order INTEGER      NOT NULL DEFAULT 0,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  is_default BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO invoice_statuses (name, color, bg_color, sort_order, is_default) VALUES
  ('Draft',     '#6b7280', '#f3f4f6', 1, TRUE),
  ('Sent',      '#2563eb', '#dbeafe', 2, FALSE),
  ('Paid',      '#16a34a', '#dcfce7', 3, FALSE),
  ('Overdue',   '#dc2626', '#fee2e2', 4, FALSE),
  ('Partial',   '#d97706', '#fef3c7', 5, FALSE),
  ('Cancelled', '#991b1b', '#fef2f2', 6, FALSE),
  ('Refunded',  '#7c3aed', '#ede9fe', 7, FALSE)
ON CONFLICT (name) DO NOTHING;
