-- ── Migration 024: Hub GST, Tech Rates & Document Uploads ───────────────────

-- Add new columns to the hubs table
ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS has_gst            BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gst_number         VARCHAR(15),
  ADD COLUMN IF NOT EXISTS tech_rate_service  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS tech_rate_parts    NUMERIC(5,2);

-- Create hub_documents table for file upload references (one doc per type per hub)
CREATE TABLE IF NOT EXISTS hub_documents (
  id           SERIAL       PRIMARY KEY,
  hub_id       INTEGER      NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  doc_type     VARCHAR(30)  NOT NULL,
  file_name    TEXT         NOT NULL,
  file_url     TEXT         NOT NULL,
  uploaded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by  INTEGER      REFERENCES users(id),

  CONSTRAINT hub_documents_doc_type_check
    CHECK (doc_type IN ('aadhaar','pan','driving_license','agreement','gst_certificate')),

  -- Only one document of each type per hub
  CONSTRAINT hub_documents_hub_doc_unique
    UNIQUE (hub_id, doc_type)
);

CREATE INDEX IF NOT EXISTS idx_hub_documents_hub_id ON hub_documents(hub_id);
