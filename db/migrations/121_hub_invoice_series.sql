-- Migration 121: a per-hub, per-financial-year invoice number series.
--
-- WHY
-- ───
-- The hub's Sell Invoice number is currently "SI-" + purchase_invoices.id —
-- one global counter shared by every hub. So a single hub's invoices read
-- SI-000101, SI-000105, SI-000123.
--
-- A supplier's invoice series has to be consecutive within a financial year.
-- Gaps are exactly what a GST audit questions, because a missing number looks
-- like a suppressed invoice. The hub cannot explain the gaps — they are other
-- hubs' invoices.
--
-- Same mechanism as hub_appointment_sequences (migration 084): a counter row
-- per (hub, period), incremented with INSERT … ON CONFLICT DO UPDATE …
-- RETURNING, so two concurrent approvals can never claim the same number.
-- Keyed on financial year rather than month because that is the period GST
-- numbering is scoped to.
--
-- ─────────────────────────────────────────────────────────────────────────
-- EXISTING INVOICES KEEP THEIR OLD NUMBER — deliberately.
--
-- Hubs have already filed SI-000123 in their GSTR-1. Renumbering it now would
-- mean the return they filed no longer matches the document they hold: a worse
-- mismatch than the one being fixed. invoice_number stays NULL on every
-- existing row and the renderer falls back to the old derived "SI-{id}" form,
-- so old and new both print correctly with no data migration and no ambiguity
-- about which invoice is which.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hub_invoice_sequences (
  hub_id         INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  -- '25-26' for 1 Apr 2025 – 31 Mar 2026. Text rather than an integer so the
  -- stored key reads the same way it prints in the invoice number.
  financial_year VARCHAR(7) NOT NULL,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hub_id, financial_year)
);

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(40);

-- Two hubs may legitimately produce the same-looking sequence number, so
-- uniqueness is per hub, not global. Partial because every existing row is
-- NULL and NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_invoice_number_per_hub
  ON purchase_invoices (hub_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMENT ON COLUMN purchase_invoices.invoice_number IS
  'Hub''s own invoice number, e.g. QAH/25-26/0007. Assigned once at APPROVAL (a rejected draft must not burn a number) and never rewritten. NULL on pre-migration rows, which keep rendering as SI-{id}.';
