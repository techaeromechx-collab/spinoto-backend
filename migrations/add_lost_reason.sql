-- Add lost_reason column to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(120);
