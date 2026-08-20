-- Migration 138: the invoice_payment_lines view learns about advances.
--
-- WHY
-- ───
-- Migration 134 created this view before migration 135 existed, so it could not
-- carry payment_type or voucher_no — those columns had not been added yet. That
-- was correct at the time and is now a gap, because the invoice screen lists
-- rows from this view and has no way to tell an ordinary payment apart from an
-- advance that was auto-applied to the invoice.
--
-- It matters for exactly one reason: the invoice screen offers a pencil (change
-- the payment date) and a bin (delete the payment) on every row it lists. Both
-- handlers look the payment up with
--
--     WHERE id = $1 AND customer_invoice_id = $2
--
-- and an advance's customer_invoice_id is NULL — the money was taken against an
-- estimate, before any invoice existed. So both buttons return 404 "Payment not
-- found" on an advance. The money is safe; the screen is not honest. This view
-- gives the screen what it needs to render those rows as what they are.
--
-- WHAT ELSE CHANGED
-- ─────────────────
-- payment_id was always here — the view has never had a plain `id` column,
-- because `id` would have been ambiguous between the allocation and the payment
-- behind it. One read site (_getPayments) asked for cip.id anyway and failed at
-- runtime with "column cip.id does not exist"; that query now asks for
-- payment_id. Nothing in the view changes for it.
--
-- CREATE OR REPLACE VIEW keeps every existing column in its existing position
-- and appends the two new ones, so no other reader is affected.

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
       cip.payment_transaction_id,

       -- New in 138.
       cip.payment_type,                  -- 'invoice' | 'advance'
       cip.voucher_no,                    -- the advance receipt number, if any
       cip.estimate_id
  FROM payment_allocations a
  JOIN customer_invoice_payments cip ON cip.id = a.ledger_payment_id;

COMMENT ON VIEW invoice_payment_lines IS
  'One row per allocation, joined to the payment behind it, presented under the column names the pre-allocation queries used. `amount` is the ALLOCATED portion — correct for any per-invoice question, and an understatement for any per-customer one. For "what did this customer pay", read customer_invoice_payments. There is no `id` column: use payment_id (the ledger row) or allocation_id (this line). payment_type tells an ordinary invoice payment apart from an advance applied to the invoice — an advance cannot be edited or deleted from the invoice screen, because its customer_invoice_id is NULL.';
