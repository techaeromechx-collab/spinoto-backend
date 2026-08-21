-- 169_lead_status_rebuild.sql
--
-- The Tele-Sales SOP pipeline: 20 lead statuses become 10.
--
-- ══ WHY THIS IS A MIGRATION AND NOT A SETTINGS SCREEN ═══════════════════════
--
-- Every one of these steps is available on Settings → Master Data → Lead
-- Status, and doing it there would take an afternoon and half of it would be
-- wrong. Three reasons this belongs in one transaction:
--
--   1. A STATUS CANNOT BE DELETED WHILE LEADS ARE ON IT. The screen refuses,
--      correctly. So eleven statuses have to be emptied first — and "empty
--      them" means moving live leads, which nobody should do by hand across a
--      bulk-change screen capped at 500 rows a time.
--
--   2. RENAME AND DELETE ARE NOT THE SAME OPERATION. Renaming cascades: it
--      rewrites leads.status, both sides of the activity timeline, the
--      follow-up captions and the WhatsApp automations. Delete-and-recreate
--      does none of that, and the difference is invisible until a report
--      groups on a name that half the rows no longer carry. Six statuses here
--      MUST be renamed and are.
--
--   3. HALF-APPLIED IS WORSE THAN NOT APPLIED. A run that renames six statuses
--      and then fails before ticking converts_to_appointment leaves a CRM
--      where booking an appointment sets no status at all. One transaction,
--      one verification block, all or nothing.
--
-- ══ WHAT THE STATUS NAMES ARE, AND ARE NOT ══════════════════════════════════
--
-- leads.status stores the NAME as text (migration 013 turned the enum into
-- VARCHAR(100)). The name is therefore data, not a key, and this file is
-- careful never to leave a lead carrying a name that no longer exists in
-- lead_statuses — a lead in that state renders as a grey unlabelled badge,
-- drops out of the dashboard, and is invisible to every filter.

BEGIN;

-- ══ 0. RE-RUNNING IS SAFE, AND NOT BECAUSE OF A GUARD ══════════════════════
--
-- There is deliberately no "if already applied, stop" block at the top. RETURN
-- inside a DO block exits the DO block, not the transaction — everything below
-- would run anyway. A guard that reads as a guard and is not one is worse than
-- none, because the next person trusts it.
--
-- Instead every step is written to be a no-op the second time: the renames are
-- keyed on the OLD name, the insert is ON CONFLICT DO NOTHING, the moves are
-- keyed on statuses that no longer exist, the flags are assignments rather than
-- toggles, and the delete has nothing left to delete. A second run changes
-- nothing and still verifies.

-- ══ 1. RENAME THE SIX ══════════════════════════════════════════════════════
--
-- Same row, new label. Every flag stays ticked because the row never moves,
-- and every reference is carried below.
--
-- Guarded with a WHERE on the old name so a re-run is a no-op rather than an
-- error, and so a name somebody has already changed by hand is left alone.
UPDATE lead_statuses SET name = 'Call Unanswered - Attempt 1' WHERE name = 'Call No Ans. (Day 1)';
UPDATE lead_statuses SET name = 'Call Unanswered - Attempt 2' WHERE name = 'Call No Ans. (Day 2)';
UPDATE lead_statuses SET name = 'Call Unanswered - Attempt 3' WHERE name = 'Call No Ans. (Day 3)';
UPDATE lead_statuses SET name = 'Follow-Up - General'         WHERE name = 'Follow-Up';
UPDATE lead_statuses SET name = 'Appointment Booked'          WHERE name = 'Appointment Scheduled';

-- ── Carry every reference with them ────────────────────────────────────────
--
-- This is what the rename endpoint does one status at a time, done here for
-- all five at once. A temp table rather than five copies of four statements:
-- the pairs are the data, and the four rewrites are the operation.
CREATE TEMP TABLE renames (old TEXT, new TEXT) ON COMMIT DROP;
INSERT INTO renames VALUES
  ('Call No Ans. (Day 1)',  'Call Unanswered - Attempt 1'),
  ('Call No Ans. (Day 2)',  'Call Unanswered - Attempt 2'),
  ('Call No Ans. (Day 3)',  'Call Unanswered - Attempt 3'),
  ('Follow-Up',             'Follow-Up - General'),
  ('Appointment Scheduled', 'Appointment Booked');

-- The leads themselves.
UPDATE leads l SET status = r.new, updated_at = NOW()
  FROM renames r WHERE l.status = r.old;

-- The timeline, both sides.
--
-- Scoped by `type`, and that is not optional: lead_activities.new_value holds a
-- SERVICE name on service_added rows and a USER's name on assigned_changed
-- rows. An unscoped rewrite would quietly edit somebody's assignment history if
-- a status ever shared their name.
UPDATE lead_activities a SET new_value = r.new
  FROM renames r WHERE a.new_value = r.old AND a.type IN ('status_changed', 'created');
UPDATE lead_activities a SET old_value = r.new
  FROM renames r WHERE a.old_value = r.old AND a.type = 'status_changed';

-- Follow-up captions. Cosmetic — follow-ups are found by lead_id — but a
-- follow-up card captioned with a status that no longer exists is the kind of
-- small wrongness nobody reports and everybody notices.
UPDATE lead_events e SET status_name = r.new
  FROM renames r WHERE e.status_name = r.old;

-- WhatsApp automations. NOT cosmetic.
--
-- match_value holds the status name, compared exact-string when the event
-- fires. Left on the old spelling, every rule pointing at these five stops
-- matching — while staying switched ON, raising nothing and logging nothing.
-- The first sign would be a customer who did not get the message they always
-- got.
--
-- Scoped to lead events: appointment automations store a SLUG in this same
-- column, and an unscoped rewrite would repoint them at nothing.
UPDATE wa_automations w SET match_value = r.new
  FROM renames r WHERE w.match_value = r.old AND w.event LIKE 'lead.%';

-- ══ 2. THE ONE NEW STATUS ══════════════════════════════════════════════════
--
-- Follow-Up - Details Sent: the customer asked for the workshop location or a
-- service package and it has been sent. The SOP requires a callback within two
-- hours, so needs_follow_up is not a nicety here — without it the status can be
-- set and nobody is ever asked when to chase.
INSERT INTO lead_statuses
  (name, color, bg_color, sort_order, is_active, needs_follow_up, is_pipeline)
VALUES
  ('Follow-Up - Details Sent', '#0f766e', '#ccfbf1', 5, TRUE, TRUE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ══ 3. MOVE THE LEADS OFF THE ELEVEN ═══════════════════════════════════════
--
-- Destinations agreed with the workshop, not inferred here. The two that
-- deserve a note:
--
--   Appointment Completed / Cancelled → Appointment Booked. Completion and
--   cancellation are facts about the APPOINTMENT and live on that record. The
--   lead's job ended when the booking was made.
--
--   No Show → Follow-Up - General. They did not turn up, so somebody has to
--   ring them. That is a general follow-up, not a retarget.
CREATE TEMP TABLE moves (old TEXT, new TEXT, reason TEXT) ON COMMIT DROP;
INSERT INTO moves VALUES
  ('Appointment Completed',  'Appointment Booked',       NULL),
  ('Appointment Cancelled',  'Appointment Booked',       NULL),
  ('Awaiting For Quotation', 'Follow-Up - Details Sent', NULL),
  ('Quotation Shared',       'Follow-Up - Details Sent', NULL),
  ('Future Lead',            'Retargeting',              NULL),
  -- Appointment No Show exists on production and not on local. Same
  -- destination as the old No Show ladder: they booked, they did not turn up,
  -- somebody has to ring them.
  ('Appointment No Show',    'Follow-Up - General',      NULL),
  ('No Show (Day 1)',        'Follow-Up - General',      NULL),
  ('No Show (Day 2)',        'Follow-Up - General',      NULL),
  ('No Show (Day 3)',        'Follow-Up - General',      NULL),
  -- ── The three that become Lost ──────────────────────────────────────────
  --
  -- The SOP's Lost Reason list exists because the difference between these
  -- three is the difference between a bad number, a wrong catchment area and a
  -- competitor — which is what the marketing spend is tuned on.
  --
  -- The Lost reason prompt was removed from the UI earlier, so nothing will
  -- ask again. Writing the reason HERE is the last chance to keep what is
  -- already known, and it costs one column.
  ('Junk',                'Lost', 'Junk/Fake Number'),
  ('Not Interested',      'Lost', 'Competitor Service'),
  ('Out of Service Area', 'Lost', 'Out of Service Area');

-- The leads. lost_reason is only written where one is defined and the lead has
-- none already — an existing reason is a person's own words and outranks
-- anything inferred from a status name.
UPDATE leads l
   SET status      = m.new,
       lost_reason = COALESCE(NULLIF(TRIM(l.lost_reason), ''), m.reason),
       updated_at  = NOW()
  FROM moves m
 WHERE l.status = m.old;

-- Their follow-ups keep working — nothing here closes one, because the
-- auto-close lives in the API rather than in a trigger. But the caption stored
-- on each follow-up still names the old status, and the Leads page prints it.
-- Left alone, those cards would read "Status: No Show (Day 2)" forever.
UPDATE lead_events e SET status_name = m.new
  FROM moves m WHERE e.status_name = m.old;

-- The timeline is NOT rewritten for these.
--
-- A rename means "this status was always called that". A move means "this lead
-- used to be Junk and is now Lost", and that is true and worth keeping. The
-- history rows naming a status that no longer exists are correct history.

-- ══ 3b. THE "New Lead" SENTINEL ════════════════════════════════════════════
--
-- status = NULL means New Lead. There is no 'New Lead' row in lead_statuses and
-- there never has been — leads.controller says so in its own comment, and
-- waInboundLead.service writes NULL rather than a string for exactly this
-- reason.
--
-- But leads exist carrying the literal text. They arrive from an import whose
-- spreadsheet had the label typed in, or from a hand-written UPDATE. A lead in
-- that state is not merely untidy: its status matches no row, so it renders as
-- a grey unlabelled badge, drops out of the dashboard, and cannot be found by
-- any status filter. It is invisible rather than wrong.
--
-- Normalised here because this migration is the thing that noticed, and because
-- leaving it would mean the verification below fails on a fault that predates
-- this change by months. Case-insensitive and trimmed: 'New Lead', 'new lead'
-- and ' New ' are all the same mistake.
--
-- Guarded on the name not existing, so an install that later creates a real
-- status called 'New Lead' is left entirely alone.
UPDATE leads
   SET status = NULL, updated_at = NOW()
 WHERE status IS NOT NULL
   AND LOWER(TRIM(status)) IN ('new lead', 'new', 'new/not attempted', 'new / not attempted')
   AND NOT EXISTS (SELECT 1 FROM lead_statuses s WHERE s.name = leads.status);

-- ══ 4. FLAGS ═══════════════════════════════════════════════════════════════
--
-- Set explicitly on all ten rather than trusted from before, because the whole
-- pipeline's behaviour is these ticks and half of them were never reviewed.
UPDATE lead_statuses SET
  needs_follow_up         = (name IN ('Call Unanswered - Attempt 1',
                                      'Call Unanswered - Attempt 2',
                                      'Call Unanswered - Attempt 3',
                                      'Follow-Up - General',
                                      'Follow-Up - Details Sent',
                                      'Retargeting')),
  logs_call               = (name IN ('Call Unanswered - Attempt 1',
                                      'Call Unanswered - Attempt 2',
                                      'Call Unanswered - Attempt 3',
                                      'Lost')),
  converts_to_appointment = (name = 'Appointment Booked'),
  is_locked               = (name = 'Lost'),
  is_closed               = (name = 'Lost')
WHERE name IN ('Call Unanswered - Attempt 1', 'Call Unanswered - Attempt 2',
               'Call Unanswered - Attempt 3', 'Follow-Up - General',
               'Follow-Up - Details Sent', 'Retargeting', 'Lost',
               'Appointment Booked', 'Re-Enquiry', 'Repeat Customer');

-- ── is_pipeline is NOT touched, and that is a decision ─────────────────────
--
-- It controls dashboard membership and the duplicate-lead check. The current
-- ticks look uncurated — Junk and Not Interested count as live pipeline while
-- the three call attempts do not, which is backwards on both counts — but
-- correcting it would move the numbers on somebody's dashboard as a side effect
-- of a rename they asked for. Two changes, two decisions, two conversations.
--
-- What this migration does change, unavoidably: leads merging into Lost inherit
-- Lost's setting, so Junk / Not Interested / Out of Service Area leads leave the
-- pipeline count. That is a consequence of the merge, not a new rule.
--
-- The new status is created with is_pipeline TRUE in step 2 — a lead waiting on
-- details it has been sent is as live as a lead waiting on a callback.

-- is_reenquiry / is_repeat_customer are NOT touched. Each is guarded by a
-- partial unique index allowing exactly one holder, they are already on the
-- right rows, and rewriting them here would risk a constraint violation for no
-- gain.

-- ── The default status ─────────────────────────────────────────────────────
--
-- Where a lead lands when the system must move it and nobody chose: deleting an
-- appointment un-converts its lead, and that lead has to go somewhere.
--
-- Only set if nothing valid holds it — either nothing ever did, or the holder
-- is one of the eleven about to be deleted. An existing default on a surviving
-- status is somebody's decision and is left alone.
UPDATE lead_statuses SET is_default = TRUE
 WHERE name = 'Follow-Up - General'
   AND NOT EXISTS (
     SELECT 1 FROM lead_statuses d
      WHERE d.is_default AND d.is_active
        AND d.name NOT IN (SELECT old FROM moves));

-- And clear it off anything being deleted, or the delete below fails on a
-- constraint nobody expected.
UPDATE lead_statuses SET is_default = FALSE WHERE name IN (SELECT old FROM moves);

-- ══ 5. DELETE THE ELEVEN ═══════════════════════════════════════════════════
--
-- Safe now: step 3 emptied them. The verification block below proves it rather
-- than assuming it.
DELETE FROM lead_statuses WHERE name IN (SELECT old FROM moves);

-- ══ 6. VERIFY, OR ABORT ════════════════════════════════════════════════════
--
-- Every check here describes a way the CRM is broken if it fails, and each one
-- is silent in production — which is the whole reason to spend the query.
DO $$
DECLARE
  stranded  INTEGER;
  sample    TEXT;
  n_convert INTEGER;
  n_default INTEGER;
  n_total   INTEGER;
  missing   TEXT;
  extra     TEXT;
  -- The ten the SOP defines. Every one carries behaviour, so all ten must exist.
  required  TEXT[] := ARRAY[
    'Call Unanswered - Attempt 1', 'Call Unanswered - Attempt 2',
    'Call Unanswered - Attempt 3', 'Follow-Up - General',
    'Follow-Up - Details Sent',    'Retargeting',
    'Lost',                        'Appointment Booked',
    'Re-Enquiry',                  'Repeat Customer'];
  -- Plus anything deliberately kept outside the SOP pipeline.
  allowed   TEXT[] := required || ARRAY['Concern Solved'];
BEGIN
  -- 6a. No lead may carry a status name that does not exist. Such a lead has a
  --     grey unlabelled badge, is missing from the dashboard, and cannot be
  --     found by any filter — it is invisible rather than wrong, which is worse.
  SELECT COUNT(*), string_agg(DISTINCT l.status, ', ' ORDER BY l.status)
    INTO stranded, sample
    FROM leads l
   WHERE l.status IS NOT NULL
     AND TRIM(l.status) <> ''
     AND NOT EXISTS (SELECT 1 FROM lead_statuses s WHERE s.name = l.status);
  IF stranded > 0 THEN
    -- Every distinct offending name, not a sample. A migration that aborts is
    -- already costing somebody their afternoon; making them re-run it once per
    -- unknown status is the difference between one fix and five.
    RAISE EXCEPTION '169: % lead(s) left on a status that does not exist: %',
      stranded, sample;
  END IF;

  -- 6b. Exactly one status converts to an appointment. None and booking sets no
  --     status at all; two and which one wins depends on the query planner.
  SELECT COUNT(*) INTO n_convert FROM lead_statuses WHERE converts_to_appointment AND is_active;
  IF n_convert <> 1 THEN
    RAISE EXCEPTION '169: % active status(es) convert to an appointment, expected exactly 1', n_convert;
  END IF;

  -- 6c. Exactly one default. None and deleting an appointment strands its lead.
  SELECT COUNT(*) INTO n_default FROM lead_statuses WHERE is_default AND is_active;
  IF n_default <> 1 THEN
    RAISE EXCEPTION '169: % active default status(es), expected exactly 1', n_default;
  END IF;

  -- 6d. Lost must be closed. is_closed is what stops a customer's next WhatsApp
  --     message being filed onto a dead lead instead of starting a fresh one —
  --     the exact failure migration 156 was written to prevent.
  IF NOT EXISTS (SELECT 1 FROM lead_statuses WHERE name = 'Lost' AND is_closed AND is_locked) THEN
    RAISE EXCEPTION '169: Lost is not both closed and locked';
  END IF;

  /* 6e. The pipeline is the agreed set, and nothing else.

     Asked as two questions rather than one count, and that is not fussiness:
     the two databases this runs on have DRIFTED. Production carries a 'Concern
     Solved' status that local does not, and local still carries statuses
     production deleted months ago. Any hardcoded total is wrong on one of them
     whichever number is picked, and the failure would read as a bug in the
     migration rather than as the difference it actually is.

       MISSING — one of the ten the SOP defines is not there. Every one of them
                 has behaviour hanging off it, so a missing one is a broken CRM.

       EXTRA   — something survived that nobody agreed to keep. Refused rather
                 than deleted: an unrecognised status is somebody's decision
                 this migration has not been told about, and quietly removing
                 it would take their leads with it.

     'Concern Solved' is on the keep list BY DECISION. It is not part of the
     SOP pipeline and it is deliberately not deleted. */
  SELECT string_agg(r, ', ') INTO missing
    FROM unnest(required) AS r
   WHERE NOT EXISTS (SELECT 1 FROM lead_statuses s WHERE s.name = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '169: the pipeline is missing: %', missing;
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO extra
    FROM lead_statuses WHERE NOT (name = ANY(allowed));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION '169: unexpected status(es) still present: % — decide where their '
                    'leads go and add them to the move list, or add them to the keep list',
      extra;
  END IF;

  SELECT COUNT(*) INTO n_total FROM lead_statuses;

  RAISE NOTICE '169: pipeline rebuilt — % statuses, % converting, % default',
    n_total, n_convert, n_default;
END $$;

-- ══ 7. THE ORDER THEY APPEAR IN ════════════════════════════════════════════
--
-- The SOP's sequence, so the dropdown reads like the process.
UPDATE lead_statuses SET sort_order = v.ord FROM (VALUES
  ('Call Unanswered - Attempt 1', 1),
  ('Call Unanswered - Attempt 2', 2),
  ('Call Unanswered - Attempt 3', 3),
  ('Follow-Up - General',         4),
  ('Follow-Up - Details Sent',    5),
  ('Retargeting',                 6),
  ('Lost',                        7),
  ('Appointment Booked',          8),
  ('Re-Enquiry',                  9),
  ('Repeat Customer',            10)
) AS v(name, ord) WHERE lead_statuses.name = v.name;

COMMIT;

-- ══ NOT DONE HERE, DELIBERATELY ════════════════════════════════════════════
--
-- 1. NO SLUG ON lead_statuses.
--    appointment_statuses has one, which is why appointment automations
--    survive a rename and lead ones have to be cascaded. Giving lead_statuses
--    a slug is the structurally correct fix — and it is a backfill, a change to
--    how automations match, and a change to the settings UI. Worth doing. Not
--    worth bundling into the migration that changes the pipeline.
--
-- 2. NO AUTO-MOVE FROM ATTEMPT 3 TO RETARGETING.
--    The SOP says the third failed dial auto-moves the lead. Nothing in the CRM
--    does that today, and it is not a schema change — it is a scheduled sweep,
--    or a rule on the third follow-up going overdue. Its own job.
--
-- 3. NOTHING WAS DONE ABOUT NEW Lost LEADS HAVING NO REASON.
--    The three collapsing statuses keep their reason because this file writes
--    it. From tomorrow a lead set to Lost carries none, because the prompt was
--    removed from the UI. That is a product decision, already taken, and this
--    migration is not the place to quietly reverse it.
