-- Migration: departments master data table
-- Run once against your PostgreSQL database.

CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a few common departments so the dropdown isn't empty
INSERT INTO departments (name) VALUES
  ('Sales'),
  ('Support'),
  ('Operations'),
  ('Marketing'),
  ('Finance'),
  ('HR'),
  ('Technology'),
  ('Management')
ON CONFLICT DO NOTHING;
