-- Migration 014: Make leads.name nullable
-- Only mobile number is required when creating a lead.
-- The team fills in name and other details after calling the customer.

ALTER TABLE leads ALTER COLUMN name DROP NOT NULL;
