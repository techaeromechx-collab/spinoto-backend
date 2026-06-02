-- ── Migration 013: Dynamic Lead Statuses ────────────────────────────────────
-- Replaces the hardcoded lead_status ENUM with a configurable lead_statuses
-- table. leads.status changes from ENUM to VARCHAR(100).

-- 1. Create the master statuses table
CREATE TABLE lead_statuses (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  color      VARCHAR(7)   NOT NULL DEFAULT '#6b7280',
  bg_color   VARCHAR(7)   NOT NULL DEFAULT '#f3f4f6',
  sort_order INTEGER      NOT NULL DEFAULT 0,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. Seed the 19 statuses
INSERT INTO lead_statuses (name, color, bg_color, sort_order) VALUES
  ('Call No Ans. (Day 1)',    '#d97706', '#fef3c7',  1),
  ('Call No Ans. (Day 2)',    '#d97706', '#fef9c3',  2),
  ('Call No Ans. (Day 3)',    '#b45309', '#fef3c7',  3),
  ('Retargeting',             '#7c3aed', '#ede9fe',  4),
  ('Follow-Up',               '#2563eb', '#dbeafe',  5),
  ('Appointment Scheduled',   '#0891b2', '#cffafe',  6),
  ('Appointment Cancelled',   '#dc2626', '#fee2e2',  7),
  ('Appointment No Show',     '#ea580c', '#ffedd5',  8),
  ('Appointment Completed',   '#16a34a', '#dcfce7',  9),
  ('Awaiting For Quotation',  '#0369a1', '#e0f2fe', 10),
  ('Lost',                    '#991b1b', '#fef2f2', 11),
  ('Quotation Shared',        '#0f766e', '#ccfbf1', 12),
  ('Junk',                    '#6b7280', '#f3f4f6', 13),
  ('Future Lead',             '#4f46e5', '#e0e7ff', 14),
  ('No Show (Day 1)',         '#ea580c', '#ffedd5', 15),
  ('No Show (Day 2)',         '#ea580c', '#fff7ed', 16),
  ('No Show (Day 3)',         '#c2410c', '#ffedd5', 17),
  ('Out of Service Area',     '#6b7280', '#f9fafb', 18),
  ('Not Interested',          '#dc2626', '#fee2e2', 19);

-- 3. Change leads.status from ENUM to VARCHAR, mapping old values to new names
ALTER TABLE leads ALTER COLUMN status TYPE VARCHAR(100);

UPDATE leads SET status = 'Follow-Up'             WHERE status IN ('new', 'in_progress', 'interested');
UPDATE leads SET status = 'Appointment Completed'  WHERE status = 'converted';
UPDATE leads SET status = 'Not Interested'         WHERE status = 'not_interested';

-- 4. Drop the old enum type (CASCADE handles any remaining references)
DROP TYPE IF EXISTS lead_status CASCADE;
