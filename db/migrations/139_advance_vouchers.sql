-- Migration 139: the advance receipt and refund vouchers become documents.
--
-- Migration 137 gave advances a number series. This gives the number a document
-- to sit on, and gives the refund its own series and its own document.
--
-- ── WHY THE REFUND NEEDS ITS OWN SERIES ─────────────────────────────────────
-- A receipt voucher says "we took ₹2,000 including ₹305.08 of GST". If that
-- money goes back, the GST goes back with it, and the reversal is its OWN
-- numbered document — not an edit to the receipt, and not a gap in the receipt
-- series. Two documents, two consecutive series, both permanent:
--
--     ADV-2026-27-000042    ₹2,000 received
--     ADVR-2026-27-000003   ₹2,000 returned, reversing ₹305.08 of GST
--
-- The sequence table gains doc_kind so the two counters never interleave. A
-- shared counter would make the receipt series jump 41 → 43 every time a refund
-- was issued, and a jump in a tax series is a question someone has to answer.
--
-- ── WHEN THE REFUND NUMBER IS ISSUED ────────────────────────────────────────
-- On PROCESSED, never on request — the same rule the receipt follows, for the
-- same reason. A gateway refund can be requested and then fail; numbering it at
-- request time would leave a hole in the series for money that never moved. A
-- cash refund is processed the moment it is handed back, so it is numbered
-- immediately. See advances.service.issueRefundVoucher().

-- ── The sequence table learns about two kinds of document ───────────────────

ALTER TABLE advance_voucher_sequences
  ADD COLUMN IF NOT EXISTS doc_kind VARCHAR(10) NOT NULL DEFAULT 'receipt';

ALTER TABLE advance_voucher_sequences DROP CONSTRAINT IF EXISTS avs_doc_kind_check;
ALTER TABLE advance_voucher_sequences
  ADD CONSTRAINT avs_doc_kind_check CHECK (doc_kind IN ('receipt', 'refund'));

-- The old indexes are replaced rather than added to: (hub_id, fy) alone would
-- now collapse the receipt and refund series of the same hub into one row.
-- Existing rows all default to 'receipt', so nothing is renumbered.
DROP INDEX IF EXISTS uq_avs_hub_fy;
DROP INDEX IF EXISTS uq_avs_company_fy;

CREATE UNIQUE INDEX IF NOT EXISTS uq_avs_hub_fy_kind
  ON advance_voucher_sequences (hub_id, fy, doc_kind) WHERE hub_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_avs_company_fy_kind
  ON advance_voucher_sequences (fy, doc_kind) WHERE hub_id IS NULL;

COMMENT ON COLUMN advance_voucher_sequences.doc_kind IS
  'receipt = ADV- (money taken), refund = ADVR- (money returned). Separate counters: sharing one would make the receipt series skip a number every time a refund was issued.';

-- ── The refund becomes a document ───────────────────────────────────────────

ALTER TABLE payment_refunds
  -- The tax document's own number. NULL until the refund is processed, which
  -- is the whole point — see the header note.
  ADD COLUMN IF NOT EXISTS voucher_no    VARCHAR(30),
  ADD COLUMN IF NOT EXISTS voucher_fy    VARCHAR(9),
  ADD COLUMN IF NOT EXISTS voucher_seq   INTEGER,

  -- The customer's own copy, same mechanism as invoices and estimates.
  ADD COLUMN IF NOT EXISTS public_token  VARCHAR(20),

  -- The tax being reversed, snapshotted at the same proportion the advance was
  -- taken at. Derived at refund time and then FROZEN: recomputing it later from
  -- an estimate whose lines have since been edited would reverse a different
  -- number from the one the receipt voucher printed.
  ADD COLUMN IF NOT EXISTS gst_amount    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS gst_rate      NUMERIC(5,2);

-- Same guarantee the receipt series has: a number, once handed out, belongs to
-- exactly one document forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_voucher_no
  ON payment_refunds (voucher_no) WHERE voucher_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_public_token
  ON payment_refunds (public_token) WHERE public_token IS NOT NULL;

-- The advance's own refunds, oldest first — what the customer page shows under
-- a credit balance that has been returned.
CREATE INDEX IF NOT EXISTS idx_refund_ledger
  ON payment_refunds (ledger_payment_id, created_at) WHERE ledger_payment_id IS NOT NULL;

COMMENT ON COLUMN payment_refunds.voucher_no IS
  'ADVR-YYYY-YY-NNNNNN. Issued when the refund is PROCESSED, never when it is requested — a requested refund can still fail, and numbering it would leave a hole in a tax series for money that never moved.';
COMMENT ON COLUMN payment_refunds.gst_amount IS
  'The GST being reversed, at the same proportion the advance was taken at. Snapshotted, not recomputed: the estimate it came from can be edited afterwards.';
