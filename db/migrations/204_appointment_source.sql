-- 204_appointment_source.sql
--
-- A REAL source on the appointment, and a real master-list link on both the
-- appointment and the lead.
--
-- ══ WHAT WAS WRONG ═════════════════════════════════════════════════════════
--
-- There were two different things both called "source" and neither answered
-- "where did this customer come from":
--
--   appointments.source_type   NOT a column. A CASE computed on every read,
--                              giving lead / direct / booking / warranty_redo.
--                              That is HOW THE ROW GOT MADE, not a channel. It
--                              stays exactly as it is — see APPT_SELECT — and
--                              this migration does not touch it.
--
--   leads.lead_source          The real channel, but free text VARCHAR(80) with
--                              no FK, on LEADS ONLY. A direct appointment, a
--                              warranty redo and a booking-site appointment had
--                              nowhere to record one at all.
--
-- So "how much revenue came from Google Ads" was unanswerable. Only "how many
-- LEADS came from Google Ads" was, and only for leads.
--
-- ══ FREE TEXT IS WHY THE REPORT CANNOT BE TRUSTED ══════════════════════════
--
-- leads.controller.js:278 names the values actually in the data, grouped by hand
-- because nothing enforced them:
--
--   whatsapp · website · meta ads · meta · facebook · instagram · facebook ads
--   instagram ads · social media · manual · walk-in · walk in · phone call
--   referral · (blank)
--
-- 'walk-in' and 'walk in' are one channel typed two ways. 'facebook',
-- 'instagram' and 'meta ads' are one channel typed five ways. Grouped in a chart
-- they are four real sources; stored as text they are nine rows.
--
-- ══ WHAT THIS DOES ═════════════════════════════════════════════════════════
--
--   1. Seeds the channels the master list was missing but the data already uses.
--   2. Adds leads.source_id and appointments.source_id → lead_sources(id).
--   3. Collapses the spelling variants onto one master row each, using the SAME
--      groupings leads.controller.js already applies to its chips, so the chips
--      and the new reports agree instead of disagreeing.
--   4. Gives anything unrecognised its own row, SWITCHED OFF — so no value is
--      lost and no report says "Unknown" for data that had a real answer, while
--      nobody can pick the typo from a dropdown ever again.
--   5. Backfills every appointment that came from a lead.
--
-- ══ WHAT THIS DELIBERATELY DOES NOT DO ═════════════════════════════════════
--
-- leads.lead_source IS KEPT, and is not dropped, emptied or renamed. Three
-- things still read it: the source chips on the leads list, the exact-source
-- dropdown, and the existing leads-by-source report. Removing it would break all
-- three on deploy. From here on the application writes BOTH — source_id as the
-- truth, lead_source as a copy the old readers keep working from — and migrating
-- those readers is a separate, later, provable change.
--
-- No NOT NULL on either column. Hundreds of existing rows have no source and
-- never will; a constraint that requires inventing one is a constraint that
-- turns missing data into wrong data.
--
-- ══ BEFORE YOU RUN THIS ════════════════════════════════════════════════════
--
-- Run source_dry_run.sql first. It is read-only and prints every value you have
-- against what section 3 below would do with it. Any row it reports as NO MATCH
-- gets its own switched-off row, which is safe but probably not what you want
-- for a value that is really just another spelling of Walk-in.

BEGIN;

-- ── 1. The channels the data uses that the master list never had ────────────
--
-- ACTIVE, because these are real channels somebody should be able to pick, not
-- typos. 'Manual' is included because leads.controller.js lists it as a stored
-- value; if your dry-run shows no lead actually holds it, the row is harmless
-- and can be switched off in Master Data.
INSERT INTO lead_sources (name, is_active, sort_order) VALUES
  ('WhatsApp', TRUE, 9),
  ('Meta Ads', TRUE, 10),
  ('Manual',   TRUE, 11)
ON CONFLICT (name) DO NOTHING;

-- ── 2. The columns ──────────────────────────────────────────────────────────
--
-- ON DELETE SET NULL, not CASCADE: deleting a source from Master Data must not
-- delete the appointments that came through it. Losing a job because somebody
-- tidied a dropdown is not a trade anybody would make.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES lead_sources(id) ON DELETE SET NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES lead_sources(id) ON DELETE SET NULL;

COMMENT ON COLUMN appointments.source_id IS
  'Where this customer came from, as a lead_sources row. Copied from the lead at '
  'conversion, asked for on a direct booking, inherited from the original job on '
  'a warranty redo, mapped from the payload on a booking-site appointment. NOT '
  'the same as source_type, which is derived and says how the row was created.';

COMMENT ON COLUMN leads.source_id IS
  'Where this lead came from, as a lead_sources row. The truth as of migration '
  '204. leads.lead_source is kept alongside it as a text copy, because the source '
  'chips, the exact-source filter and the leads-by-source report still read it.';

-- ── 3. THE SYNONYM MAP ──────────────────────────────────────────────────────
--
-- ═══ THIS IS THE ONE BLOCK TO CORRECT IF THE DRY-RUN SHOWS SOMETHING ═══
--
-- Left side: the value as stored, lower-cased and trimmed.
-- Right side: the master-list name it belongs to.
--
-- Built from leads.controller.js's own groupings (META_SOURCES, MANUAL_SOURCES
-- and the exact chips) plus the obvious spellings of each. A value not listed
-- here and not already a master name gets its own switched-off row in step 4 —
-- safe, visible, and easy to merge by hand afterwards.
CREATE TEMP TABLE src_alias (norm TEXT PRIMARY KEY, canonical TEXT NOT NULL) ON COMMIT DROP;

INSERT INTO src_alias (norm, canonical) VALUES
  ('walk-in','Walk-in'), ('walk in','Walk-in'), ('walkin','Walk-in'),
  ('walkin customer','Walk-in'), ('walk-in customer','Walk-in'),

  ('phone call','Phone Call'), ('phone','Phone Call'), ('call','Phone Call'),
  ('telephone','Phone Call'), ('inbound call','Phone Call'), ('incoming call','Phone Call'),

  ('website','Website'), ('web site','Website'), ('web','Website'),
  ('site','Website'), ('webform','Website'), ('web form','Website'),

  ('referral','Referral'), ('reference','Referral'), ('referred','Referral'),
  ('word of mouth','Referral'),

  ('whatsapp','WhatsApp'), ('whats app','WhatsApp'), ('whatsup','WhatsApp'), ('wa','WhatsApp'),

  -- One channel, five spellings. This is the group that most distorts a chart.
  ('meta ads','Meta Ads'), ('meta','Meta Ads'),
  ('facebook','Meta Ads'), ('facebook ads','Meta Ads'), ('fb','Meta Ads'), ('fb ads','Meta Ads'),
  ('instagram','Meta Ads'), ('instagram ads','Meta Ads'), ('ig','Meta Ads'), ('ig ads','Meta Ads'),

  -- Kept SEPARATE from Meta Ads on purpose. leads.controller.js folds
  -- 'social media' in with Meta for its chip, but the master list has had
  -- 'Social Media' as its own row since migration 041 and somebody may have
  -- picked it meaning organic rather than paid. Merging the two would silently
  -- rewrite that choice; they can be merged in Master Data later if you want.
  ('social media','Social Media'), ('social','Social Media'),

  ('google ads','Google Ads'), ('google','Google Ads'), ('adwords','Google Ads'),
  ('google adwords','Google Ads'), ('gads','Google Ads'), ('sem','Google Ads'), ('ppc','Google Ads'),

  ('exhibition','Exhibition'), ('expo','Exhibition'), ('event','Exhibition'),
  ('trade show','Exhibition'),

  ('manual','Manual'), ('manual entry','Manual'), ('staff','Manual'), ('advisor','Manual'),

  ('other','Other'), ('others','Other'), ('misc','Other')
ON CONFLICT (norm) DO NOTHING;

-- ── 4. Anything unrecognised keeps its name, switched off ───────────────────
--
-- The alternative was leaving source_id NULL for these, which reads in every
-- report as "no source" and is a lie: somebody typed something. A switched-off
-- row tells the truth and stays out of every dropdown.
--
-- DISTINCT ON the normalised form so 'Diwali Camp' and 'diwali camp' produce ONE
-- row rather than two, and the one kept is whichever spelling appears first.
INSERT INTO lead_sources (name, is_active, sort_order)
SELECT name, FALSE, 900
  FROM (
    SELECT DISTINCT ON (LOWER(TRIM(l.lead_source))) TRIM(l.lead_source) AS name
      FROM leads l
     WHERE COALESCE(TRIM(l.lead_source), '') <> ''
       AND NOT EXISTS (SELECT 1 FROM src_alias a WHERE a.norm = LOWER(TRIM(l.lead_source)))
       AND NOT EXISTS (SELECT 1 FROM lead_sources s
                        WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(l.lead_source)))
     ORDER BY LOWER(TRIM(l.lead_source)), TRIM(l.lead_source)
  ) unmatched
ON CONFLICT (name) DO NOTHING;

-- ── 5. Backfill the leads ───────────────────────────────────────────────────
--
-- Two passes, because a value reaches a master row two different ways and
-- writing it as one statement would need a CASE nobody could check against the
-- comment above.
--
-- Guarded on source_id IS NULL so a re-run, or a value somebody has since fixed
-- by hand, is left alone.

-- 5a. Through the synonym map.
UPDATE leads l
   SET source_id = s.id
  FROM src_alias a
  JOIN lead_sources s ON LOWER(TRIM(s.name)) = LOWER(TRIM(a.canonical))
 WHERE l.source_id IS NULL
   AND a.norm = LOWER(TRIM(COALESCE(l.lead_source, '')));

-- 5b. Directly by name — catches the switched-off rows step 4 just created, and
--     any master row whose name the map does not mention.
UPDATE leads l
   SET source_id = s.id
  FROM lead_sources s
 WHERE l.source_id IS NULL
   AND COALESCE(TRIM(l.lead_source), '') <> ''
   AND LOWER(TRIM(s.name)) = LOWER(TRIM(l.lead_source));

-- ── 6. Backfill the appointments that came from a lead ──────────────────────
--
-- COPIED, not joined. A report that joined through lead_id would show whatever
-- the lead's source says TODAY, so editing one lead would move last quarter's
-- numbers. The appointment records what the source WAS when the job was booked.
UPDATE appointments a
   SET source_id = l.source_id
  FROM leads l
 WHERE a.lead_id = l.id
   AND a.source_id IS NULL
   AND l.source_id IS NOT NULL;

-- ── 7. Indexes for the three new reports ────────────────────────────────────
--
-- Every one of them groups by source over a date range, which is an index scan
-- on these two or a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_appointments_source_id ON appointments (source_id);
CREATE INDEX IF NOT EXISTS idx_leads_source_id        ON leads (source_id);

-- ── 8. Say exactly what happened ────────────────────────────────────────────
--
-- A migration that quietly rewrites how every channel is counted is a migration
-- nobody can audit afterwards. These go into the deploy log.
DO $$
DECLARE
  n_leads_total  INT;
  n_leads_set    INT;
  n_leads_blank  INT;
  n_appt_total   INT;
  n_appt_set     INT;
  n_new_off      INT;
  r              RECORD;
BEGIN
  SELECT COUNT(*), COUNT(source_id), COUNT(*) FILTER (WHERE COALESCE(TRIM(lead_source),'') = '')
    INTO n_leads_total, n_leads_set, n_leads_blank FROM leads;
  SELECT COUNT(*), COUNT(source_id) INTO n_appt_total, n_appt_set FROM appointments;
  SELECT COUNT(*) INTO n_new_off FROM lead_sources WHERE is_active = FALSE AND sort_order = 900;

  RAISE NOTICE '[204] leads: % total, % now linked to a source, % never had one.',
    n_leads_total, n_leads_set, n_leads_blank;
  RAISE NOTICE '[204] appointments: % total, % inherited a source from their lead.',
    n_appt_total, n_appt_set;
  RAISE NOTICE '[204] % unrecognised value(s) got their own switched-off row. Merge them in Master Data if any is just another spelling.',
    n_new_off;

  /* A lead with text in lead_source and still no source_id should be
     impossible after 5a and 5b. If any exist, the backfill has a hole and the
     deploy log has to say so rather than leaving it to be noticed in a chart. */
  SELECT COUNT(*) INTO n_leads_set
    FROM leads WHERE COALESCE(TRIM(lead_source),'') <> '' AND source_id IS NULL;
  IF n_leads_set > 0 THEN
    RAISE WARNING '[204] % lead(s) have a source written down and did not get linked. This should be zero — please report it.', n_leads_set;
    FOR r IN SELECT DISTINCT lead_source FROM leads
              WHERE COALESCE(TRIM(lead_source),'') <> '' AND source_id IS NULL LIMIT 10
    LOOP
      RAISE WARNING '[204]   unlinked value: %', r.lead_source;
    END LOOP;
  END IF;
END $$;

COMMIT;
