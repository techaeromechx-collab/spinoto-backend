-- Add imagekit_file_id column to hub_documents
-- Stores the ImageKit fileId so files can be deleted from ImageKit when removed.

ALTER TABLE hub_documents
  ADD COLUMN IF NOT EXISTS imagekit_file_id TEXT DEFAULT NULL;
