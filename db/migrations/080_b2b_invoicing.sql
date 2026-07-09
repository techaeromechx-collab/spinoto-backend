-- Migration 080: B2B invoicing — GSTIN capture on Estimates + Customer Invoices
--
-- Adds an opt-in B2B toggle to estimates. When on, the hub/admin captures the
-- customer's GST-registered company name, GSTIN, and billing address. These
-- are copied onto the Customer Invoice at generation time, and kept in sync
-- whenever the estimate is edited (see estimates.controller.js updateEstimate),
-- as long as the linked CI hasn't been paid/cancelled yet.
--
-- purchase_invoices is intentionally NOT touched — it's a hub-facing payout
-- document, not a customer-facing invoice.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS is_b2b            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS b2b_company_name  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS b2b_gst_number    VARCHAR(15),
  ADD COLUMN IF NOT EXISTS b2b_address       TEXT;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS is_b2b            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS b2b_company_name  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS b2b_gst_number    VARCHAR(15),
  ADD COLUMN IF NOT EXISTS b2b_address       TEXT;
