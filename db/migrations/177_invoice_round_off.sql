-- 177_invoice_round_off.sql
--
-- The whole-rupee round-off column, on both invoice types.
--
-- ══ WHAT CHANGES ═══════════════════════════════════════════════════════════
--
-- From the cutoff in src/utils/invoiceRounding.js (midnight IST, 1 Sep 2026), a
-- new customer or purchase invoice stores a whole-rupee grand_total and records
-- the difference here:
--
--     lines add up to   834.55
--     round_off         + 0.45
--     grand_total        835.00     <- what is STORED
--
-- The invoice prints the round_off as its own row, so taxable + tax + round_off
-- still equals grand_total on the face of the document. Without that row the
-- summary block would show three numbers that do not add up — the same defect
-- the transaction discount had before utils/transactionDiscount.js.
--
-- ══ WHY THE ROUNDED FIGURE IS STORED, NOT JUST PRINTED ═════════════════════
--
-- Because payment matching reads this column:
--
--     customer invoice   amtPaid >= grand_total - 0.011   -> 'paid'
--     purchase invoice   same shape, same 0.011 tolerance
--
-- That tolerance is one paisa. It exists for a rounded-to-paise total settled
-- by a payment entered in rupees, and it does NOT cover a 45-paisa gap. If the
-- database held 834.55 while the document said 835.00, a customer paying what
-- the invoice asked for would leave the invoice at 'partially_paid' by 45
-- paise, permanently, with no way to close it — the same dead end migrations
-- 174 and 176 were written to clear on the hub side.
--
-- So the rounded figure becomes the total. Nothing downstream needs to know
-- that rounding happened; grand_total is simply 835.00 from then on.
--
-- ══ DEFAULT 0, NOT NULL ════════════════════════════════════════════════════
--
-- Every existing row gets 0, which is true of them: they were never rounded and
-- their grand_total is exact to the paisa. NULL would mean "unknown", and this
-- is not unknown — it is zero. It also keeps every SUM() and every template
-- free of a null check.
--
-- Documents created BEFORE the cutoff keep 0 for ever, even when edited later:
-- applyGrandTotalRounding is keyed on created_at, so an old invoice re-saved
-- next year still computes its total the old way and still writes 0 here. An
-- invoice already in a filed GST return must not change.
--
-- NUMERIC(12,2) matches grand_total's own type. Signed, because the round-off
-- goes both ways: 834.44 stores -0.44.

BEGIN;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS round_off NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS round_off NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN customer_invoices.round_off IS
  'Whole-rupee round-off applied to grand_total, signed (+0.45 rounded up, -0.44 rounded down). 0 on every document created before the cutoff in src/utils/invoiceRounding.js. grand_total ALREADY INCLUDES this - do not add it again when totalling.';

COMMENT ON COLUMN purchase_invoices.round_off IS
  'Whole-rupee round-off applied to grand_total, signed (+0.45 rounded up, -0.44 rounded down). 0 on every document created before the cutoff in src/utils/invoiceRounding.js. grand_total ALREADY INCLUDES this - do not add it again when totalling.';

-- ══ THE ONE THING THAT COULD GO WRONG, ASSERTED ════════════════════════════
--
-- No backfill: every existing row is correct at 0 by construction. What is
-- worth checking is the invariant this migration must never break — that
-- grand_total minus round_off still equals the exact figure the lines produce.
--
-- Right now round_off is 0 everywhere, so the assertion is that nothing was
-- somehow written non-zero by an earlier partial deploy of this feature.
DO $$
DECLARE
  n_ci INTEGER;
  n_pi INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_ci FROM customer_invoices  WHERE round_off <> 0;
  SELECT COUNT(*) INTO n_pi FROM purchase_invoices  WHERE round_off <> 0;

  IF n_ci > 0 OR n_pi > 0 THEN
    RAISE WARNING '177: % customer and % purchase invoice(s) already carry a non-zero round_off. '
                  'This column is brand new, so that means an earlier build wrote it - '
                  'check those rows reconcile before trusting them.', n_ci, n_pi;
  ELSE
    RAISE NOTICE '177: round_off added to customer_invoices and purchase_invoices, 0 on all existing rows';
  END IF;
END $$;

COMMIT;
