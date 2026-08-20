-- Migration 131: hub_id on the payment ledger.
--
-- WHY THE LEDGER NEEDS ITS OWN COPY
-- ─────────────────────────────────
-- Every other money table in this system already carries one:
--
--   payment_transactions.hub_id   (122) "so the payments list can be hub-scoped
--                                        without joining through customer_invoices
--                                        on every row"
--   payment_refunds.hub_id        (124) "denormalised so refund lists and KPIs
--                                        never need a two-hop join"
--
-- customer_invoice_payments — the one table that records money actually
-- received — was left without it. So a gateway payment could be scoped, summed
-- and grouped by hub directly, and a cash payment could not. That asymmetry is
-- why "what did each hub collect this month" has no single query today.
--
-- It also blocks the unified payments list: that list is a UNION of gateway
-- transactions and ledger rows, and utils/hubScope.js applies its predicate to
-- ONE column on the outer relation. Without hub_id on both sides of the union,
-- hub scoping would silently apply to half the rows — the failure mode being a
-- hub seeing another hub's cash, which is worse than the join it saves.
--
-- WHY DENORMALISED AND NOT A JOIN
-- ───────────────────────────────
-- The obvious objection is that hub_id is derivable: the payment knows its
-- invoice and the invoice knows its hub. True, and it stays true — this column
-- is a copy, and customer_invoices.hub_id remains the source of truth.
--
-- The reason to copy it is that an invoice's hub can be corrected after the
-- fact, and when it is, the money should NOT move with it. A payment was taken
-- at a hub on a date; that is a historical fact and a payout was scheduled from
-- it. Deriving the hub through a join would silently rewrite last quarter's
-- collection figures the moment somebody fixed a mis-assigned invoice. The same
-- reasoning migration 122 applies to payment_transactions.
--
-- NULL IS ALLOWED, AND MEANS SOMETHING
-- ────────────────────────────────────
-- Not every customer invoice has a hub — a standalone estimate raised without
-- one produces an invoice with hub_id NULL, and the payment against it inherits
-- that. NULL is "no hub", not "unknown", and utils/hubScope.js already treats a
-- NULL-hub row as belonging to no hub rather than to every hub.
--
-- ON DELETE SET NULL, never CASCADE: losing a hub must not destroy the record
-- of money that changed hands. Same rule as migration 122.

ALTER TABLE customer_invoice_payments
  ADD COLUMN IF NOT EXISTS hub_id INTEGER;

ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS fk_cip_hub;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT fk_cip_hub
  FOREIGN KEY (hub_id) REFERENCES hubs(id) ON DELETE SET NULL;

-- Backfill from the invoice, which is where the value has always lived.
--
-- Guarded on IS NULL so re-running this migration on a database that already
-- has values cannot overwrite a payment's historical hub with the invoice's
-- current one — which is exactly the rewriting the column exists to prevent.
UPDATE customer_invoice_payments cip
   SET hub_id = ci.hub_id
  FROM customer_invoices ci
 WHERE ci.id = cip.customer_invoice_id
   AND cip.hub_id IS NULL
   AND ci.hub_id IS NOT NULL;

-- The read path this column exists for: "everything hub X collected between
-- these dates", which is a hub filter plus a date range plus a sum.
CREATE INDEX IF NOT EXISTS idx_cip_hub_paid
  ON customer_invoice_payments (hub_id, paid_at DESC);

COMMENT ON COLUMN customer_invoice_payments.hub_id IS
  'The hub this money was taken at, copied from customer_invoices.hub_id when the payment is recorded. A COPY on purpose: re-assigning an invoice to a different hub later must not move historical collections or the payouts already scheduled from them. NULL means no hub (a standalone invoice), not unknown. Mirrors payment_transactions.hub_id and payment_refunds.hub_id.';
