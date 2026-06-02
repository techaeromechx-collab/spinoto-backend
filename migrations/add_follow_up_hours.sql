-- Migration: add follow_up_hours to lead_statuses
-- Run once: psql spinoto -f backend/migrations/add_follow_up_hours.sql

ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS follow_up_hours INTEGER NOT NULL DEFAULT 0;
