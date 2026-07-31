-- 098_signature_image.sql
--
-- Authorised-signatory image for printed documents.
--
-- Follows exactly the same storage pattern as the invoice logo (migration
-- 094): either an ImageKit CDN URL or a local /uploads/... path depending on
-- whether ImageKit env vars are configured, with the file id kept alongside so
-- a re-upload or removal can clean up the old CDN asset.
--
-- Kept on company_settings rather than inside document_config because it is a
-- binary asset with its own upload/delete endpoints, and — like the logo — a
-- routine "save settings" call must never be able to clear it.
--
-- The signature only prints when the relevant document's show_signature toggle
-- is on, so adding the column changes nothing on its own.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS signature_url     VARCHAR(500);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS signature_file_id VARCHAR(100);
