-- ─────────────────────────────────────────────────────────────────────────────
-- 106 — index for the dashboard's Hub Performance card
--
-- The card moved from counting appointments to aggregating customer invoices
-- per hub (reports.controller.js, getDashboard). That query filters on
-- ci.hub_id and ci.invoice_date and runs on every dashboard load.
--
-- purchase_invoices already has idx_pi_hub (migration 065); customer_invoices
-- never got the equivalent, so without this the card is a sequential scan of
-- the whole invoice table each time the dashboard opens.
--
-- Composite rather than two single-column indexes: the query always supplies
-- both predicates together, and hub_id leads because it is the equality test —
-- Postgres can only range-scan on invoice_date once hub_id is pinned.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ci_hub_invoice_date
  ON customer_invoices (hub_id, invoice_date);

ANALYZE customer_invoices;
