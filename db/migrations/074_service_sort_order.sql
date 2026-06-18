-- Migration 074: Add sort_order to service_categories and services
-- Enables manual drag-to-reorder in the admin UI.

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

-- Seed initial order alphabetically so existing order is preserved
UPDATE service_categories sc
SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name ASC) AS rn
  FROM service_categories
) sub
WHERE sc.id = sub.id;

UPDATE services s
SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY name ASC) AS rn
  FROM services
) sub
WHERE s.id = sub.id;

CREATE INDEX IF NOT EXISTS idx_service_categories_sort ON service_categories (sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_services_sort ON services (category_id, sort_order ASC);
