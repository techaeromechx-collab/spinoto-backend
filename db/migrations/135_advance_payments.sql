-- Migration 135: advance payments — money received before the invoice exists.
--
-- THE CHANGE THAT MATTERS
-- ───────────────────────
-- customer_invoice_id becomes NULLABLE.
--
-- It has been NOT NULL since migration 065, and that constraint was correct
-- while a payment could only ever exist against an invoice. It is what made a
-- customer paying ₹2,000 towards a ₹5,000 job before the invoice was raised
-- impossible to record: the money is real, the invoice is not.
--
-- Migration 133 made this safe by moving "which invoice was this applied to"
-- into payment_allocations. So this column no longer carries the invoice
-- relationship at all — allocations do. What it still says is narrower and
-- worth keeping:
--
--   NOT NULL  this payment was taken AGAINST a specific invoice
--   NULL      this payment arrived before any invoice existed (an advance)
--
-- Every read path that used to filter on it moved to invoice_payment_lines in
-- migration 134, so nothing reads it for balance purposes any more.
--
-- WHY AN ADVANCE MUST POINT AT SOMETHING
-- ──────────────────────────────────────
-- An advance with no invoice, no estimate, no appointment and no booking is
-- money in the ledger that nothing in the system can lead you back to. It
-- would show on the customer's page as credit and nowhere else — findable only
-- by knowing the mobile number to search for. The CHECK below refuses it.
--
-- THE VOUCHER COLUMNS SHIP NOW, EVEN THOUGH NOTHING PRINTS YET
-- ────────────────────────────────────────────────────────────
-- An advance is a taxable receipt, so it needs a numbered document. That
-- document is built in a later phase — but the NUMBER has to be issued from
-- the first advance ever taken. Adding the series afterwards would mean
-- inventing numbers for tax receipts after the fact, which is exactly what a
-- consecutive series exists to make impossible.
--
-- Cheap now. Not cheap later.
--
-- GST IS STORED, NOT DERIVED
-- ──────────────────────────
-- The tax inside an advance is the same proportion as the estimate it was
-- taken against — and the estimate's own figures can be edited afterwards.
-- Recomputing the split at print time would let a receipt already given to a
-- customer change its own tax. So it is snapshotted here, at the moment the
-- money is taken, and never recalculated.

ALTER TABLE customer_invoice_payments
  ALTER COLUMN customer_invoice_id DROP NOT NULL,

  ADD COLUMN IF NOT EXISTS payment_type    VARCHAR(20) NOT NULL DEFAULT 'invoice',

  -- Where the advance came from. Nullable individually, but see the CHECK.
  ADD COLUMN IF NOT EXISTS estimate_id     INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booking_id      INTEGER,

  -- Customer identity in this system IS the mobile number (customer_identities
  -- is keyed on it). Denormalised for the same reason payment_transactions
  -- does it: an advance must survive its estimate being deleted, and "what has
  -- this customer paid" must not require a four-table walk.
  ADD COLUMN IF NOT EXISTS mobile          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS vehicle_number  VARCHAR(30),

  -- The voucher identity.
  ADD COLUMN IF NOT EXISTS voucher_no      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS voucher_fy      VARCHAR(9),
  ADD COLUMN IF NOT EXISTS voucher_seq     INTEGER,
  ADD COLUMN IF NOT EXISTS public_token    VARCHAR(20),

  -- The tax inside `amount`, snapshotted. amount is GST-INCLUSIVE: a ₹2,000
  -- advance against a ₹5,000 job is ₹2,000 the customer pays, of which the GST
  -- is a part. Nothing is ever added on top.
  ADD COLUMN IF NOT EXISTS gst_amount      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS gst_rate        NUMERIC(5,2);

ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS cip_payment_type_check;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT cip_payment_type_check CHECK (payment_type IN ('invoice','advance'));

-- An ordinary invoice payment must still name its invoice. Dropping NOT NULL
-- above removed that guarantee for every row; this puts it back for the rows
-- that are not advances.
ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS cip_invoice_payment_has_invoice;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT cip_invoice_payment_has_invoice
  CHECK (payment_type <> 'invoice' OR customer_invoice_id IS NOT NULL);

-- An advance must be traceable back to something.
ALTER TABLE customer_invoice_payments
  DROP CONSTRAINT IF EXISTS cip_advance_has_context;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT cip_advance_has_context
  CHECK (payment_type <> 'advance'
         OR estimate_id IS NOT NULL
         OR appointment_id IS NOT NULL
         OR booking_id IS NOT NULL);

-- A voucher number is unique for ever, and only advances carry one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cip_voucher_no
  ON customer_invoice_payments (voucher_no) WHERE voucher_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cip_public_token
  ON customer_invoice_payments (public_token) WHERE public_token IS NOT NULL;

-- "What has this customer paid, newest first" — the customer Payments tab.
CREATE INDEX IF NOT EXISTS idx_cip_mobile ON customer_invoice_payments (mobile, paid_at DESC);
-- "Is there an advance on this estimate" — the auto-apply lookup, run inside
-- the transaction that generates an invoice, so it has to be quick.
CREATE INDEX IF NOT EXISTS idx_cip_estimate
  ON customer_invoice_payments (estimate_id) WHERE estimate_id IS NOT NULL;
-- The aged-advance list.
CREATE INDEX IF NOT EXISTS idx_cip_advance
  ON customer_invoice_payments (payment_type, paid_at DESC) WHERE payment_type = 'advance';

-- Backfill the identity columns for the rows that already exist. Every one of
-- them is an ordinary invoice payment, so the source is its invoice.
UPDATE customer_invoice_payments cip
   SET mobile = ci.mobile,
       vehicle_number = ci.vehicle_number,
       appointment_id = ci.appointment_id,
       estimate_id = ci.estimate_id
  FROM customer_invoices ci
 WHERE ci.id = cip.customer_invoice_id
   AND cip.mobile IS NULL;

COMMENT ON COLUMN customer_invoice_payments.customer_invoice_id IS
  'The invoice this payment was TAKEN against, or NULL for an advance received before any invoice existed. This is NOT the invoice the money is applied to — that is payment_allocations (migration 133), and one payment can be applied to more than one.';
COMMENT ON COLUMN customer_invoice_payments.payment_type IS
  'invoice = taken against an existing invoice. advance = received before one existed, and applied later through an allocation.';
COMMENT ON COLUMN customer_invoice_payments.gst_amount IS
  'The GST inside `amount`, snapshotted when the money was taken. amount is GST-INCLUSIVE — a ₹2,000 advance on a ₹5,000 job is ₹2,000 paid, tax included. Never recalculated: the estimate it came from can be edited afterwards, and a receipt already handed to a customer must not change its own tax.';
COMMENT ON COLUMN customer_invoice_payments.voucher_no IS
  'The advance receipt number, issued ON CAPTURE and never reused. NULL until the money is confirmed — an abandoned payment link must not consume a number out of a tax series.';
