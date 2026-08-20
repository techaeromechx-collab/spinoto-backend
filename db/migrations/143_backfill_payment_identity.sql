-- Migration 143: repair the payments that are invisible on the customer's own
-- screen.
--
-- ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
-- The customer Payments tab finds money by mobile number:
--
--     WHERE p.mobile = $1        -- payments.controller.listForCustomer
--
-- but neither of the two paths that record a payment AGAINST AN INVOICE ever
-- set that column. customer_invoices.controller.addPayment (cash at the
-- counter) and payments.service.captureVerifiedPayment (online) both inserted
-- without it, so every such row landed with mobile NULL — and NULL matches no
-- number, so the payment simply was not there.
--
-- Nothing was lost and nothing was wrong with the money. The ledger row, its
-- allocation, the invoice's amount_paid and the hub payout all behaved
-- correctly; the row was only unreachable from one screen.
--
-- ── WHY IT LOOKED HALF-WORKING ──────────────────────────────────────────────
-- Migration 135 ran this same backfill once, when the advance feature added the
-- column. Every payment that existed at that moment got its identity filled in
-- and still appears. Every payment taken since then does not. So the tab showed
-- a plausible-looking list with recent payments quietly missing from it, which
-- is a worse failure than showing nothing — nobody has any reason to doubt it.
--
-- The advance paths were never affected: createManualAdvance,
-- createAccountCredit and captureAdvance have always set mobile, which is why
-- every ADV- receipt appears and only the invoice payments went missing.
--
-- Both INSERTs now set it. This migration repairs the rows written in between.
--
-- ── WHY COALESCE, AND WHY THE APPOINTMENT ───────────────────────────────────
-- 135 read ci.mobile alone. customer_invoices keeps its own copies of the
-- customer's number and vehicle, but they can be NULL on rows created through
-- paths that never set them — which is exactly why readInvoiceBalance and
-- CI_SELECT have always COALESCEd them with the appointment's. Reading the
-- invoice alone would leave those rows just as invisible as before, so this
-- falls back the same way the application does.
--
-- ── SAFE TO RE-RUN ──────────────────────────────────────────────────────────
-- Each column keeps whatever it already has, so a value someone corrected by
-- hand is never overwritten.
--
-- The second half of the WHERE clause is what makes a re-run report UPDATE 0
-- rather than UPDATE n. Without it, a row whose invoice and appointment BOTH
-- have nothing to give still matches "mobile IS NULL" for ever, and every run
-- rewrites it from NULL to NULL — a write that changes nothing, on rows that
-- can never be repaired from this source. Asking whether there is actually a
-- value to copy is the difference between idempotent and merely harmless.
--
-- Advances are excluded rather than merely unmatched: their mobile is the
-- customer the money BELONGS to, which for account credit is not derivable from
-- an invoice at all — cip.customer_invoice_id is NULL on those rows, so the
-- join drops them anyway, and the WHERE clause says so out loud.
--
-- estimate_id and appointment_id are deliberately NOT backfilled here. 135 set
-- them, but nothing reads them for an invoice payment — every consumer
-- (autoApplyForInvoice, readEstimateForAdvance, readReceiptVoucher, the
-- account-credit index) filters on payment_type = 'advance' first. Writing
-- them would add meaning no code asks for.

UPDATE customer_invoice_payments cip
   SET mobile         = COALESCE(cip.mobile,         ci.mobile,         a.mobile),
       vehicle_number = COALESCE(cip.vehicle_number, ci.vehicle_number, a.vehicle_number)
  FROM customer_invoices ci
  LEFT JOIN appointments a ON a.id = ci.appointment_id
 WHERE ci.id = cip.customer_invoice_id
   AND cip.payment_type = 'invoice'
   AND ( (cip.mobile         IS NULL AND COALESCE(ci.mobile,         a.mobile)         IS NOT NULL)
      OR (cip.vehicle_number IS NULL AND COALESCE(ci.vehicle_number, a.vehicle_number) IS NOT NULL) );
