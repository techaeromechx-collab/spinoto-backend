-- Migration 194: what the store issued, and who did the work.
--
-- ══ WHY ISSUING IS NOT QUOTING ═════════════════════════════════════════════
--
-- estimate_items already records a part: description, quantity, rate, GST. It
-- is tempting to say that is the part list and stop.
--
-- It is not. An estimate line is a PRICE the customer agreed to. A store issue
-- is a PHYSICAL EVENT: at 11:40 the storekeeper handed two oil filters to Amit.
-- The two differ in every way that matters on a workshop floor:
--
--   * order    — the part goes out before the supplementary estimate is raised,
--                because the car is on the ramp and the job cannot wait for a
--                customer to answer the phone.
--   * quantity — one filter is fitted, one is the wrong part and comes back.
--                The estimate says 1. The store ledger has to say 2 out, 1 back.
--   * absence  — a part issued that never reaches an estimate is the single
--                most expensive routine mistake a workshop makes, and it is
--                invisible unless issuing is recorded separately from billing.
--
-- So: a row per issue, with an OPTIONAL link to the estimate line it is meant
-- to be billed on. The link being nullable is the point — an unlinked row is
-- exactly the leak the parts_reconciled gate below reports.
--
-- ══ WHY THE NAME IS COPIED ═════════════════════════════════════════════════
--
-- part_id is SET NULL on delete and part_name is NOT NULL, the same bargain
-- migration 190 struck for inspection points. Master data gets renamed and
-- tidied; a job card from March must keep saying what was actually fitted in
-- March. The id is kept for analytics while it survives; the text is the
-- record.
--
-- ══ WHY MINUTES, NOT HOURS ═════════════════════════════════════════════════
--
-- NUMERIC hours produce 1.5 and 1.30 in the same column meaning different
-- things, entered by different people, and nobody can tell which is which
-- afterwards. Integer minutes has exactly one spelling. The screen divides.
--
-- ══ WHY LABOUR IS NOT job_card_technicians ═════════════════════════════════
--
-- job_card_technicians answers "who is on this car" — the roster, the names on
-- the board. job_card_labour answers "who did what, for how long" — many rows
-- per technician, per day, per line of work. Forcing both into one table means
-- either the roster grows duplicate names or the time log loses its detail.
--
-- ON DELETE RESTRICT on technician_id, for the reason migration 188 spelled
-- out: removing a technician who has left must never delete the record of the
-- work they did. is_active retires them.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTS ISSUED FROM THE STORE
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS job_card_parts (
  id                SERIAL PRIMARY KEY,
  job_card_id       INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

  -- Kept for analytics while the master row lives; the snapshot below is the
  -- record if it does not.
  part_id           INTEGER REFERENCES parts(id) ON DELETE SET NULL,

  -- The estimate line this issue is meant to be billed on. NULL is legal and
  -- meaningful: it is a part that has gone out with nothing to bill it against
  -- yet. SET NULL rather than CASCADE — deleting an estimate must not delete
  -- the store's record of a part leaving the shelf.
  estimate_item_id  INTEGER REFERENCES estimate_items(id) ON DELETE SET NULL,

  part_name         TEXT NOT NULL,
  part_number       TEXT,

  quantity          NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit              TEXT NOT NULL DEFAULT 'nos',

  -- Where it came from. 'purchased' is the part bought in for this one job;
  -- 'customer' is the part the customer brought themselves, which must never
  -- appear on an invoice and must still appear on the job card.
  source            TEXT NOT NULL DEFAULT 'store'
                    CHECK (source IN ('store', 'purchased', 'customer')),

  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_to         INTEGER REFERENCES technicians(id) ON DELETE SET NULL,

  -- Partial returns are ordinary: two gaskets out, one fitted, one back.
  returned_quantity NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  returned_at       TIMESTAMPTZ,
  return_note       TEXT,

  -- The old part, shown to the customer. The parts_inspection gate is a manual
  -- tick on the whole card; this is the same question per part, for the hubs
  -- that want to answer it that precisely. NULL = not asked.
  old_part_shown    BOOLEAN,

  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_card_parts_return_within_issue
    CHECK (returned_quantity <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_job_card_parts_card ON job_card_parts (job_card_id, id);
CREATE INDEX IF NOT EXISTS idx_job_card_parts_part ON job_card_parts (part_id);
CREATE INDEX IF NOT EXISTS idx_job_card_parts_item ON job_card_parts (estimate_item_id);

COMMENT ON TABLE job_card_parts IS
  'Parts physically issued from the store to this job. NOT the same as estimate_items, which is what the customer was quoted - a part goes out before it is billed, and some of it comes back.';
COMMENT ON COLUMN job_card_parts.estimate_item_id IS
  'Optional link to the line this will be billed on. NULL means issued but not yet billable - which is exactly what the parts_reconciled gate reports.';
COMMENT ON COLUMN job_card_parts.part_name IS
  'Snapshot. Survives the master part being renamed or deleted, the same bargain migration 190 struck for inspection points.';

-- ════════════════════════════════════════════════════════════════════════════
-- LABOUR: WHO DID WHAT, FOR HOW LONG
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS job_card_labour (
  id               SERIAL PRIMARY KEY,
  job_card_id      INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  technician_id    INTEGER NOT NULL REFERENCES technicians(id) ON DELETE RESTRICT,

  -- The service line this time was spent on, where there is one. NULL is a
  -- perfectly ordinary entry: diagnosis before anything is quoted, a road
  -- test, or a hub that does not itemise.
  estimate_item_id INTEGER REFERENCES estimate_items(id) ON DELETE SET NULL,

  -- Snapshot of what was being done, for the same reason part_name is copied.
  task             TEXT NOT NULL,

  minutes          INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),

  -- A car on the floor for three days needs "2h Tuesday, 3h Wednesday", not
  -- "5h". Defaults to today in IST, because a hub closing at 21:30 is still
  -- working on today's date and UTC would move it to tomorrow.
  worked_on        DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date),

  note             TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_card_labour_card ON job_card_labour (job_card_id, id);
CREATE INDEX IF NOT EXISTS idx_job_card_labour_tech ON job_card_labour (technician_id, worked_on);
CREATE INDEX IF NOT EXISTS idx_job_card_labour_item ON job_card_labour (estimate_item_id);

COMMENT ON TABLE job_card_labour IS
  'The time log. job_card_technicians is the roster (who is on this car); this is the work (who did what, for how long, on which day).';
COMMENT ON COLUMN job_card_labour.minutes IS
  'Integer minutes on purpose. NUMERIC hours give 1.5 and 1.30 in one column meaning different things.';
COMMENT ON COLUMN job_card_labour.technician_id IS
  'RESTRICT. Deleting a technician who has left must never delete the record of work they did - retire them with is_active.';

-- ════════════════════════════════════════════════════════════════════════════
-- SETTINGS
-- ════════════════════════════════════════════════════════════════════════════
-- Both sections ON, like every other section: a hub that does not use them
-- simply leaves them empty, and an empty section costs nothing.
--
-- parts_must_be_billed is OFF, and deliberately so. It turns "a part was
-- issued with no estimate line" into a hard stop before Ready. Switched on for
-- everybody on deploy day it would block every card mid-job at the hubs that
-- issue first and bill later - which is all of them. It is a policy a hub
-- opts into once its store habits can survive it.
UPDATE job_card_settings
   SET sections = sections || '{"parts": true, "labour": true, "parts_must_be_billed": false}'::jsonb,
       updated_at = NOW()
 WHERE NOT (sections ? 'parts');

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM job_cards;
  RAISE NOTICE '194: parts issuance and labour ready. % job card(s) can now record them.', n;
END $$;

COMMIT;
