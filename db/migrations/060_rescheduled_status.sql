-- Migration 060: Add "Rescheduled" system status for appointments
-- Inserted between "Scheduled" (sort_order ~11) and "Vehicle Picked" (sort_order 12).
-- We use sort_order 11 (Scheduled is typically 10 or 11 from seed).

INSERT INTO appointment_statuses (name, slug, color, bg_color, sort_order, is_system, is_active, is_default)
VALUES (
  'Rescheduled', 'rescheduled', '#f97316', '#fff7ed', 11, TRUE, TRUE, FALSE
)
ON CONFLICT (name) DO UPDATE
  SET slug      = 'rescheduled',
      is_system = TRUE,
      color     = '#f97316',
      bg_color  = '#fff7ed';

-- Push existing statuses that start at sort_order 11 up by 1 to make room
UPDATE appointment_statuses
  SET sort_order = sort_order + 1
  WHERE slug IN (
    'vehicle-picked','at-workshop','estimate-submitted','estimate-approved',
    'work-in-progress','work-completed','invoice-generated','invoice-approved',
    'invoice-paid','closed'
  );
