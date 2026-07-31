-- 097_document_config.sql
--
-- Generalises the invoice-only theming introduced in 094/095 into a
-- THREE-DOCUMENT system: estimates, customer invoices and purchase invoices
-- all render through the same themable templates.
--
-- Two changes:
--   1. company_settings.document_config — replaces invoice_config's role,
--      splitting settings into a `global` section (things that must be
--      consistent across every document a customer sees — logo, page size,
--      hub naming) and a `documents` section keyed by document type.
--   2. place_of_supply on customer_invoices and estimates — required for
--      correct IGST vs CGST/SGST. Before this the code ALWAYS printed
--      CGST + SGST with no interstate check, which is wrong for any
--      out-of-state customer.
--
-- ── Why a new column instead of reshaping invoice_config in place ────────────
-- invoice_config is left untouched and still readable. This migration COPIES
-- it into document_config.documents.customer_invoice, so an already-configured
-- invoice keeps every setting; if anything about the new system needs to be
-- rolled back, the original blob is still sitting there unmodified.
-- invoice_config becomes dormant (no longer read once the app is deployed) but
-- is deliberately NOT dropped in this migration.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS document_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Carry the existing invoice settings across, verbatim, into the
-- customer_invoice slot. Only runs when there's something to carry and the new
-- column is still empty, so re-running the migration is a no-op.
UPDATE company_settings
SET document_config = jsonb_build_object(
      'documents', jsonb_build_object('customer_invoice', invoice_config)
    )
WHERE COALESCE(invoice_config, '{}'::jsonb) <> '{}'::jsonb
  AND COALESCE(document_config, '{}'::jsonb) = '{}'::jsonb;

-- ── Place of supply ─────────────────────────────────────────────────────────
-- Two-digit GST state code (e.g. '24' = Gujarat) plus the resolved name held
-- alongside it so a printed historical document keeps the name it was issued
-- with even if the code table is later corrected.
--
-- NULL means "not explicitly set" — the renderer then derives it (B2B GSTIN
-- state code, else the supplier's own state). See utils/gstStates.js's
-- resolvePlaceOfSupply. Existing rows stay NULL and therefore keep rendering
-- exactly as they do today: intra-state CGST + SGST.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS place_of_supply_code VARCHAR(2);
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS place_of_supply_name VARCHAR(60);

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS place_of_supply_code VARCHAR(2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS place_of_supply_name VARCHAR(60);
