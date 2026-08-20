-- Migration 141: money taken from a customer with no job attached.
--
-- ── WHAT CHANGES, AND WHY IT IS ONE CONSTRAINT ──────────────────────────────
-- Migration 135 said an advance must be traceable to something:
--
--     CHECK (payment_type <> 'advance'
--            OR estimate_id IS NOT NULL
--            OR appointment_id IS NOT NULL
--            OR booking_id IS NOT NULL)
--
-- That rule is right and it stays. What it assumed is that "something" is
-- always a JOB — and it is not. A customer can hand over a deposit before
-- anyone has quoted anything, and that money is traceable to a person even
-- though it is attached to no work.
--
-- So mobile joins the list. An advance is still never allowed to float free;
-- it just no longer has to belong to an estimate, an appointment or a booking.
--
-- customer_identities keys on mobile (there is no customers table), so a mobile
-- IS the customer in this system. Attaching money to one is attaching it to a
-- person, not to a string.
--
-- ── THE RATE, AND WHY IT IS A SETTING RATHER THAN A FIELD ───────────────────
-- An advance against an estimate takes its GST from that estimate: the tax is
-- the same proportion as the job it is part of. With no job there is nothing to
-- take a proportion of, and a receipt voucher must still state its tax.
--
-- The rate is therefore a company-wide setting, answered once by the company's
-- accountant, and NOT a field on the form. A rate dropdown would turn a tax
-- decision into a data-entry choice made by whoever is at the counter.
--
-- NULL means unanswered, and unanswered means the feature is OFF — the service
-- refuses rather than guessing. That is deliberate: there is no safe default
-- here, and a wrong rate is on a document the customer keeps.
--
-- The rate is SNAPSHOTTED onto every payment when it is taken (gst_rate on
-- customer_invoice_payments, already there since 135). Changing this setting
-- later therefore changes the next receipt and never a past one.

ALTER TABLE customer_invoice_payments DROP CONSTRAINT IF EXISTS cip_advance_has_context;
ALTER TABLE customer_invoice_payments
  ADD CONSTRAINT cip_advance_has_context
  CHECK (payment_type <> 'advance'
         OR estimate_id IS NOT NULL
         OR appointment_id IS NOT NULL
         OR booking_id IS NOT NULL
         -- New: money on the customer's account, belonging to no job yet.
         OR mobile IS NOT NULL);

COMMENT ON CONSTRAINT cip_advance_has_context ON customer_invoice_payments IS
  'An advance always belongs to someone. Usually that is a job — an estimate, an appointment or a booking — and where it is not, it is the customer themselves (mobile). What this forbids is an advance attached to nothing at all, which would be money the system holds and no screen could find.';

-- ── The rate for money taken with no job ────────────────────────────────────

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS advance_default_gst_rate NUMERIC(5,2);

ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_advance_rate_range;
ALTER TABLE company_settings
  ADD CONSTRAINT company_advance_rate_range
  CHECK (advance_default_gst_rate IS NULL
         OR (advance_default_gst_rate >= 0 AND advance_default_gst_rate <= 100));

COMMENT ON COLUMN company_settings.advance_default_gst_rate IS
  'GST rate for an advance taken before any job exists, where no estimate can supply the proportion. NULL = not answered, and the feature stays off rather than guessing — a wrong rate ends up on a tax document the customer keeps. Snapshotted onto each payment at capture, so changing it never alters a receipt already issued.';

-- ── Gateway scope: a payment link can now belong to a customer ──────────────
--
-- 'estimate' arrived in 136 for advances against a quoted job. 'customer' is
-- the same idea one step earlier: a link that collects money from a person
-- before there is any job to attach it to.

ALTER TABLE payment_links DROP CONSTRAINT IF EXISTS payment_links_entity_type_check;
ALTER TABLE payment_links
  ADD CONSTRAINT payment_links_entity_type_check
  CHECK (entity_type IN ('customer_invoice', 'estimate', 'customer'));

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_entity_type_check;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_entity_type_check
  CHECK (entity_type IN ('customer_invoice', 'booking', 'estimate', 'customer'));

COMMENT ON COLUMN payment_transactions.entity_type IS
  'customer_invoice = paying an invoice. estimate = an advance against a quoted job. customer = money on account, before any job exists — entity_id is unused there, and the mobile on the row is the identity. booking = the public booking flow.';

-- Finding on-account money for one customer is the customer page''s first
-- question, and it asks it on every visit.
CREATE INDEX IF NOT EXISTS idx_cip_account_credit
  ON customer_invoice_payments (mobile, paid_at DESC)
  WHERE payment_type = 'advance' AND estimate_id IS NULL;
