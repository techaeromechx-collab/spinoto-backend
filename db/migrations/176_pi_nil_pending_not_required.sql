-- 176_pi_nil_pending_not_required.sql
--
-- The nil invoices migration 174 could not see.
--
-- ══ WHAT 174 MISSED ════════════════════════════════════════════════════════
--
-- 174 introduced 'not_required' and backfilled the ₹0 invoices that were
-- mislabelled 'paid'. Its WHERE clause was deliberately narrow:
--
--   AND pi.payment_status = 'paid'      -- only rows the zeroPayable branch wrote
--
-- That was the right scope for the bug 174 was written about: approval marked a
-- nil invoice 'paid', and every downstream guard read that word as "money left
-- the bank" and froze the invoice.
--
-- But it assumed a nil invoice always arrives at nil AT APPROVAL. It does not.
-- An invoice approved at ₹5,000 is written 'pending' — correctly, it owed
-- ₹5,000 that day. If its total is later rewritten to ₹0, nothing revisits
-- payment_status:
--
--   syncPurchaseInvoiceFromEstimate   rewrites grand_total, not payment_status
--   recalculatePurchaseInvoice        rewrites grand_total, not payment_status
--   updatePurchaseInvoice             rewrites grand_total, not payment_status
--
-- So the row ends up ₹0 and 'pending'. 174's backfill required 'paid', so it
-- skipped every one.
--
-- ══ WHAT THAT LOOKS LIKE ON SCREEN ═════════════════════════════════════════
--
-- The payouts queue lists status='approved' AND payment_status NOT IN
-- ('paid','not_required'), so these rows stay in it for ever:
--
--   ₹0.00   Unpaid   OVERDUE   [Pay]
--
-- A Pay button over a zero balance. It cannot be cleared by paying, because
-- there is nothing to pay; recording a ₹0 payment is not possible; and the hub
-- panel counts them in "N Unpaid" against a ₹0.00 due total, which reads as a
-- reconciliation error to anyone looking at it.
--
-- Their payout_due_date compounds it. These rows predate migration 083, so they
-- carry dates from the retired "approval date + payout_cycle_days" model — the
-- current rule produces Tuesdays only, and these are Fridays, Saturdays and
-- Sundays on consecutive days. Every one is in the past, so every one shows
-- OVERDUE and sorts to the top of the queue, above real work.
--
-- ══ THE BACKFILL ═══════════════════════════════════════════════════════════
--
-- 174's conditions, with two changes: it matches the statuses 174 did not, and
-- it requires status='approved'.
--
--   grand_total <= 0.011              the same paisa tolerance recalcHubInvoiceState uses
--   status = 'approved'               a draft's payment_status is not meaningful
--                                     yet — approval sets it, and zeroPayable
--                                     already writes 'not_required' there
--   payment_status IN (…)             the two 174 did not cover
--   amount_paid = 0                   never touch an invoice that received money
--   no hub_payments row               belt and braces: amount_paid is derived,
--                                     and an invoice with a payment row against
--                                     a zeroed total is a data problem this
--                                     migration must not paper over
--
-- 'partially_paid' is included for completeness and should match nothing: it
-- implies a payment row, which the last two conditions exclude. If it ever does
-- match, the NOT EXISTS is what stops it.
--
-- No constraint work here — 174 already widened the CHECK to accept
-- 'not_required'. This migration is data only.

BEGIN;

-- The UPDATE lives INSIDE the DO block on purpose.
--
-- GET DIAGNOSTICS ROW_COUNT reports the last statement executed WITHIN the
-- PL/pgSQL block. Run against an UPDATE sitting outside the block it returns 0
-- — verified, not assumed: the first draft of this migration relabelled 21 rows
-- and then printed "0 nil invoice(s) left the payouts queue". A count that
-- silently reads zero on a successful backfill is worse than no count at all,
-- because it is the line someone will check to decide whether the migration did
-- anything.
DO $$
DECLARE
  n_fixed   INTEGER;
  n_anomaly INTEGER;
BEGIN
  UPDATE purchase_invoices pi
     SET payment_status = 'not_required', updated_at = NOW()
   WHERE pi.grand_total <= 0.011
     AND pi.status = 'approved'
     AND pi.payment_status IN ('pending', 'partially_paid')
     AND COALESCE(pi.amount_paid, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM hub_payments hp WHERE hp.purchase_invoice_id = pi.id);

  GET DIAGNOSTICS n_fixed = ROW_COUNT;

  -- The ones this migration deliberately did not touch: a nil total with money
  -- recorded against it. Same carve-out 174 made, restated because the set it
  -- looks at is different.
  SELECT COUNT(*) INTO n_anomaly
    FROM purchase_invoices pi
   WHERE pi.grand_total <= 0.011
     AND pi.status = 'approved'
     AND (COALESCE(pi.amount_paid, 0) <> 0
          OR EXISTS (SELECT 1 FROM hub_payments hp WHERE hp.purchase_invoice_id = pi.id));

  RAISE NOTICE '176: % nil invoice(s) left the payouts queue', n_fixed;
  IF n_anomaly > 0 THEN
    RAISE WARNING '176: % nil invoice(s) have money recorded against them and were LEFT ALONE. '
                  'A payment against a zero total is a data problem, not a labelling one - '
                  'look at them before deciding what they should say.', n_anomaly;
  END IF;
END $$;

-- ══ THE STALE DUE DATES ════════════════════════════════════════════════════
--
-- Clearing payout_due_date on the rows just relabelled.
--
-- Nothing reads it once payment_status is 'not_required' — the queue has
-- already filtered the row out — so this changes no behaviour today. It is here
-- because the value is WRONG rather than merely unused: a due date from a
-- scheduling model retired three migrations ago, on an invoice that will never
-- be paid. Leaving it means the next person to write a report over
-- payout_due_date silently inherits it.
--
-- syncPayoutDueDate's own rule is that a due date exists only while there is a
-- payout to make. NULL is what that rule says these rows should hold.
UPDATE purchase_invoices
   SET payout_due_date = NULL, updated_at = NOW()
 WHERE payment_status = 'not_required'
   AND payout_due_date IS NOT NULL;

COMMIT;
