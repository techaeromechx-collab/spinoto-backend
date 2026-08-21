-- 166_wa_message_media.sql
--
-- Lets a WhatsApp message carry a photo.
--
-- ── WHY wa_messages COULD NOT HOLD ONE ──────────────────────────────────────
--
-- The table has 27 columns and every one of them is text, status or audit.
-- `body_rendered` is the only place a message's content lives, and it is a
-- TEXT column holding the rendered template string. There has never been
-- anywhere to put a URL, a mime type, or the caption that travels WITH an
-- image rather than as a second message.
--
-- The gap shows on the RECEIVING side today: Interakt's inbound webhook sends
-- `media_url` — their docs call it "public link to media file" — and
-- waInboundLead.service.js throws it away, storing the literal string
-- '📷 Photo' in body_rendered so the conversation at least shows that
-- something arrived. These columns are what let that stop being a lie.
--
-- ── WHY message_type AND NOT A BOOLEAN ──────────────────────────────────────
--
-- `has_media` would be the smaller change and the wrong one. WhatsApp carries
-- images, documents, audio, video, location and contacts; the inbound side
-- already recognises all seven (MEDIA_LABEL in waInboundLead.service.js). A
-- boolean answers "is there a file" and not "what should the thread draw",
-- which is the question the frontend actually asks. A VARCHAR answers both and
-- costs nothing extra.
--
-- Outbound starts at image-only. The column does not need to change when that
-- widens — only the CHECK does, which is one line in a later migration.
--
-- ── WHY caption IS SEPARATE FROM body_rendered ──────────────────────────────
--
-- body_rendered means "the text this message rendered to", and for a template
-- it is reconstructed from `variables` and the template body. A caption is not
-- that: it is free text a person typed, attached to a file. Overloading one
-- column with both would make "show me every message whose text a human wrote"
-- unanswerable, and would put caption text into the template-fingerprint logic
-- that has no business seeing it.
--
-- ── WHY media_file_id EXISTS ────────────────────────────────────────────────
--
-- ImageKit's own id for the uploaded file, the same thing hub_documents and
-- workshop_photos already store alongside their URLs. Without it, deleting a
-- message from this system leaves the image on the CDN forever, and there is
-- no way to find it again — the URL alone cannot be turned back into a handle
-- that ImageKit's delete API accepts.

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS message_type   VARCHAR(12) NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url      TEXT,
  ADD COLUMN IF NOT EXISTS media_mime     VARCHAR(60),
  ADD COLUMN IF NOT EXISTS media_file_id  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS caption        TEXT;

-- The DEFAULT is what makes this safe on a live table: every existing row —
-- and every INSERT in the codebase that does not know about these columns yet
-- — keeps working and reads as 'text', which is what it is.
--
-- Written as its own guarded block rather than inline on ADD COLUMN, because
-- ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL and a re-run would abort
-- the migration. Migration 144 has the same shape for the same reason.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wa_messages_message_type_chk'
  ) THEN
    ALTER TABLE wa_messages
      ADD CONSTRAINT wa_messages_message_type_chk
      CHECK (message_type IN (
        'text', 'image', 'video', 'audio', 'document',
        'sticker', 'location', 'contacts'
      ));
  END IF;
END $$;

-- A media message with no URL is a broken row that renders as an empty bubble.
-- Enforced here rather than in the controller because there are two writers
-- (the reply endpoint and the inbound webhook) and a third will be added the
-- day documents are supported.
--
-- Deliberately NOT the reverse: a row may carry a media_url while
-- message_type = 'text'. That is a link the customer sent inside a text
-- message, and refusing it would break inbound messages that merely mention
-- a URL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wa_messages_media_needs_url_chk'
  ) THEN
    ALTER TABLE wa_messages
      ADD CONSTRAINT wa_messages_media_needs_url_chk
      CHECK (
        message_type = 'text'
        OR message_type IN ('location', 'contacts')   -- carry no file
        OR media_url IS NOT NULL
      );
  END IF;
END $$;

COMMENT ON COLUMN wa_messages.message_type IS
  'What the thread should draw: text (default) or a media kind. Outbound currently only ever writes text or image.';
COMMENT ON COLUMN wa_messages.media_url IS
  'Publicly fetchable URL of the attachment. Outbound: our ImageKit CDN URL, which WhatsApp fetches itself. Inbound: the media_url Interakt sends.';
COMMENT ON COLUMN wa_messages.media_mime IS
  'MIME type as uploaded, e.g. image/jpeg. Used to decide how the thread renders it, never trusted for security — the file filter runs on the extension AND the type.';
COMMENT ON COLUMN wa_messages.media_file_id IS
  'ImageKit file id for OUR uploads, so the file can be deleted later. NULL for inbound media, which lives on the provider''s storage and is not ours to delete.';
COMMENT ON COLUMN wa_messages.caption IS
  'Text a person typed to accompany an attachment. Separate from body_rendered, which is template output.';

-- Finding a conversation's photos without scanning every message on the
-- number. Partial, because the overwhelming majority of rows are 'text' and
-- indexing them would be paying for a filter that matches almost everything.
CREATE INDEX IF NOT EXISTS idx_wa_messages_media
  ON wa_messages (to_number, created_at DESC)
  WHERE message_type <> 'text';
