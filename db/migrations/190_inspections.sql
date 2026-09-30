-- Migration 190: running an inspection — the evidence behind a status.
--
-- ══ WHY A SNAPSHOT AND NOT A FOREIGN KEY ═══════════════════════════════════
--
-- A checklist template is editable master data (migration 187). A hub renames
-- a point, drops one, or changes what "OK" is called on that sheet. If a
-- completed inspection merely POINTED at the template, every one of those edits
-- would silently rewrite history: a car inspected in March would, in June, show
-- the questions we ask in June and the answers we gave in March.
--
-- That is the exact failure this table exists to prevent. The job card is the
-- document produced in a dispute. So a result COPIES group_name, point_label
-- and option_label as plain text, and the inspection copies the template's own
-- three column headings too — because `label_ok`/`label_attention`/
-- `label_critical` differ per sheet (the 4W sheet says "Needs attention" and
-- "Critical"; the 2W says "Rectified" and "Not OK") and they are editable.
--
-- source_point_id is kept, nullable, ON DELETE SET NULL. It is for analytics
-- only — "how often does this point fail" — and NOTHING renders from it. When
-- the point is deleted the column goes NULL and the printed sheet is unchanged.
--
-- ══ WHY NOT ONE INSPECTION PER KIND ════════════════════════════════════════
--
-- There is deliberately no UNIQUE (job_card_id, kind). A quality check can
-- FAIL — that is what a quality check is for — the car goes back to the floor
-- and is checked again. Both runs matter, and the failed one matters most.
-- Newest by id is the current one; the earlier ones stay readable.

BEGIN;

-- ── One run of one checklist ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_card_inspections (
  id            SERIAL PRIMARY KEY,
  job_card_id   INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('intake', 'pre_delivery')),

  -- Nullable, SET NULL: the snapshot below must survive the template being
  -- deleted. A record that can be destroyed by tidying up master data is not
  -- a record.
  template_id   INTEGER REFERENCES checklist_templates(id) ON DELETE SET NULL,
  template_code TEXT,
  template_name TEXT NOT NULL,

  -- The sheet's own column headings, copied. See the note above.
  label_ok        TEXT NOT NULL DEFAULT 'OK',
  label_attention TEXT NOT NULL DEFAULT 'Needs attention',
  label_critical  TEXT NOT NULL DEFAULT 'Critical',

  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),

  -- WHO, twice, and they are different questions. performed_by is the login
  -- that typed it in; performed_by_technician is the person who actually put
  -- hands on the car. The QC signer rule compares against the SECOND one —
  -- a service advisor entering a mechanic's findings is not the mechanic.
  performed_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_technician INTEGER REFERENCES technicians(id) ON DELETE RESTRICT,

  notes         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_insp ON job_card_inspections (job_card_id, kind, id DESC);

-- ── One answered point ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_card_inspection_results (
  id             SERIAL PRIMARY KEY,
  inspection_id  INTEGER NOT NULL REFERENCES job_card_inspections(id) ON DELETE CASCADE,

  -- Analytics only. Nothing renders from it. See the header.
  source_point_id INTEGER REFERENCES checklist_points(id) ON DELETE SET NULL,

  group_name     TEXT NOT NULL,
  point_label    TEXT NOT NULL,

  -- NULL means NOT YET ANSWERED, and it is not the same as 'na'. A blank row
  -- on a delivery sheet is an unfinished job; 'na' is a technician saying the
  -- question does not apply to this vehicle. Collapsing them would make
  -- "every point answered" unanswerable.
  outcome        TEXT CHECK (outcome IN ('ok', 'attention', 'critical', 'na')),

  -- The chosen option's text, copied at the moment of answering — "Not
  -- glowing", not "ok".
  option_label   TEXT,
  remarks        TEXT,

  group_sort     INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,

  -- The three offered options, copied with the point. A sheet prints "–" where
  -- an outcome is not offered for that point (23 such cells in the 4W sheet),
  -- and the runner must show the same three columns the paper does — including
  -- the blanks. Without these the runner would have to re-read the live
  -- template, which is the coupling this whole table exists to avoid.
  opt_ok         TEXT,
  opt_attention  TEXT,
  opt_critical   TEXT,

  answered_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_insp_results
  ON job_card_inspection_results (inspection_id, group_sort, sort_order);

-- ── Signatures ─────────────────────────────────────────────────────────────
-- A TYPED NAME IS ALWAYS REQUIRED; the drawn mark is optional beside it. Two
-- kinds of evidence rather than one: the drawing is the customer's own hand,
-- which is what settles an argument, but a phone that will not take a finger
-- must not stop a car being delivered. signer_name is NOT NULL so there is
-- never a signature nobody can read.
--
-- Rows are never overwritten. A re-signature is a NEW row and the newest wins;
-- an audit trail whose earlier entries can be replaced is not an audit trail.
CREATE TABLE IF NOT EXISTS job_card_signatures (
  id            SERIAL PRIMARY KEY,
  job_card_id   INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  -- Set when the signature belongs to one inspection; NULL when it belongs to
  -- the card itself — the delivery gate pass in phase 5 signs the card, not a
  -- checklist.
  inspection_id INTEGER REFERENCES job_card_inspections(id) ON DELETE CASCADE,

  role          TEXT NOT NULL CHECK (role IN ('customer', 'technician', 'qc', 'advisor')),
  stage         TEXT NOT NULL DEFAULT 'intake' CHECK (stage IN ('intake', 'qc', 'delivery')),

  signer_name   TEXT NOT NULL,
  image_url     TEXT,

  signed_by_user       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signed_by_technician INTEGER REFERENCES technicians(id) ON DELETE RESTRICT,

  -- Set only when a super admin overrode the "QC signer is not the technician"
  -- rule. A reason is required to write it — see the controller — and the
  -- override is also written to job_card_activities.
  override_reason TEXT,

  signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_sigs      ON job_card_signatures (job_card_id, stage, id DESC);
CREATE INDEX IF NOT EXISTS idx_jc_sigs_insp ON job_card_signatures (inspection_id);

-- ── Body diagram ───────────────────────────────────────────────────────────
-- A dent is a PIN AT A PLACE, not a sentence. "Scratch on the left rear door"
-- is four words that two people read differently; a pin at 68% / 41% on the
-- outline is not.
--
-- Percentages, not pixels. The outline is an SVG that has to render at 360px
-- on a phone at the ramp and at 900px on a laptop, and a mark stored in pixels
-- would drift between the two — which is the one thing a damage record cannot
-- do.
CREATE TABLE IF NOT EXISTS job_card_damage_marks (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

  -- 'main' today: one top-down outline for a car, one side-on for a bike.
  -- A column rather than an assumption, so a second view can be added later
  -- without moving anything already stored.
  view         TEXT NOT NULL DEFAULT 'main',

  x_pct        NUMERIC(6,3) NOT NULL CHECK (x_pct BETWEEN 0 AND 100),
  y_pct        NUMERIC(6,3) NOT NULL CHECK (y_pct BETWEEN 0 AND 100),

  kind         TEXT NOT NULL DEFAULT 'scratch'
               CHECK (kind IN ('scratch', 'dent', 'crack', 'chip', 'rust', 'missing', 'other')),
  note         TEXT,

  -- Same reasoning as job_card_media.stage: WHEN the mark was made is what
  -- makes it evidence. An intake pin and a delivery pin in the same place are
  -- the whole argument.
  stage        TEXT NOT NULL DEFAULT 'intake' CHECK (stage IN ('intake', 'delivery')),

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_damage ON job_card_damage_marks (job_card_id, stage);

-- ── A photo can now belong to one checklist point ──────────────────────────
-- SET NULL, not CASCADE. Re-running a failed quality check deletes the old
-- results; it must not take the photographs with them. An orphaned photo falls
-- back to the card's general photo list, where it is still evidence.
ALTER TABLE job_card_media
  ADD COLUMN IF NOT EXISTS inspection_result_id INTEGER
    REFERENCES job_card_inspection_results(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jc_media_result
  ON job_card_media (inspection_result_id) WHERE inspection_result_id IS NOT NULL;

-- ── New section toggles ────────────────────────────────────────────────────
-- Merged into the existing JSONB rather than replacing it, so a hub that has
-- already switched something off does not have its choice quietly reset.
--
-- `photos_required_for_delivery` is OFF by default and is not a section toggle
-- at all — it is a gate. Phase 5 reads it to block delivery until photos
-- exist. It lives here because the hub-level override is the point of it.
UPDATE job_card_settings
   SET sections = sections || '{
         "inspection": true,
         "body_diagram": true,
         "signatures": true,
         "photos_required_for_delivery": false
       }'::jsonb,
       updated_at = NOW()
 WHERE NOT (sections ? 'inspection');

COMMENT ON TABLE job_card_inspections IS
  'One run of one checklist. The template name and its three column headings are COPIED, not referenced - an edit to master data must never rewrite a completed inspection. No UNIQUE on (job_card_id, kind): a failed QC is re-run and both runs are kept.';
COMMENT ON COLUMN job_card_inspection_results.outcome IS
  'NULL = not yet answered. ''na'' = the technician says it does not apply. Different things; "is every point answered" depends on the difference.';
COMMENT ON TABLE job_card_signatures IS
  'signer_name is always required; image_url is the drawn mark beside it. Rows are never overwritten - a re-signature is a new row and the newest wins.';
COMMENT ON TABLE job_card_damage_marks IS
  'Percentages of the outline, never pixels: the same SVG renders at 360px on a phone and 900px on a laptop, and a mark must not move between them.';

DO $$
DECLARE n_tpl INTEGER; n_empty INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_tpl FROM checklist_templates WHERE is_active;
  SELECT COUNT(*) INTO n_empty
    FROM checklist_templates t
   WHERE t.is_active
     AND NOT EXISTS (
       SELECT 1 FROM checklist_groups g
        JOIN checklist_points p ON p.group_id = g.id
       WHERE g.template_id = t.id);
  RAISE NOTICE '190: inspection tables ready. % active template(s), % still empty.', n_tpl, n_empty;
END $$;

COMMIT;
