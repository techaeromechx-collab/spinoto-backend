-- 174_pi_payment_not_required.sql
--
-- "Paid" stops meaning two things.
--
-- ══ THE PROBLEM ════════════════════════════════════════════════════════════
--
-- purchase_invoices.payment_status has been carrying two unrelated facts under
-- one word:
--
--   PAID          ₹5,000 invoice, ₹5,000 actually left the bank.
--   PAID          ₹0 invoice, nothing left the bank and nothing ever will.
--
-- The second is written at approval (approvePurchaseInvoice, `zeroPayable`) so
-- a nil invoice does not sit in the payouts queue for ever. Sensible on its own
-- terms, and it collides with every guard downstream, all of which read the
-- word as the first meaning:
--
--   updatePurchaseInvoice        refuses to edit    "payment has already been recorded"
--   syncPurchaseInvoiceFromEstimate refuses to sync "Purchase Invoice is already paid"
--
-- So a PI that comes to ₹0 — which happens whenever every line is at 100%
-- commission, not only on the hub-borne warranty redo this was written for — is
-- frozen the moment it is approved. It cannot be corrected, because editing is
-- blocked; it cannot be removed, because no delete route exists; and rejecting
-- the approval does not help, because that handler resets status, approved_by,
-- approved_at and the schedule but never resets payment_status.
--
-- ══ THE FIX ════════════════════════════════════════════════════════════════
--
-- A third value: 'not_required'. It means "correct, settled, and no money was
-- involved", which is what a nil invoice actually is.
--
-- The guards then stop asking "does it say paid?" and start asking "did money
-- move?" — which is what they always meant. See purchase_invoices.controller.js.
--
-- ══ THE CHECK CONSTRAINT HAS TO BE WIDENED FIRST ═══════════════════════════
--
-- payment_status IS constrained, and not from db/migrations. It comes from
-- backend/migrations/add_hub_payments.sql — the OLDER, separate migrations
-- folder that predates db/migrations and is easy to miss when grepping:
--
--   CHECK (payment_status IN ('pending','partially_paid','paid'))
--
-- So the backfill below cannot run until the constraint knows the new value.
-- Dropped and re-added rather than edited, because Postgres has no ALTER
-- CONSTRAINT for a CHECK.
--
-- Found by DEFINITION rather than by name, and looped rather than LIMIT 1: two
-- installs built at different times can carry different generated names, and
-- an install that has been patched by hand can carry more than one CHECK
-- touching this column. Naming one and hoping is how this migration fails on
-- the machine it was not written on.

BEGIN;

COMMENT ON COLUMN purchase_invoices.payment_status IS
  'pending | partially_paid | paid | not_required. not_required means the invoice is nil - there is nothing to pay and nothing ever was. Guards that care whether MONEY MOVED must test amount_paid / hub_payments, not this word.';

DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'purchase_invoices'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE purchase_invoices DROP CONSTRAINT %I', cname);
    RAISE NOTICE '174: dropped CHECK %', cname;
  END LOOP;
END $$;

-- Re-added under the name the original would have generated, so an install
-- that has been through this migration looks the same as one that has not.
ALTER TABLE purchase_invoices
  ADD CONSTRAINT purchase_invoices_payment_status_check
  CHECK (payment_status IN ('pending', 'partially_paid', 'paid', 'not_required'));

-- ══ THE BACKFILL ═══════════════════════════════════════════════════════════
--
-- Deliberately narrow. Every one of these four conditions is doing work:
--
--   grand_total <= 0.011   the same paisa tolerance recalcHubInvoiceState uses
--   payment_status='paid'  only rows the zeroPayable branch wrote
--   amount_paid = 0        never touch an invoice that received money
--   no hub_payments row    belt and braces: amount_paid is derived, and an
--                          invoice with a payment row and a zeroed total is a
--                          data problem this migration must not paper over
--
-- An invoice that somehow received money against a nil total keeps saying
-- 'paid' and shows up as the anomaly it is, rather than being quietly relabelled.
UPDATE purchase_invoices pi
   SET payment_status = 'not_required', updated_at = NOW()
 WHERE pi.grand_total <= 0.011
   AND pi.payment_status = 'paid'
   AND COALESCE(pi.amount_paid, 0) = 0
   AND NOT EXISTS (SELECT 1 FROM hub_payments hp WHERE hp.purchase_invoice_id = pi.id);

DO $$
DECLARE
  n_nil     INTEGER;
  n_anomaly INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_nil
    FROM purchase_invoices WHERE payment_status = 'not_required';

  -- The ones the backfill deliberately did not touch.
  SELECT COUNT(*) INTO n_anomaly
    FROM purchase_invoices pi
   WHERE pi.grand_total <= 0.011
     AND (COALESCE(pi.amount_paid, 0) <> 0
          OR EXISTS (SELECT 1 FROM hub_payments hp WHERE hp.purchase_invoice_id = pi.id));

  RAISE NOTICE '174: % nil invoice(s) relabelled "No Payment Due"', n_nil;
  IF n_anomaly > 0 THEN
    RAISE WARNING '174: % nil invoice(s) have money recorded against them and were LEFT ALONE. '
                  'A payment against a zero total is a data problem, not a labelling one - '
                  'look at them before deciding what they should say.', n_anomaly;
  END IF;
END $$;


-- ══ CANCELLING MUST FREE THE ESTIMATE ══════════════════════════════════════
--
-- `status` has always allowed 'cancelled' (migration 065's CHECK) and nothing
-- has ever set it. This change adds a cancel action, which needs one thing from
-- the schema to be worth having.
--
-- purchase_invoices carries UNIQUE(estimate_id) — one PI per estimate, enforced
-- by the database, which is right. But it counts cancelled rows too. So
-- cancelling a wrong invoice would permanently bar that estimate from ever
-- having another one: the cancel button would trade one dead end for a worse
-- one, and the 409 it produced would say "Purchase invoice already exists for
-- this estimate" while the screen showed it cancelled.
--
-- A partial unique index says what was actually meant: at most one LIVE PI per
-- estimate. Cancelled ones step out of the way.
--
-- ── What this loosens, stated plainly ──────────────────────────────────────
--
-- An estimate can now hold several purchase invoices, of which at most one is
-- not cancelled. That is the intended shape. It also means anything joining
-- estimates to purchase invoices without filtering on status can now match more
-- than one row — PI_SELECT joins the other way (from the PI) so it is
-- unaffected, but it is the thing to check first if a total ever doubles.
--
-- Index first, constraint second, one transaction: at no point is the estimate
-- unprotected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_invoices_estimate_live
  ON purchase_invoices (estimate_id)
  WHERE status <> 'cancelled';

COMMENT ON INDEX uq_purchase_invoices_estimate_live IS
  'At most one live purchase invoice per estimate. Replaces UNIQUE(estimate_id), which also counted cancelled rows and so made cancelling permanent for that estimate.';

DO $$
DECLARE
  cname TEXT;
BEGIN
  -- Found by shape rather than by name: 065 declared it inline as
  -- UNIQUE(estimate_id), so the name is whatever Postgres generated, and it is
  -- not necessarily the same on two installs that were built at different times.
  SELECT c.conname INTO cname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'purchase_invoices'
     AND c.contype = 'u'
     -- ::text on both sides. pg_attribute.attname is `name`, and `name[] =
     -- text[]` has no operator — the comparison does not merely return false,
     -- it aborts the migration.
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM unnest(c.conkey) k
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
         = ARRAY['estimate_id']::text[]
   LIMIT 1;

  IF cname IS NULL THEN
    RAISE NOTICE '174: no plain UNIQUE(estimate_id) to drop - already partial, or already done';
  ELSE
    EXECUTE format('ALTER TABLE purchase_invoices DROP CONSTRAINT %I', cname);
    RAISE NOTICE '174: dropped %, replaced by the partial index', cname;
  END IF;
END $$;

COMMIT;
