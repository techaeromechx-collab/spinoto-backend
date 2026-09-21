-- Migration 185: credit notes, and debit notes on the hub side.
--
-- ══ WHY THIS BLOCKS THREE THINGS ═══════════════════════════════════════════
--
-- There is no way to reverse or reduce an issued invoice anywhere in this
-- system. That single gap stops three separate features:
--
--   the ledger   a statement that cannot show a refund is not a statement
--   GSTR-1       Table 9B has no source, so the return files a silent nil
--   refunds      a payment can be refunded, but the INVOICE it settled still
--                stands at its full value afterwards
--
-- This is OPN-019. It closes here.
--
-- ══ WHY A DOCUMENT, NOT AN EDIT ════════════════════════════════════════════
--
-- The obvious shortcut is to let someone reduce the invoice total. It is also
-- illegal. Rule 56 requires an erroneous entry to be "scored out under
-- attestation" and a correct entry recorded — a new document, not an
-- overwrite. Section 34 says the same thing in stronger terms: the way to
-- reduce an issued tax invoice is to issue a credit note against it.
--
-- So the invoice never changes. A credit note sits beside it and reduces what
-- is payable. Both remain on the record, which is the point.
--
-- ══ ONE TABLE, BOTH DIRECTIONS ═════════════════════════════════════════════
--
--   direction = 'credit'  we reduce what a CUSTOMER owes us       (Table 9B)
--   direction = 'debit'   we reduce what we owe a HUB
--
-- Same shape, opposite sign, so the ledger reads one table rather than two.
-- The hub side is a debit note in our books and a credit note in the hub's —
-- the same document seen from two ends, exactly as a purchase invoice already
-- is in this system.
--
-- ══ NUMBERING ══════════════════════════════════════════════════════════════
--
-- CN/2026-27/0001, from a real sequence table under a row lock.
--
-- Deliberately NOT the 'CN-' + row id shape that customer invoices use. That
-- pattern works but it is not a series — it is a primary key wearing a
-- costume, and it cannot restart per financial year, which is what a CA
-- expects of a credit note register. A new document is the right place to do
-- it properly rather than inherit the shortcut.
--
-- The format lives in one constant in the controller if it needs changing.

BEGIN;

-- ── The series ─────────────────────────────────────────────────────────────
-- Modelled on advance_voucher_sequences (migration 137), same three rules:
-- issued on creation under FOR UPDATE, never renumbered, never reused. A
-- cancelled note keeps its number; a gap in a tax series is something somebody
-- has to explain later.
CREATE TABLE IF NOT EXISTS credit_note_sequences (
  id          SERIAL PRIMARY KEY,
  -- 'customer' and 'hub' get separate series. They are different registers to
  -- a reader, and interleaving them makes neither readable.
  party_type  VARCHAR(10) NOT NULL CHECK (party_type IN ('customer','hub')),
  fy          VARCHAR(9)  NOT NULL,
  next_seq    INTEGER     NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cns_party_fy
  ON credit_note_sequences (party_type, fy);

COMMENT ON TABLE credit_note_sequences IS
  'Consecutive credit/debit note numbers per financial year, separate series for customer and hub. Issued under SELECT … FOR UPDATE inside the creating transaction. Never renumbered, never reused - a cancelled note keeps its number.';

-- ── The note ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_notes (
  id            SERIAL PRIMARY KEY,

  note_no       VARCHAR(30) NOT NULL,
  note_fy       VARCHAR(9)  NOT NULL,
  note_seq      INTEGER     NOT NULL,

  direction     VARCHAR(10) NOT NULL CHECK (direction IN ('credit','debit')),
  party_type    VARCHAR(10) NOT NULL CHECK (party_type IN ('customer','hub')),

  -- Exactly one of these two is set; the CHECK at the bottom enforces it.
  customer_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE RESTRICT,
  purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE RESTRICT,

  -- ON DELETE RESTRICT, not CASCADE. An invoice with a credit note against it
  -- must not be deletable — the note is the evidence that the reduction
  -- happened, and deleting the pair leaves the return unexplainable.

  -- Party snapshot, frozen at issue for the same reason the invoice freezes
  -- its own: correcting a customer's name next year must not rewrite a
  -- document already filed.
  mobile        VARCHAR(20),
  customer_name VARCHAR(200),
  hub_id        INTEGER REFERENCES hubs(id) ON DELETE SET NULL,

  note_date     DATE NOT NULL,

  -- Section 34(1) gives the grounds. Storing the reason as an enum rather than
  -- free text because it decides how the note reads on the document and,
  -- for 'post_sale_discount', whether the tax may be reduced at all.
  reason        VARCHAR(30) NOT NULL CHECK (reason IN (
                  'rejection_after_payment', 'price_correction',
                  'goods_returned', 'deficiency_in_service',
                  'post_sale_discount', 'other')),
  reason_note   TEXT,

  subtotal_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_ex_gst >= 0),
  total_gst       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_gst >= 0),
  grand_total     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),

  -- GST context, snapshotted exactly as customer_invoices does. A credit note
  -- is a tax document in its own right and must be able to print and file
  -- without re-deriving anything from the invoice it points at.
  place_of_supply_code VARCHAR(2),
  place_of_supply_name VARCHAR(100),
  is_b2b               BOOLEAN NOT NULL DEFAULT FALSE,
  b2b_gst_number       VARCHAR(15),
  b2b_company_name     VARCHAR(200),

  -- 'cancelled' exists for a note raised in error. It keeps its number and
  -- stops counting, rather than being deleted.
  status        VARCHAR(20) NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued','cancelled')),

  public_token  VARCHAR(20),

  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,

  -- A customer note points at a customer invoice; a hub note at a purchase
  -- invoice. Enforced here rather than trusted to the controller, because a
  -- note attached to nothing is a number that can never be explained.
  CONSTRAINT credit_notes_target_ck CHECK (
    (party_type = 'customer' AND customer_invoice_id IS NOT NULL AND purchase_invoice_id IS NULL)
    OR
    (party_type = 'hub'      AND purchase_invoice_id IS NOT NULL AND customer_invoice_id IS NULL)
  ),
  -- A customer note is always a credit; a hub note is always a debit. Kept as
  -- two columns rather than one because the ledger reads direction and the
  -- register reads party_type, and collapsing them would make one of the two
  -- queries worse for no gain.
  CONSTRAINT credit_notes_direction_ck CHECK (
    (party_type = 'customer' AND direction = 'credit')
    OR
    (party_type = 'hub'      AND direction = 'debit')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_notes_no ON credit_notes (note_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_notes_token
  ON credit_notes (public_token) WHERE public_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_ci ON credit_notes (customer_invoice_id) WHERE customer_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_pi ON credit_notes (purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_mobile ON credit_notes (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_hub ON credit_notes (hub_id) WHERE hub_id IS NOT NULL;
-- The GSTR-1 lookup: every note in a period, newest first.
CREATE INDEX IF NOT EXISTS idx_credit_notes_date ON credit_notes (note_date) WHERE status = 'issued';

COMMENT ON COLUMN credit_notes.reason IS
  'Section 34(1) grounds. post_sale_discount is the one to watch: tax may only be reduced where the discount was agreed BEFORE or at the time of supply and is linked to the relevant invoices - otherwise the note reduces the amount but not the tax.';
COMMENT ON COLUMN credit_notes.status IS
  'issued | cancelled. A cancelled note keeps its number and stops counting. Nothing is ever deleted.';

-- ── The lines ──────────────────────────────────────────────────────────────
-- A credit note carries its own lines rather than a lump sum, because Table 12
-- of GSTR-1 is an HSN summary and a lump-sum reversal cannot be attributed to
-- an HSN. Lines also make a partial credit obvious: two of five items returned
-- reads as two rows, not as an unexplained figure.
CREATE TABLE IF NOT EXISTS credit_note_items (
  id             SERIAL PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,

  -- Which invoice line this reverses. Nullable, because a price correction may
  -- not map to any single line.
  customer_invoice_item_id INTEGER REFERENCES customer_invoice_items(id) ON DELETE SET NULL,
  purchase_invoice_item_id INTEGER REFERENCES purchase_invoice_items(id) ON DELETE SET NULL,

  item_type      VARCHAR(20) NOT NULL DEFAULT 'service',
  description    VARCHAR(300) NOT NULL,
  hsn_sac        VARCHAR(20),

  quantity       NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  rate           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  gst_percent    NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (gst_percent >= 0),
  gst_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  total_inc_gst  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_inc_gst >= 0),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cn_items_note ON credit_note_items (credit_note_id);

-- ON DELETE CASCADE here, unlike the invoice link above: the lines belong to
-- the note and have no meaning without it. The note itself is never deleted,
-- so this cascade is a safety net rather than a route anyone takes.

-- ── The permission ─────────────────────────────────────────────────────────
-- MANAGE_CREDIT_NOTE is a permission STRING checked by requirePermission; it
-- needs no row of its own. It is deliberately granted to no role here. A
-- credit note reduces revenue and tax liability, so who may issue one is a
-- decision for the business, not a default chosen by a migration. Super admins
-- bypass permissions already; everyone else is assigned it in the roles
-- screen, on purpose.

COMMENT ON TABLE credit_notes IS
  'Credit notes to customers (GSTR-1 Table 9B) and debit notes to hubs. Requires the MANAGE_CREDIT_NOTE permission, which is granted to no role by default. Closes OPN-019.';

-- ── Report ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '185: credit_notes, credit_note_items and credit_note_sequences created. '
               'Grant MANAGE_CREDIT_NOTE to a role before anyone can issue one.';
END $$;

COMMIT;
