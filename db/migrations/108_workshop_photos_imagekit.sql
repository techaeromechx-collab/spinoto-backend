-- 108_workshop_photos_imagekit.sql
--
-- Two corrections to 107.
--
-- 1. Workshop photos go to ImageKit, like every other upload in the app.
--    107 stored only file_url, and the controller invented a `req.fileUrl`
--    that nothing ever set — so the ImageKit path silently produced a 503 and
--    only the local-disk fallback worked. Storing the remote file id is what
--    lets a deleted photo actually be deleted from the CDN rather than left
--    there forever, which is what hub_documents already does.
--
-- 2. company_name moves from the Workshop to the Convert popup. You rarely
--    know the registered entity while you are still negotiating; you always
--    know it by the time you are signing.

BEGIN;

ALTER TABLE workshop_photos
  ADD COLUMN IF NOT EXISTS imagekit_file_id TEXT;

COMMENT ON COLUMN workshop_photos.imagekit_file_id
  IS 'ImageKit file id, NULL when stored on local disk. Needed to delete the remote copy.';

-- Dropped rather than left in place. A column nothing writes is a trap: the
-- next person to read the table assumes a workshop carries a company name and
-- joins or reports on it, getting NULL for every row.
ALTER TABLE workshops
  DROP COLUMN IF EXISTS company_name;

COMMIT;
