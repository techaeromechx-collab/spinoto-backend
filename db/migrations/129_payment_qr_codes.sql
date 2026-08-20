-- Migration 129: UPI QR payments on payment_transactions.
--
-- WHY THESE COLUMNS AND NOT A NEW TABLE
-- ─────────────────────────────────────
-- A QR payment is the same lifecycle as a checkout payment with a different
-- front door. It opens against an invoice, it may never be paid, and if it is
-- paid it produces exactly one customer_invoice_payments row through
-- captureVerifiedPayment(). Everything migration 122 says about
-- payment_transactions is true of a QR payment word for word.
--
-- Giving it its own table would mean the payments list, the summary KPIs, the
-- CSV export, the refund path, the hub scoping and the settlement
-- reconciliation each needing a second branch — and every one of those is a
-- place where money paid by QR would quietly stop being counted. Three columns
-- here instead.
--
-- WHAT A QR ROW LOOKS LIKE
-- ────────────────────────
--   gateway_order_id    NULL       ← there is no order; this is the difference
--   gateway_qr_id       'qr_xxx'   ← how the webhook finds this row
--   gateway_payment_id  NULL until paid, then set by the capture
--
-- THE UNIQUE INDEX IS THE POINT
-- ─────────────────────────────
-- Same reasoning as migration 122's two indexes, and the same partial form
-- (WHERE NOT NULL) for the same reason: almost every row in this table has no
-- QR id at all, and a plain UNIQUE would allow exactly one of them.
--
-- It matters more here than for orders, because a QR payment has NO browser
-- callback. The webhook is the only path, Razorpay retries webhooks, and the
-- retry is a duplicate delivery of a payment that has already been captured.
-- The index is what makes that arithmetically impossible rather than merely
-- unlikely.
--
-- WHY THERE IS AN EXPIRY COLUMN
-- ─────────────────────────────
-- Razorpay caps close_by at 2 HOURS from creation. That is a provider limit,
-- not a setting, and it is the single most important fact about this feature:
-- a UPI QR cannot be printed on an invoice and left to work, and a QR shown on
-- a screen at 9am is dead by 11am. Storing the expiry means the UI can say so
-- instead of showing a customer a code their bank will reject.
--
-- Nothing sweeps expired rows. A transaction that ages out sits at 'created'
-- forever, exactly like an abandoned checkout does today — the same state, for
-- the same reason, and deliberately not a new one.

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS gateway_qr_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS qr_image_url  TEXT,
  ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paytxn_gateway_qr
  ON payment_transactions (gateway_qr_id)
  WHERE gateway_qr_id IS NOT NULL;

COMMENT ON COLUMN payment_transactions.gateway_qr_id IS
  'The gateway QR id (Razorpay qr_xxx) when this transaction was opened as a UPI QR rather than a checkout order. Mutually exclusive with gateway_order_id in practice. This is the ONLY way the qr_code.credited webhook can find this row: Razorpay''s payment entity carries no reference back to the QR that produced it.';

COMMENT ON COLUMN payment_transactions.qr_image_url IS
  'Gateway-hosted PNG of the QR, or a data URI in mock mode. Stored so re-opening the modal does not create a second QR against the same invoice.';

COMMENT ON COLUMN payment_transactions.qr_expires_at IS
  'When the QR stops accepting payment. Razorpay caps this at 2 hours after creation — a provider limit, which is why UPI QR codes cannot be printed on documents.';
