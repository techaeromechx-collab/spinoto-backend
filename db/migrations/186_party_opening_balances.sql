-- Migration 186: opening balances, for the ledger to start from.
--
-- ══ WHY THIS EXISTS ════════════════════════════════════════════════════════
--
-- A ledger that begins at the first Spinoto document is wrong for anyone who
-- carried a balance in. The first time a customer says "but I already paid you
-- ₹5,000 last year" the statement has no way to be right, and a statement that
-- can be argued with is not usable for collection.
--
-- ══ APPEND-ONLY, NOT EDIT-IN-PLACE ═════════════════════════════════════════
--
-- An opening balance is the one figure in the ledger that somebody types by
-- hand, which makes it the one figure somebody could quietly change. So it is
-- never updated: correcting one SUPERSEDES the old row and inserts a new one,
-- and the old row stays.
--
-- Three reasons, in order of how much they matter:
--
--   1. Rule 56 requires an erroneous entry to be corrected by a new attested
--      entry rather than overwritten. Same principle as the credit note.
--   2. Rule 3 of the Companies (Accounts) Rules requires accounting software
--      used by a company to keep an audit trail of every change, which cannot
--      be disabled. History that is a side effect of the design cannot be
--      switched off.
--   3. "It said ₹5,000 last week" is answerable.
--
-- The partial unique index is what makes "current" unambiguous: exactly one
-- live row per party, any number of superseded ones behind it.
--
-- ══ PARTY KEY ══════════════════════════════════════════════════════════════
--
-- A customer in this system IS a mobile number — customer_profiles is keyed on
-- it and there is no customer id anywhere. A hub has a real id. So party_key is
-- text and holds whichever applies, rather than two nullable columns where
-- every query has to remember the COALESCE.
--
-- Not a foreign key, deliberately: an opening balance for a customer who has
-- not yet been invoiced is a legitimate thing to record, and a hub deleted
-- later must not take its history with it.

BEGIN;

CREATE TABLE IF NOT EXISTS party_opening_balances (
  id          SERIAL PRIMARY KEY,

  party_type  VARCHAR(10) NOT NULL CHECK (party_type IN ('customer','hub')),
  -- mobile for a customer, hub id as text for a hub.
  party_key   VARCHAR(40) NOT NULL,

  -- Always POSITIVE. Which way it points is direction's job — a signed amount
  -- plus a direction is two ways to say the same thing and they drift apart.
  amount      NUMERIC(12,2) NOT NULL CHECK (amount >= 0),

  -- 'dr' they owed us on the as-of date
  -- 'cr' we owed them (an advance they had already paid, or a hub we were behind on)
  direction   VARCHAR(2) NOT NULL CHECK (direction IN ('dr','cr')),

  -- The ledger shows this as its first row and everything after it is real
  -- documents. A balance with no date cannot be placed in a statement.
  as_of_date  DATE NOT NULL,

  note        TEXT,

  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- NULL = this is the live figure. Set when a correction supersedes it.
  superseded_at TIMESTAMPTZ,
  superseded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Exactly one live row per party. Superseded rows are unconstrained, so a
-- party can have as much history as it needs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pob_live
  ON party_opening_balances (party_type, party_key)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pob_party
  ON party_opening_balances (party_type, party_key);

COMMENT ON TABLE party_opening_balances IS
  'What a customer or hub owed before Spinoto started recording. Append-only: a correction supersedes the old row rather than updating it, so the history is a property of the design rather than a feature that can be turned off. Exactly one live row per party (superseded_at IS NULL).';
COMMENT ON COLUMN party_opening_balances.party_key IS
  'mobile for party_type=customer (customer_profiles is keyed on mobile; there is no customer id), hub id as text for party_type=hub. Deliberately not a foreign key - a balance may be recorded before the party has any documents.';
COMMENT ON COLUMN party_opening_balances.direction IS
  'dr = the party owed us on as_of_date. cr = we owed the party. amount is always positive; this is the only thing that says which way it points.';

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM party_opening_balances WHERE superseded_at IS NULL;
  RAISE NOTICE '186: party_opening_balances ready (% live row(s)). '
               'Expected scope on current data: 4 B2B customers and 9 hubs with a pending balance.', n;
END $$;

COMMIT;
