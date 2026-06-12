-- Migration 073: Add discount mode columns to estimates and customer_invoices
-- Supports three discount modes: 'none', 'line_item', 'transaction'
-- Default is 'line_item' to preserve existing behaviour

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS discount_mode              VARCHAR(20)    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS transaction_discount_type  VARCHAR(10)    NULL,
  ADD COLUMN IF NOT EXISTS transaction_discount_value NUMERIC(12,4)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transaction_discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS discount_mode               VARCHAR(20)   NOT NULL DEFAULT 'line_item',
  ADD COLUMN IF NOT EXISTS transaction_discount_type   VARCHAR(10)   NULL,
  ADD COLUMN IF NOT EXISTS transaction_discount_value  NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transaction_discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
