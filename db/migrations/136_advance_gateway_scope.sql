-- Migration 136: let the gateway tables carry an estimate.
--
-- A payment link and a gateway transaction have both been able to point at
-- exactly one thing — a customer invoice. An advance is taken against an
-- ESTIMATE, which is the earliest point where the amount is known.
--
-- WHY THE ESTIMATE AND NOT THE APPOINTMENT
-- ────────────────────────────────────────
-- An appointment exists before any price does. An advance is a slice of a
-- known total — ₹2,000 of a ₹5,000 job — and without that total there is no
-- way to say how much GST is inside it, which a taxable receipt has to state.
-- The estimate is the first record that has the figure.
--
-- It is also unambiguous in a way nothing else is: migration 075 enforces one
-- customer invoice per estimate. So an advance taken against an estimate has
-- exactly one possible destination, for ever. That is what makes automatic
-- application safe rather than a guess.
--
-- WHY payment_refunds.payment_transaction_id BECOMES NULLABLE
-- ──────────────────────────────────────────────────────────
-- Refunds were built for gateway money, so every refund had a transaction
-- behind it. An advance can be taken in CASH — the customer hands over ₹2,000
-- at the counter — and refunding that has no gateway involvement at all.
-- Leaving the column NOT NULL would mean the system could accept cash it had
-- no way to give back, which is not a state worth shipping.
--
-- The column stays for gateway refunds, where it is still how the refund is
-- matched to its capture.

ALTER TABLE payment_links DROP CONSTRAINT IF EXISTS payment_links_entity_type_check;
ALTER TABLE payment_links
  ADD CONSTRAINT payment_links_entity_type_check
  CHECK (entity_type IN ('customer_invoice','estimate'));

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_entity_type_check;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_entity_type_check
  CHECK (entity_type IN ('customer_invoice','booking','estimate'));

ALTER TABLE payment_refunds ALTER COLUMN payment_transaction_id DROP NOT NULL;

-- A refund must still be traceable to the money it reverses — either the
-- gateway transaction, or the ledger row for a cash advance.
ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS refund_has_source;
ALTER TABLE payment_refunds
  ADD CONSTRAINT refund_has_source
  CHECK (payment_transaction_id IS NOT NULL OR ledger_payment_id IS NOT NULL);

COMMENT ON COLUMN payment_transactions.entity_type IS
  'customer_invoice = paying an invoice. estimate = an advance against a quoted job, before any invoice exists. booking = the public booking flow. entity_id is the id in that table.';
COMMENT ON COLUMN payment_refunds.payment_transaction_id IS
  'The gateway capture being reversed, or NULL when reversing a CASH advance — which has no gateway transaction. ledger_payment_id carries the link in that case; the refund_has_source CHECK requires one of the two.';
