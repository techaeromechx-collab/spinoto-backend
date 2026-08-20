-- 107_workshops.sql
--
-- Workshops — the stage before a Hub.
--
-- A Workshop is a garage we are TALKING TO. It holds the basics, gets edited
-- and discussed, and is either approved and converted into a Hub or dropped.
--
-- ── Why a separate table and not a pending hub ───────────────────────────────
-- `hubs` already has verification_status ('pending' → 'verified' → 'rejected'),
-- so a prospect could in principle live there as a pending row. It must not.
-- `hubs` is referenced by appointments, customer_invoices, purchase_invoices,
-- hub_payments, hub_service_mapping and the Hub Revenue report. Every garage we
-- ever spoke to and passed on would leave a permanent row in all of them —
-- polluting hub dropdowns, payout runs and revenue totals with businesses that
-- were never ours.
--
-- Keeping prospects out of `hubs` entirely is the whole point of the module.
--
-- ── Direct hub creation is UNCHANGED ─────────────────────────────────────────
-- This adds a second path to a Hub; it does not replace the first. "Add Hub"
-- still creates a hub directly and still starts at verification_status
-- 'pending'. Only conversion (see 4 below) writes 'verified'.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. workshops
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every typed column here maps 1:1 onto a hubs column, so conversion is a copy
-- rather than a translation. Deliberately absent: commission, tech rates,
-- payout terms, bank details, GST and the operational figures. Those are still
-- being negotiated at this stage, and recording a guess as though it were
-- agreed is worse than recording nothing.

CREATE TABLE IF NOT EXISTS workshops (
    id                SERIAL PRIMARY KEY,

    -- Core — mirrors hubs.hub_name / person_name / contact_number
    workshop_name     VARCHAR(150) NOT NULL,
    person_name       VARCHAR(120) NOT NULL,
    contact_number    VARCHAR(10)  NOT NULL,

    -- Owner + company (optional at this stage, as on hubs)
    owner_name        VARCHAR(120),
    owner_mobile      VARCHAR(10),
    company_name      VARCHAR(200),

    -- Location. Same FKs as hubs, by decision — a Workshop in an area that is
    -- not yet in Location Master cannot be logged until the area is added. That
    -- is the accepted cost of conversion being a straight copy; free text here
    -- would have to be reconciled to an area at convert time, which is exactly
    -- the moment nobody wants a data-entry puzzle.
    state_id          INTEGER NOT NULL REFERENCES states(id),
    city_id           INTEGER NOT NULL REFERENCES cities(id),
    area_id           INTEGER NOT NULL REFERENCES areas(id),

    vehicle_class     VARCHAR(4) NOT NULL DEFAULT 'both'
                      CHECK (vehicle_class IN ('2W', '4W', 'both')),

    notes             TEXT,

    -- ── Lifecycle ────────────────────────────────────────────────────────────
    --   draft     → being filled in and discussed; editable
    --   approved  → reviewed and ready; the only status Convert accepts
    --   rejected  → turned down, with a reason; editing sends it back to draft
    --   dropped   → went cold / we walked away. Distinct from rejected: nobody
    --               judged it unsuitable, the conversation simply ended, and
    --               conflating the two would corrupt any read of why prospects
    --               fail.
    --   converted → became a Hub. Terminal and read-only.
    status            VARCHAR(12) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','rejected','dropped','converted')),
    rejection_reason  TEXT,
    approved_by       INTEGER REFERENCES users(id),
    approved_at       TIMESTAMPTZ,

    -- ── Conversion ───────────────────────────────────────────────────────────
    -- UNIQUE is the double-conversion guard. The controller also takes a row
    -- lock (SELECT … FOR UPDATE) before converting, but a constraint is what
    -- makes a duplicate Hub impossible rather than merely unlikely: two
    -- concurrent requests that both pass the status check still cannot both
    -- write this column.
    --
    -- ON DELETE SET NULL, not CASCADE: deleting a Hub must never delete the
    -- record of the prospect it came from. The audit trail outlives the Hub.
    converted_hub_id  INTEGER UNIQUE REFERENCES hubs(id) ON DELETE SET NULL,
    converted_by      INTEGER REFERENCES users(id),
    converted_at      TIMESTAMPTZ,

    created_by        INTEGER REFERENCES users(id),
    deleted_at        TIMESTAMPTZ,             -- soft delete, as on hubs
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique name among live rows, mirroring idx_hubs_hub_name_unique. Catches the
-- same garage being logged twice by two RMs — which is the common way a
-- duplicate Hub gets made — at the point it costs nothing to fix.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workshops_name_unique
    ON workshops (LOWER(workshop_name))
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workshops_status   ON workshops (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workshops_state    ON workshops (state_id);
CREATE INDEX IF NOT EXISTS idx_workshops_city     ON workshops (city_id);
CREATE INDEX IF NOT EXISTS idx_workshops_area     ON workshops (area_id);
CREATE INDEX IF NOT EXISTS idx_workshops_created  ON workshops (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workshops_deleted  ON workshops (deleted_at);

COMMENT ON TABLE  workshops                  IS 'Candidate hubs. Converted into a real hub once approved; never referenced by invoices or payouts.';
COMMENT ON COLUMN workshops.status           IS 'draft | approved | rejected | dropped | converted';
COMMENT ON COLUMN workshops.converted_hub_id IS 'The hub this became. UNIQUE — a workshop can only ever convert once.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. workshop_photos
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Site-visit photos. Whoever approves a Workshop has usually never seen the
-- place, so these are what makes reviewing it possible at all.
--
-- Not modelled on hub_documents: that table has a fixed doc_type enum and one
-- row per type. Photos are many, untyped and unordered.
--
-- No workshop_documents table exists by decision — Aadhaar, PAN, licence,
-- agreement and GST certificate are all uploaded in the Convert popup and land
-- straight in hub_documents. Nothing personal is ever held for a prospect we
-- did not sign.

CREATE TABLE IF NOT EXISTS workshop_photos (
    id           SERIAL      PRIMARY KEY,
    workshop_id  INTEGER     NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    file_name    TEXT        NOT NULL,
    file_url     TEXT        NOT NULL,
    caption      VARCHAR(200),
    uploaded_by  INTEGER     REFERENCES users(id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workshop_photos_workshop ON workshop_photos (workshop_id);

COMMENT ON TABLE workshop_photos IS 'Site-visit photos. Kept on the workshop after conversion — the hub reaches them via workshops.converted_hub_id rather than copying files.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. updated_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_workshops_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workshops_updated_at ON workshops;
CREATE TRIGGER trg_workshops_updated_at
  BEFORE UPDATE ON workshops
  FOR EACH ROW EXECUTE FUNCTION set_workshops_updated_at();

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Note for the reader: nothing here changes hubs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Conversion writes verification_status = 'verified' and is_active = true on
-- the new hub. That needs no schema change — both columns already exist; the
-- ordinary create path simply never sets them, so a directly-added hub still
-- starts 'pending' and inactive exactly as it does today. The difference lives
-- in the INSERT the convert endpoint issues, not in the table.
