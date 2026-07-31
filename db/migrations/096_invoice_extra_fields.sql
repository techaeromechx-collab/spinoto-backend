-- 096_invoice_extra_fields.sql
--
-- Backing storage for the optional invoice fields and item-table columns
-- that migration 095's invoice_config can switch on. Without these the
-- toggles would only ever render permanently-empty cells — the config says
-- "show a PO number", this is where the PO number actually lives.
--
-- All columns are nullable / defaulted, so this is purely additive: existing
-- rows are untouched and no backfill is required.

-- ── Invoice header fields ────────────────────────────────────────────────────
-- vehicle_number already exists on customer_invoices (and is COALESCE'd from
-- the linked appointment in CI_SELECT), so it needs no column here — only a
-- config flag to show/hide it.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS po_number        VARCHAR(60);
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS eway_bill_number VARCHAR(60);

-- Values for the user-defined header fields, keyed by the definition id in
-- company_settings.invoice_config.custom_fields, e.g. { "cf_a1b2": "JC-1042" }.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Line-item fields ─────────────────────────────────────────────────────────
-- customer_invoice_items.description is the item NAME (it's what every theme
-- prints as the line title). item_description is a separate, optional detail
-- line rendered underneath it — this is what the "Show item description in
-- invoice" toggle controls. Kept as a distinct column rather than overloading
-- `description` so turning the toggle off never hides the item's own name.
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS item_description TEXT;

ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS batch_no VARCHAR(60);
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS exp_date DATE;
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS mfg_date DATE;

-- Complimentary / no-charge lines. When the free_item_qty flag is on these
-- render with their quantity but "FREE" in place of rate and amount.
-- Display-only: the stored totals are computed by the controller at generation
-- time and remain the single source of truth, so this never re-does GST math
-- (a genuinely free line is already 0 in those totals).
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT false;

-- Values for the user-defined item columns, keyed by the definition id in
-- company_settings.invoice_config.custom_columns, e.g. { "cc_x9y8": "6 months" }.
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;
