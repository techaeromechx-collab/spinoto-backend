-- Migration 134: the invoice_payment_lines view.
--
-- WHY A VIEW RATHER THAN TEN REWRITTEN QUERIES
-- ────────────────────────────────────────────
-- About ten places in this codebase ask the same question in slightly
-- different words: "the payments for invoice X". Hub payout scheduling, the
-- warranty preflight, two warranty-claim service dates, the payouts list, the
-- public invoice PDF, the appointment and estimate delete guards, the
-- invoice-backdating floor, the invoice list's last-payment column, and the
-- balance calculation itself.
--
-- After migration 133 that question needs a join. Rewriting ten hand-written
-- queries to add the same join is ten chances to get it subtly wrong, and the
-- ones that would be wrong are the quiet ones — a MAX(paid_at) that silently
-- picks the wrong date shifts a hub payout by a week and raises no error.
--
-- This view answers the question once, under the SAME COLUMN NAMES those
-- queries already use. Most call sites change by one word: the table name.
--
-- WHAT `amount` MEANS HERE — READ THIS BEFORE USING IT
-- ────────────────────────────────────────────────────
-- It is the ALLOCATED amount, not the payment total. For every row that exists
-- today those are the same number, and they will stay the same for every
-- ordinary invoice payment. They differ only for a partly-applied advance:
--
--   payment  ₹2,000 taken against an estimate
--   applied  ₹1,500 to CI-000041   ← this view shows 1500
--   credit     ₹500 still unallocated
--
-- Summing this column for an invoice gives what that invoice has been paid.
-- Summing it for a customer would UNDERSTATE what they handed over. For "what
-- did this customer pay", read customer_invoice_payments directly.
--
-- ONE ROW PER ALLOCATION, NOT PER PAYMENT
-- ───────────────────────────────────────
-- A payment split across two invoices appears twice, once under each. That is
-- correct for every consumer here — all of them are asking about one invoice —
-- but it means COUNT(*) counts allocations. The two delete guards use it as
-- "does this invoice have money against it", which is the same answer either
-- way.

CREATE OR REPLACE VIEW invoice_payment_lines AS
SELECT a.id                    AS allocation_id,
       a.customer_invoice_id,
       a.amount,                          -- ALLOCATED, not the payment total
       a.created_at             AS allocated_at,

       cip.id                   AS payment_id,
       cip.amount               AS payment_amount,
       cip.method,
       cip.reference_no,
       cip.paid_at,
       cip.notes,
       cip.created_by,
       cip.source,
       cip.hub_id,
       cip.payment_transaction_id
  FROM payment_allocations a
  JOIN customer_invoice_payments cip ON cip.id = a.ledger_payment_id;

COMMENT ON VIEW invoice_payment_lines IS
  'One row per allocation, joined to the payment behind it, presented under the column names the pre-allocation queries used. `amount` is the ALLOCATED portion — correct for any per-invoice question, and an understatement for any per-customer one. For "what did this customer pay", read customer_invoice_payments.';
