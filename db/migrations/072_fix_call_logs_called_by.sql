-- Migration 072: Fix call_logs.called_by nullable
-- NOT NULL + ON DELETE SET NULL is contradictory — drop the NOT NULL constraint
-- so that deleting a user sets called_by to NULL instead of crashing.

ALTER TABLE call_logs ALTER COLUMN called_by DROP NOT NULL;
