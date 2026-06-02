-- Migration 061: Add 6 new appointment statuses
-- New workflow order:
--  10  Scheduled
--  11  Rescheduled
--  12  Vehicle Picked
--  13  At Workshop
--  14  Estimate Created        ← NEW
--  15  Estimate Submitted
--  16  Estimate Approved
--  17  Waiting for Parts       ← NEW
--  18  Work In Progress
--  19  Work Completed
--  20  Quality Check           ← NEW
--  21  Invoice Generated
--  22  Invoice Approved
--  23  Invoice Paid
--  24  Ready for Delivery      ← NEW
--  25  Closed
--  90  No Show                 ← NEW (terminal, red)
--  91  Cancelled               ← NEW (terminal, red)

-- Step 1: Re-pin existing system statuses to their new sort_order values
UPDATE appointment_statuses SET sort_order = 10 WHERE slug = 'scheduled';
UPDATE appointment_statuses SET sort_order = 11 WHERE slug = 'rescheduled';
UPDATE appointment_statuses SET sort_order = 12 WHERE slug = 'vehicle-picked';
UPDATE appointment_statuses SET sort_order = 13 WHERE slug = 'at-workshop';
UPDATE appointment_statuses SET sort_order = 15 WHERE slug = 'estimate-submitted';
UPDATE appointment_statuses SET sort_order = 16 WHERE slug = 'estimate-approved';
UPDATE appointment_statuses SET sort_order = 18 WHERE slug = 'work-in-progress';
UPDATE appointment_statuses SET sort_order = 19 WHERE slug = 'work-completed';
UPDATE appointment_statuses SET sort_order = 21 WHERE slug = 'invoice-generated';
UPDATE appointment_statuses SET sort_order = 22 WHERE slug = 'invoice-approved';
UPDATE appointment_statuses SET sort_order = 23 WHERE slug = 'invoice-paid';
UPDATE appointment_statuses SET sort_order = 25 WHERE slug = 'closed';

-- Step 2: Insert the 6 new statuses
INSERT INTO appointment_statuses (name, slug, color, bg_color, sort_order, is_system, is_active, is_default)
VALUES
  ('Estimate Created',   'estimate-created',   '#2563eb', '#eff6ff',  14, TRUE, TRUE, FALSE),
  ('Waiting for Parts',  'waiting-for-parts',  '#d97706', '#fffbeb',  17, TRUE, TRUE, FALSE),
  ('Quality Check',      'quality-check',      '#0891b2', '#e0f2fe',  20, TRUE, TRUE, FALSE),
  ('Ready for Delivery', 'ready-for-delivery', '#16a34a', '#dcfce7',  24, TRUE, TRUE, FALSE),
  ('No Show',            'no-show',            '#dc2626', '#fef2f2',  90, TRUE, TRUE, FALSE),
  ('Cancelled',          'cancelled',          '#b91c1c', '#fef2f2',  91, TRUE, TRUE, FALSE)
ON CONFLICT (name) DO UPDATE
  SET slug       = EXCLUDED.slug,
      color      = EXCLUDED.color,
      bg_color   = EXCLUDED.bg_color,
      sort_order = EXCLUDED.sort_order,
      is_system  = TRUE;

-- Rebuild index just in case
CREATE INDEX IF NOT EXISTS idx_appt_statuses_slug ON appointment_statuses (slug);
