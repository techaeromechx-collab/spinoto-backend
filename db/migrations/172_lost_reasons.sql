-- 172_lost_reasons.sql
--
-- Lost gets its reason back — as master data this time.
--
-- ══ WHY THIS IS COMING BACK ════════════════════════════════════════════════
--
-- LOST_REASONS was a hardcoded array in LeadsPage.jsx and LostReasonModal was
-- the dialog that showed it. Both were deleted, for a reason still written at
-- the top of that file: being stopped by a dialog on the status you set most
-- often, most often in batches, cost more than the reason was worth.
--
-- That judgement was about the DIALOG, not about the reason. Migration 169
-- then had to write lost_reason by hand for the three statuses it collapsed
-- (Junk, Not Interested, Out of Service Area) precisely because the difference
-- between a bad number, a wrong catchment area and a competitor is what the
-- marketing spend is tuned on — and there was no longer any way to record it.
--
-- So the reason returns, but as a list an admin owns rather than an array a
-- developer owns, and behind a per-status flag rather than a name match.
--
-- ══ WHY A FLAG AND NOT `name ILIKE '%lost%'` ═══════════════════════════════
--
-- Three places in LeadsPage.jsx currently decide whether to show a lost reason
-- with `status.toLowerCase().includes('lost')`, and the edit form uses the same
-- test to decide whether to NULL the column on save. Rename Lost — which the
-- Master Data screen invites you to do — and all four change behaviour at once,
-- silently, and the fourth one starts erasing data.
--
-- Same lesson as is_closed (156) and is_reenquiry (161): the flag lives on the
-- ROW, so the tick travels with any rename.

BEGIN;

-- ══ 1. THE MASTER LIST ═════════════════════════════════════════════════════
--
-- Shaped exactly like call_outcomes (071), which is the working precedent for
-- "a short admin-owned list that a popup offers as chips". Same columns, same
-- unique-on-name, so the controller and the settings panel are a clone rather
-- than a new design.
CREATE TABLE IF NOT EXISTS lost_reasons (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  sort_order INT     NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lost_reasons_name_unique UNIQUE (name)
);

COMMENT ON TABLE lost_reasons IS
  'Reasons offered when a lead is set to a status with needs_lost_reason. Written to leads.lost_reason BY NAME, so renaming one must cascade - see lost_reasons.controller.js.';

-- ── The seed ────────────────────────────────────────────────────────────────
--
-- The first three are not a guess. Migration 169 wrote exactly these strings
-- onto real leads when it collapsed Junk, Not Interested and Out of Service
-- Area into Lost. Seeding them means those leads' reasons match a master row
-- instead of being orphaned text that the settings screen cannot account for.
--
-- The rest are the Tele-Sales SOP's list. All of them are editable on
-- Settings -> Master Data -> Lost Reasons, which is the entire point.
INSERT INTO lost_reasons (name, sort_order, is_active) VALUES
  ('Competitor Service',           1, TRUE),
  ('Out of Service Area',          2, TRUE),
  ('Junk/Fake Number',             3, TRUE),
  ('Price Too High',               4, TRUE),
  ('Wrong Number',                 5, TRUE),
  ('No Response After 3 Attempts', 6, TRUE)
ON CONFLICT (name) DO NOTHING;

-- The settings panel prints a lead count beside every reason, on every load.
-- Partial because a NULL lost_reason is the overwhelming majority of the table
-- and indexing it would be paying for rows nothing ever asks about.
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason
  ON leads (lost_reason) WHERE lost_reason IS NOT NULL;

-- ══ 2. THE FLAG ════════════════════════════════════════════════════════════
--
-- DEFAULT FALSE for the reason 156 chose it: a status nobody has classified
-- behaves exactly as it does today, and a status created next year asks for
-- nothing until somebody decides it should.
ALTER TABLE lead_statuses
  ADD COLUMN IF NOT EXISTS needs_lost_reason BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lead_statuses.needs_lost_reason IS
  'Setting a lead to this status opens the reason picker, and the API refuses the transition without one (422 LOST_REASON_REQUIRED). Unlike the old modal this is per-status, so it survives a rename.';

-- Seeded by exact name, and only where the row exists. Guarded rather than
-- asserted: an install that renamed Lost has made a decision, and this
-- migration is not the place to overrule it — the checkbox is on the screen.
UPDATE lead_statuses SET needs_lost_reason = TRUE WHERE name = 'Lost';

COMMIT;

-- ══ 3. WHAT THIS CANNOT FIX ════════════════════════════════════════════════
--
-- Outside the transaction because it changes nothing — it only tells you how
-- big the hole is.
--
-- Every lead set to Lost between the modal being deleted and this migration
-- carries no reason and never can. The number matters because the first report
-- run off this data will otherwise look like a sample when it is a fragment.
DO $$
DECLARE
  n_blank INTEGER;
  n_total INTEGER;
  n_flag  INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_flag FROM lead_statuses WHERE needs_lost_reason;
  IF n_flag = 0 THEN
    RAISE WARNING '172: no status has needs_lost_reason ticked - nothing will ask for a reason '
                  'until one is ticked in Settings -> Master Data -> Lead Status.';
  END IF;

  SELECT COUNT(*) INTO n_total
    FROM leads l JOIN lead_statuses s ON s.name = l.status
   WHERE s.needs_lost_reason;

  SELECT COUNT(*) INTO n_blank
    FROM leads l JOIN lead_statuses s ON s.name = l.status
   WHERE s.needs_lost_reason
     AND COALESCE(TRIM(l.lost_reason), '') = '';

  -- RAISE takes % as a placeholder and nothing else - there is no %.1f here,
  -- so the rounding is done in SQL and %% is the literal sign.
  RAISE NOTICE '172: % lost lead(s), % with no reason recorded (% %%) - unrecoverable, '
               'they were set while nothing asked.',
    n_total, n_blank,
    CASE WHEN n_total = 0 THEN 0
         ELSE ROUND(n_blank::numeric * 100 / n_total, 1) END;
END $$;
