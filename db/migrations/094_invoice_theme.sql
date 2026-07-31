-- 094_invoice_theme.sql
--
-- Adds invoice theming support to company_settings: which template the
-- printed/PDF invoice uses, an accent color, and an uploaded company logo.
--
-- logo_url follows the same pattern as hub_documents.file_url — either an
-- ImageKit CDN URL or a local /uploads/... path, depending on whether
-- ImageKit env vars are configured. logo_file_id mirrors
-- hub_documents.imagekit_file_id (NULL when using local-disk fallback),
-- needed so a re-upload/removal can clean up the old ImageKit asset.
--
-- invoice_theme is a free-text key (not an enum) matching the frontend's
-- theme registry (e.g. 'simple', 'modern', 'luxury', 'stylish',
-- 'advanced_gst', 'advanced_gst_tally', 'billbook', 'advanced_gst_a5',
-- 'billbook_a5') — kept as text rather than a Postgres ENUM so new themes
-- can be added without a migration.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS invoice_theme VARCHAR(40) NOT NULL DEFAULT 'simple';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS invoice_accent_color VARCHAR(9) NOT NULL DEFAULT '#4f46e5';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS logo_file_id VARCHAR(100);
