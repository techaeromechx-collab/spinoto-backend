-- Add work_status to estimate_items
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS work_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (work_status IN ('pending', 'in_progress', 'completed'));

-- Extend estimates.status to include work states
-- First drop the existing inline check constraint (auto-named by PostgreSQL)
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check;

ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
  CHECK (status IN (
    'draft',
    'pending_company_review',
    'sent_to_customer',
    'partially_approved',
    'fully_approved',
    'revision_requested',
    'work_in_progress',
    'work_completed'
  ));

COMMENT ON COLUMN estimate_items.work_status IS 'Hub work progress: pending → in_progress → completed. Only meaningful for customer_approved=true items.';
