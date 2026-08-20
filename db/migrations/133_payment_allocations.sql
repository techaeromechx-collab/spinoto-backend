-- Migration 133: payment allocations — separating "money received" from
-- "money applied to an invoice".
--
-- THE PROBLEM THIS SOLVES
-- ───────────────────────
-- customer_invoice_payments.amount currently means two things at once:
--
--   1. how much money the customer handed over, and
--   2. how much of it is applied to this invoice
--
-- They have been the same number since the table was created, because a
-- payment could only ever belong to one invoice — customer_invoice_id is NOT
-- NULL, so no invoice meant no payment row.
--
-- Advance payments break that. A customer pays ₹2,000 towards a ₹5,000 job
-- before the invoice exists. The money is real and has to be recorded now; the
-- invoice it will eventually settle does not exist yet. And once it does, the
-- same ₹2,000 might be split across two invoices if the customer has two cars
-- in the workshop.
--
-- So the two meanings separate:
--
--   customer_invoice_payments  =  money we received        (from whom, when, how)
--   payment_allocations        =  where that money is used (which invoice, how much)
--
-- An invoice's amount_paid becomes SUM(allocations) rather than SUM(payments).
-- Credit — money we are holding that is not against any invoice — becomes
-- payment.amount − SUM(that payment's allocations), which needs no third table.
--
-- WHY THIS MIGRATION CHANGES NOTHING TODAY
-- ────────────────────────────────────────
-- Every payment that exists right now belongs to exactly one invoice. So the
-- backfill below writes one allocation per payment, for its full amount, and
-- SUM(allocations) returns exactly the number SUM(payments) returned before —
-- for every invoice, to the paisa.
--
-- That is deliberate and it is the whole point of shipping this alone. A
-- structural change to how every invoice's paid amount is calculated is the
-- single most dangerous kind of change in this system: it drives invoice
-- status, the hub payout date, appointment closing and warranty start dates.
-- Making it a no-op first means the risky part can be verified by comparison
-- rather than by reasoning.
--
-- WHY ON DELETE CASCADE ON THE PAYMENT
-- ────────────────────────────────────
-- Deleting a manual payment must take its allocations with it. Otherwise the
-- invoice keeps counting money that no longer exists — an invoice reading PAID
-- with nothing behind it, which is the exact failure migration 122 and the
-- Phase A transaction fix both exist to prevent.
--
-- CASCADE on the invoice too: deleting an invoice already cascades its
-- payments (migration 065), so an allocation pointing at a deleted invoice
-- could never be reached anyway.

CREATE TABLE IF NOT EXISTS payment_allocations (
  id                  SERIAL PRIMARY KEY,

  ledger_payment_id   INTEGER NOT NULL
                        REFERENCES customer_invoice_payments(id) ON DELETE CASCADE,
  customer_invoice_id INTEGER NOT NULL
                        REFERENCES customer_invoices(id) ON DELETE CASCADE,

  -- How much of that payment is applied HERE. Always positive, and never more
  -- than the payment's own amount — the service enforces the ceiling, because
  -- a CHECK cannot see another table.
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),

  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read path that replaces "payments for this invoice".
CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations (customer_invoice_id);
-- The read path for "how much of this payment is still unallocated" — the
-- query that defines a customer's credit.
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations (ledger_payment_id);

-- ── Backfill ───────────────────────────────────────────────────────────────
-- One allocation per existing payment, for its full amount, carrying the
-- payment's own created_by and created_at so the allocation does not claim to
-- have been made by whoever ran the migration, today.
--
-- NOT EXISTS rather than a plain INSERT: this migration must be safe to re-run
-- (migrate.js tracks applied files, but a restored database or a manual
-- re-apply should not double every invoice's paid amount).
INSERT INTO payment_allocations (ledger_payment_id, customer_invoice_id, amount, created_by, created_at)
SELECT cip.id, cip.customer_invoice_id, cip.amount, cip.created_by, cip.created_at
  FROM customer_invoice_payments cip
 WHERE cip.customer_invoice_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM payment_allocations a WHERE a.ledger_payment_id = cip.id
   );

COMMENT ON TABLE payment_allocations IS
  'Where a received payment is applied. An invoice''s amount_paid is SUM of its allocations minus processed refunds — NOT SUM of payments, because one payment can predate its invoice (an advance) or be split across two. A payment with no allocation is credit the customer has not yet used.';
COMMENT ON COLUMN payment_allocations.amount IS
  'The portion of the payment applied to this invoice, in rupees. Always positive. SUM over one payment must never exceed that payment''s amount; enforced in services/allocations.service.js because a CHECK constraint cannot read another table.';
