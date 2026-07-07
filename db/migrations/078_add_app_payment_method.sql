-- Migration: Add 'app_payment' to allowed payment methods CHECK constraints
-- Drops old check constraints and adds new ones including 'app_payment'.

-- 1. customer_invoice_payments check constraint
ALTER TABLE customer_invoice_payments DROP CONSTRAINT IF EXISTS customer_invoice_payments_method_check;
ALTER TABLE customer_invoice_payments ADD CONSTRAINT customer_invoice_payments_method_check
  CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other', 'app_payment'));

-- 2. hub_payments check constraint
ALTER TABLE hub_payments DROP CONSTRAINT IF EXISTS hub_payments_method_check;
ALTER TABLE hub_payments ADD CONSTRAINT hub_payments_method_check
  CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'other', 'app_payment'));
