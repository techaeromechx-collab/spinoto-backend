-- 173_competitor_retargeting.sql
--
-- A lead lost to a competitor is a lead with a date on it.
--
-- ══ THE IDEA ═══════════════════════════════════════════════════════════════
--
-- "Competitor Service" does not mean the customer is gone. It means somebody
-- else serviced the car on a known day, and the car will need servicing again
-- roughly three months later. That is not a lost lead, it is a lead with a
-- date on it — and today it sits in Lost, locked, closed, and nobody ever
-- looks at the Lost list.
--
-- So: capture WHO took the job and WHEN they did it, and three months after
-- that day move the lead to Retargeting by itself and put it in front of
-- somebody.
--
-- ══ FOUR DECISIONS WORTH THE WORDS ═════════════════════════════════════════
--
-- 1. THE INTERVAL LIVES ON THE REASON, NOT IN CODE.
--    retarget_after_months is a column on lost_reasons. Three months is what
--    the workshop asked for today; it is a number in a settings screen
--    tomorrow, and a different number per reason the day somebody decides
--    "Price Too High" is worth another call after six.
--
-- 2. THE DESTINATION IS A FLAG, NOT THE STRING 'Retargeting'.
--    leads.status stores the NAME (013). Code holding 'Retargeting' breaks the
--    moment somebody renames it on the Master Data screen — silently, because
--    the sweep would simply stop matching and raise nothing. Same partial
--    unique index over a constant that 161 uses for is_reenquiry: exactly one
--    status may be the destination, and the database refuses a second.
--
-- 3. THE DUE DATE IS STAMPED, NOT COMPUTED.
--    retarget_due_date is written on the lead when it is marked Lost, rather
--    than derived from competitor_service_date + the reason's interval at read
--    time. If it were derived, an admin editing "3" to "6" next March would
--    silently move the due date of every lead already waiting — including ones
--    due tomorrow. The number they change should govern leads marked from then
--    on, not rewrite history.
--
-- 4. THE COMPETITOR AND THE INTERVAL ARE SEPARATE FLAGS.
--    requires_competitor makes the popup ask who and when.
--    retarget_after_months makes the sweep pick it up later.
--    A reason can want either without the other: "Price Too High" might earn a
--    six-month retarget with nobody to name, and a competitor might be worth
--    recording for a reason you never chase. One flag doing both would force
--    them together for no reason beyond convenience.

BEGIN;

-- ══ 1. WHO WE LOSE TO ══════════════════════════════════════════════════════
--
-- A master list rather than free text on the lead, because the question this
-- data exists to answer is "who takes our work, and how much of it" — and free
-- text answers that with 'AutoZone', 'autozone', 'Auto Zone' and 'AZ' as four
-- competitors.
--
-- Nothing is seeded. Unlike lost reasons there is no defensible default list:
-- these are the workshops on your road, and only you know their names.
CREATE TABLE IF NOT EXISTS competitors (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  notes      TEXT,
  sort_order INT     NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT competitors_name_unique UNIQUE (name)
);

COMMENT ON TABLE competitors IS
  'Workshops we lose jobs to. Referenced BY ID from leads.lost_competitor_id - unlike lost_reasons and lead_statuses, so renaming one needs no cascade.';

-- ══ 2. WHAT A REASON DOES AFTERWARDS ═══════════════════════════════════════
ALTER TABLE lost_reasons
  ADD COLUMN IF NOT EXISTS requires_competitor   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retarget_after_months INTEGER;

COMMENT ON COLUMN lost_reasons.requires_competitor IS
  'Picking this reason also asks which competitor took the job and the date they did it. Both are then required to save.';

COMMENT ON COLUMN lost_reasons.retarget_after_months IS
  'NULL = this lead is never chased again. A number = the sweep moves the lead to the is_retarget_target status that many months after the competitor service date, or after the date it was marked lost when no service date was captured.';

-- NULL means "never chase" and that is the default for everything, including
-- the five reasons 172 seeded. Only the competitor one opts in, because only
-- it describes a customer who still needs the work doing.
UPDATE lost_reasons
   SET requires_competitor = TRUE, retarget_after_months = 3
 WHERE name = 'Competitor Service';

-- ══ 3. WHERE THEY LAND ═════════════════════════════════════════════════════
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS is_retarget_target BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lead_statuses.is_retarget_target IS
  'The status a lead is moved to when its retarget date arrives. At most one may hold it. Nothing happens until one does - the sweep logs that it has nowhere to move leads to, and moves none.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_statuses_retarget_target
  ON lead_statuses ((TRUE)) WHERE is_retarget_target;

COMMENT ON INDEX idx_lead_statuses_retarget_target IS
  'Exactly one retarget destination. Two admins ticking two statuses get one winner and one error, rather than a rule that picks whichever row the planner returned first.';

-- Seeded onto Retargeting, which 169 kept for exactly this kind of work.
-- Guarded on the name so an install that renamed it is left to tick its own.
UPDATE lead_statuses SET is_retarget_target = TRUE
 WHERE name = 'Retargeting'
   AND NOT EXISTS (SELECT 1 FROM lead_statuses WHERE is_retarget_target);

-- ══ 4. WHAT THE LEAD CARRIES ═══════════════════════════════════════════════
--
-- By ID for the competitor (a real key, so a rename is free) and by date for
-- the rest. retarget_due_date is the only one the sweep reads — the other two
-- are what a human needs to see to make the call worth making.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lost_competitor_id      INTEGER REFERENCES competitors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS competitor_service_date DATE,
  ADD COLUMN IF NOT EXISTS retarget_due_date       DATE;

COMMENT ON COLUMN leads.retarget_due_date IS
  'Stamped when the lead is marked lost on a reason with retarget_after_months. The sweep moves the lead on this date and clears it. NULL means this lead is not waiting to be retargeted.';

-- The sweep asks one question once a day: which leads are due. Partial, because
-- the answer is a handful of rows out of the whole table and a full index would
-- be paying to store the NULLs that make up all of it.
CREATE INDEX IF NOT EXISTS idx_leads_retarget_due
  ON leads (retarget_due_date) WHERE retarget_due_date IS NOT NULL;

-- ══ 5. TELLING THE TWO KINDS OF FOLLOW-UP APART ════════════════════════════
--
-- The retarget lands as a lead_events row, because that table already IS the
-- "somebody must do something about this lead on this date" mechanism — the
-- Follow-up drawer, the Today/Overdue filters and the compliance report are all
-- built on it, and none of them need changing to show a retarget.
--
-- But the two are not the same thing to a human. A follow-up is a promise
-- somebody made on a call; a retarget is the system saying this car is due.
-- One column separates them, and it is what drives the retarget row treatment
-- on the leads list and the retarget count on the drawer.
--
-- DEFAULT 'manual' backfills every existing row correctly: they were all
-- scheduled by a person.
ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  ALTER TABLE lead_events ADD CONSTRAINT lead_events_kind_check
    CHECK (kind IN ('manual', 'retarget'));
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- re-run
END $$;

COMMENT ON COLUMN lead_events.kind IS
  'manual = a person promised to call on this date. retarget = the system worked out the car is due. Both live in the Follow-up drawer; only the second gets the retarget treatment on the leads list.';

CREATE INDEX IF NOT EXISTS idx_lead_events_retarget_open
  ON lead_events (lead_id) WHERE kind = 'retarget' AND is_done = FALSE;

-- ══ 6. VERIFY ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_target INTEGER;
  n_reason INTEGER;
BEGIN
  -- At most one, enforced by the index above; this catches ZERO, which the
  -- index cannot. Zero is legal and the sweep handles it, but it means the
  -- feature is inert and somebody should know that now rather than in March.
  SELECT COUNT(*) INTO n_target FROM lead_statuses WHERE is_retarget_target AND is_active;
  IF n_target = 0 THEN
    RAISE WARNING '173: no active status is the retarget destination - leads will accumulate '
                  'a retarget_due_date and never move. Tick one in Settings -> Master Data -> Lead Status.';
  END IF;

  SELECT COUNT(*) INTO n_reason FROM lost_reasons WHERE retarget_after_months IS NOT NULL;
  RAISE NOTICE '173: % reason(s) retarget, % destination status', n_reason, n_target;
END $$;

COMMIT;

-- ══ NOT DONE HERE, DELIBERATELY ════════════════════════════════════════════
--
-- 1. NO BACKFILL OF retarget_due_date ONTO EXISTING LOST LEADS.
--    169 wrote 'Competitor Service' onto every lead that used to be Not
--    Interested — a guess made from a status name, with no service date behind
--    it and no competitor. Stamping a due date on those would schedule a call
--    about a service that may never have happened, on a date derived from
--    nothing. They stay where they are.
--
-- 2. NO SLUG ON lost_reasons.
--    Same gap lead_statuses has, same reason it is survivable: the controller
--    cascades the rename. Worth fixing for both at once, not here.
