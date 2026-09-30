-- Migration 188: technicians — the people on the hub floor.
--
-- ══ WHY NOT users ══════════════════════════════════════════════════════════
--
-- A technician is not a Spinoto login. They are a hub's employee, they work on
-- a ramp, turnover is high, and most will never open the app. Making them
-- users means creating and disabling accounts for people who will never sign
-- in, and it puts hub staff into a table the permission system reads.
--
-- ══ WHY NOT FREE TEXT EITHER ═══════════════════════════════════════════════
--
-- The tempting shortcut is a text column on the job card. It costs nothing and
-- it destroys the one question worth asking of this data: which technicians
-- produce comebacks? "Amit", "amit", "Amit K" and "AMIT" are four people to a
-- GROUP BY, and warranty_claims joined to a name is a report nobody can trust.
--
-- So: a row per technician, scoped to a hub, with no login. A dropdown on the
-- job card, a real id underneath it, and `warranty_claims` joinable to it.
--
-- ══ NOT UNIQUE ON NAME ═════════════════════════════════════════════════════
--
-- Two mechanics called Amit at one hub is ordinary, and a unique index would
-- force somebody to type "Amit 2" in a field the customer might see on a
-- printed job card. employee_code exists for hubs that number their staff and
-- is unique WHERE PRESENT, which is the guarantee actually worth having.
--
-- ══ DELETING ═══════════════════════════════════════════════════════════════
--
-- ON DELETE RESTRICT is not used here because nothing references technicians
-- yet. Phase 3 adds job_card_technicians, and that reference must be RESTRICT
-- or SET NULL rather than CASCADE: deleting a technician who has left must
-- never delete the record of work they did. is_active is the ordinary way to
-- retire one.

BEGIN;

CREATE TABLE IF NOT EXISTS technicians (
  id             SERIAL PRIMARY KEY,
  hub_id         INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  mobile         TEXT,
  -- Free text on purpose: "AC", "Engine", "Denting & painting" — every hub
  -- names its trades differently, and a lookup table here would be master data
  -- about master data for a field used to pick a name from a short list.
  skill          TEXT,
  employee_code  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_technicians_hub ON technicians (hub_id, is_active);

-- Unique only where a code was given: hubs that do not number their staff are
-- not forced to invent codes, and hubs that do cannot reuse one by accident.
CREATE UNIQUE INDEX IF NOT EXISTS uq_technicians_code
  ON technicians (hub_id, employee_code)
  WHERE employee_code IS NOT NULL AND employee_code <> '';

COMMENT ON TABLE technicians IS
  'Hub floor staff who do the work. NOT Spinoto logins - a technician never signs in. Exists so a job card can carry a real id rather than a typed name, which is what makes "warranty claims per technician" answerable.';
COMMENT ON COLUMN technicians.employee_code IS
  'Optional. Unique within a hub where present. Names are deliberately NOT unique - two mechanics called Amit at one hub is ordinary.';

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM hubs;
  RAISE NOTICE '188: technicians ready. % hub(s) can now have staff added.', n;
END $$;

COMMIT;
