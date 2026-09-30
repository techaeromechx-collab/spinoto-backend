-- Migration 187: checklist master — editable inspection templates.
--
-- ══ WHY THIS IS FOUR TABLES AND NOT ONE ════════════════════════════════════
--
-- The obvious shape is one table of check points with three columns for the
-- three outcomes. Spinoto's own printed sheets rule that out: the three
-- columns are NOT fixed values. Every row carries its own labels.
--
--     Engine oil — level & colour     Correct   / Topped up  / Low, dirty
--     Brake pad / shoe wear           Good      / 50% worn   / Replace
--     Headlight — low / high beam     Working   / Beam set   / Not working
--
-- And on the 4W sheet some cells are "–": row 1, dashboard malfunction light,
-- has no middle option at all. So an option is a ROW, with its own label, sort
-- order and active flag — and a missing row is how "–" is stored. Three enum
-- columns could hold none of this.
--
-- ══ THE TWO SHEETS MEASURE DIFFERENT THINGS ════════════════════════════════
--
-- The 2W sheet's middle column is RECTIFIED — "we fixed it during this job",
-- which is a DELIVERY check. The 4W sheet's columns are Needs attention and
-- Critical, which describe the vehicle's CONDITION — an INTAKE inspection.
-- Rows 25–30 of the 4W sheet (engine oil level, service due light) exist to
-- find work worth quoting, which only makes sense before the work starts.
--
-- So `kind` separates them, and the outcome columns are named per template:
-- internally always ok / attention / critical, displayed as whatever that
-- sheet calls them. That is what label_ok, label_attention and label_critical
-- are for, and it is why one enum serves both sheets without either of them
-- having to lie about what its middle column means.
--
-- ══ NOTHING HERE IS A RESULT ═══════════════════════════════════════════════
--
-- These tables are the QUESTIONS. The answers live on the job card (phase 4)
-- and COPY the labels rather than pointing at them, so editing a template in
-- November cannot rewrite an inspection signed in September.
--
-- ══ PERMISSION ═════════════════════════════════════════════════════════════
--
-- Reuses MANAGE_MASTER_DATA rather than minting a new permission. This is
-- master data in the ordinary sense — the same class of thing as services and
-- vehicle models — and a new permission granted to nobody would only have to
-- be handed out again.

BEGIN;

-- ── Templates ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checklist_templates (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('intake', 'pre_delivery')),
  -- Nullable: a template that applies to every vehicle type is legitimate, and
  -- the seed leaves it NULL rather than guessing when no vehicle type matches.
  vehicle_type_id  INTEGER REFERENCES vehicle_types(id) ON DELETE SET NULL,
  label_ok         TEXT NOT NULL DEFAULT 'OK',
  label_attention  TEXT NOT NULL DEFAULT 'Needs attention',
  label_critical   TEXT NOT NULL DEFAULT 'Critical',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ── Groups ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checklist_groups (
  id           SERIAL PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cl_groups_template ON checklist_groups (template_id, sort_order);

-- ── Points ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checklist_points (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES checklist_groups(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cl_points_group ON checklist_points (group_id, sort_order);

-- ── Options ────────────────────────────────────────────────────────────────
-- At most one row per (point, outcome). A MISSING row is how the "–" on the
-- printed sheet is stored: that column simply is not offered for that point.
CREATE TABLE IF NOT EXISTS checklist_point_options (
  id          SERIAL PRIMARY KEY,
  point_id    INTEGER NOT NULL REFERENCES checklist_points(id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'attention', 'critical')),
  label       TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (point_id, outcome)
);
CREATE INDEX IF NOT EXISTS idx_cl_options_point ON checklist_point_options (point_id);

COMMENT ON TABLE checklist_templates IS
  'Inspection checklist master. kind=intake runs when the vehicle arrives, kind=pre_delivery before handover. label_ok/attention/critical are the COLUMN HEADINGS this sheet prints - the 2W sheet calls them OK/Rectified/Not OK, the 4W sheet OK/Needs attention/Critical, while the stored outcome is always ok/attention/critical.';
COMMENT ON TABLE checklist_point_options IS
  'The per-point labels under each outcome column. A point with no row for an outcome does not offer that column - this is how the "-" on the printed sheet is represented.';

-- ══ SEED ═══════════════════════════════════════════════════════════════════
--
-- The two printed sheets, transcribed exactly: 44 points in 10 groups for the
-- 4W intake, 30 points in 7 groups for the 2W pre-delivery. The other two
-- combinations are created EMPTY on purpose — Spinoto has no 4W delivery sheet
-- and no 2W intake sheet yet, and inventing their contents here would put
-- checks on a mechanic's screen that nobody at Spinoto agreed to.
--
-- Idempotent: the whole block skips if any template already exists, so a
-- re-run cannot duplicate 74 points.

DO $seed$
DECLARE
  vt_2w INTEGER;
  vt_4w INTEGER;
  n_groups  INTEGER;
  n_points  INTEGER;
  n_options INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM checklist_templates) THEN
    RAISE NOTICE '187: checklist templates already present - seed skipped.';
    RETURN;
  END IF;

  /* Matched by name rather than hard-coded ids, and left NULL when no vehicle
     type matches rather than guessing. A template with no vehicle type still
     works; it just applies to everything until somebody sets it. */
  SELECT id INTO vt_2w FROM vehicle_types
   WHERE name ILIKE '%2%' OR name ILIKE '%two%' ORDER BY id LIMIT 1;
  SELECT id INTO vt_4w FROM vehicle_types
   WHERE name ILIKE '%4%' OR name ILIKE '%four%' ORDER BY id LIMIT 1;

  INSERT INTO checklist_templates (code, name, kind, vehicle_type_id,
                                   label_ok, label_attention, label_critical)
  VALUES
    ('4w_intake',        '4W Vehicle Inspection',      'intake',       vt_4w,
     'OK', 'Needs attention', 'Critical'),
    ('2w_pre_delivery',  '2W Pre-Delivery Inspection', 'pre_delivery', vt_2w,
     'OK', 'Rectified', 'Not OK'),
    ('4w_pre_delivery',  '4W Pre-Delivery Inspection', 'pre_delivery', vt_4w,
     'OK', 'Rectified', 'Not OK'),
    ('2w_intake',        '2W Vehicle Inspection',      'intake',       vt_2w,
     'OK', 'Needs attention', 'Critical');

  CREATE TEMP TABLE _cl_seed (
    tpl_code   TEXT,
    group_name TEXT,
    group_sort INTEGER,
    point_sort INTEGER,
    label      TEXT,
    ok         TEXT,
    attention  TEXT,
    critical   TEXT
  ) ON COMMIT DROP;

  INSERT INTO _cl_seed (tpl_code, group_name, group_sort, point_sort, label, ok, attention, critical)
  VALUES
  ('4w_intake', 'ELECTRICAL', 1, 1, 'Dashboard malfunction light', 'Not glowing', NULL, 'Glowing'),
  ('4w_intake', 'ELECTRICAL', 1, 2, 'Wiring harness / modules', 'No damage', NULL, 'Damaged'),
  ('4w_intake', 'ELECTRICAL', 1, 3, 'Speaker / stereo system', 'Working good', 'Not working', NULL),
  ('4w_intake', 'ELECTRICAL', 1, 4, 'Exterior lights (head / tail / indicator)', 'No issue', NULL, 'Issue found'),
  ('4w_intake', 'ELECTRICAL', 1, 5, 'Battery health', 'Healthy', 'Weak', 'Dead'),
  ('4w_intake', 'HEATING & AC', 2, 6, 'AC vent air flow', 'High flow', 'Low flow', 'No flow'),
  ('4w_intake', 'HEATING & AC', 2, 7, 'Air type when AC is ON', 'Cold air', 'Normal air', 'Hot air'),
  ('4w_intake', 'HEATING & AC', 2, 8, 'AC blower noise', 'No noise', 'Low noise', 'Extreme noise'),
  ('4w_intake', 'EXTERIOR & INTERIOR (BODY & ACCESSORIES)', 3, 9, 'Scratches on exterior panel', 'No', 'Yes', NULL),
  ('4w_intake', 'EXTERIOR & INTERIOR (BODY & ACCESSORIES)', 3, 10, 'Car seats / interior panels damage', 'No', 'Yes', NULL),
  ('4w_intake', 'EXTERIOR & INTERIOR (BODY & ACCESSORIES)', 3, 11, 'Power window switch', 'No issue', 'Issue found', NULL),
  ('4w_intake', 'WHEELS', 4, 12, 'Tyre condition', 'Good', 'Ok', 'Not good'),
  ('4w_intake', 'WHEELS', 4, 13, 'Noise from wheels', 'No noise', 'Low noise', 'Extreme noise'),
  ('4w_intake', 'WHEELS', 4, 14, 'Wheel wobbling', 'No', NULL, 'Yes'),
  ('4w_intake', 'WHEELS', 4, 15, 'TPMS malfunction light', 'Not glowing', 'Glowing', NULL),
  ('4w_intake', 'BRAKES', 5, 16, 'Front brake pads & disc wear', 'No erosion', 'Normal erosion', 'Extreme'),
  ('4w_intake', 'BRAKES', 5, 17, 'Brake oil level', 'Full', 'Half', 'Low'),
  ('4w_intake', 'BRAKES', 5, 18, 'Brake caliper noise', 'No', NULL, 'Yes'),
  ('4w_intake', 'BRAKES', 5, 19, 'Brake efficiency', 'Good', 'Fair', 'Bad'),
  ('4w_intake', 'BRAKES', 5, 20, 'Brake warning / ABS light', 'Not glowing', NULL, 'Glowing'),
  ('4w_intake', 'SUSPENSION', 6, 21, 'Front suspension noise', 'No noise', 'Low noise', 'Extreme noise'),
  ('4w_intake', 'SUSPENSION', 6, 22, 'Rear suspension noise', 'No noise', 'Low noise', 'Extreme noise'),
  ('4w_intake', 'SUSPENSION', 6, 23, 'Wheel hub noise', 'No', NULL, 'Yes'),
  ('4w_intake', 'SUSPENSION', 6, 24, 'Drive axle noise', 'No', NULL, 'Yes'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 25, 'Engine oil level', 'Full', 'Half', 'Low'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 26, 'Engine oil filter', 'Good', 'Average', 'Bad'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 27, 'Engine air filter', 'Good', 'Average', 'Bad'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 28, 'Coolant level', 'Full', 'Half', 'Low'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 29, 'AC filter', 'Good', 'Fair', 'Bad'),
  ('4w_intake', 'SCHEDULE MAINTENANCE', 7, 30, 'Service due warning light', 'Not showing', 'Showing', NULL),
  ('4w_intake', 'ENGINE', 8, 31, 'Check engine light', 'Not glowing', NULL, 'Glowing'),
  ('4w_intake', 'ENGINE', 8, 32, 'Engine noise / vibration', 'None', 'Low', 'Extreme'),
  ('4w_intake', 'ENGINE', 8, 33, 'Smoke from exhaust', 'No', NULL, 'Yes'),
  ('4w_intake', 'ENGINE', 8, 34, 'Engine overheating', 'No', NULL, 'Yes'),
  ('4w_intake', 'ENGINE', 8, 35, 'Fluid leakage (oil / coolant)', 'No', NULL, 'Yes'),
  ('4w_intake', 'ENGINE', 8, 36, 'Engine drive belt noise', 'No', 'Yes', NULL),
  ('4w_intake', 'STEERING', 9, 37, 'Noise / vibration while turning', 'None', 'Low', 'Extreme'),
  ('4w_intake', 'STEERING', 9, 38, 'Steering hardness while turning', 'Smooth', 'Harder than normal', 'Extremely hard'),
  ('4w_intake', 'STEERING', 9, 39, 'EPS / steering malfunction light', 'Not glowing', NULL, 'Glowing'),
  ('4w_intake', 'CLUTCH & TRANSMISSION', 10, 40, 'Clutch / gearbox noise', 'No noise', 'Low noise', 'Extreme noise'),
  ('4w_intake', 'CLUTCH & TRANSMISSION', 10, 41, 'Gear shifting issue', 'No', NULL, 'Yes'),
  ('4w_intake', 'CLUTCH & TRANSMISSION', 10, 42, 'Transmission / drivetrain light', 'Not glowing', NULL, 'Glowing'),
  ('4w_intake', 'CLUTCH & TRANSMISSION', 10, 43, 'Clutch pedal', 'Working fine', 'Average hardness', 'Very hard'),
  ('4w_intake', 'CLUTCH & TRANSMISSION', 10, 44, 'Oil leak from gearbox / drive axles', 'No', NULL, 'Yes'),
  ('2w_pre_delivery', 'ENGINE & FLUIDS', 1, 1, 'Engine oil — level & colour', 'Correct', 'Topped up', 'Low / dirty'),
  ('2w_pre_delivery', 'ENGINE & FLUIDS', 1, 2, 'Coolant & brake fluid level', 'Full', 'Topped up', 'Low'),
  ('2w_pre_delivery', 'ENGINE & FLUIDS', 1, 3, 'Oil / fuel leakage', 'No leak', 'Seepage', 'Leaking'),
  ('2w_pre_delivery', 'ENGINE & FLUIDS', 1, 4, 'Engine start, idling & exhaust smoke', 'Smooth', 'Tuned', 'Rough / smoky'),
  ('2w_pre_delivery', 'ENGINE & FLUIDS', 1, 5, 'Air filter & spark plug', 'Clean', 'Cleaned', 'Replace'),
  ('2w_pre_delivery', 'CABLES & CONTROLS', 2, 6, 'Clutch cable — play & smoothness', 'Correct', 'Adjusted / oiled', 'Replace'),
  ('2w_pre_delivery', 'CABLES & CONTROLS', 2, 7, 'Accelerator cable — play & return', 'Correct', 'Adjusted / oiled', 'Replace'),
  ('2w_pre_delivery', 'CABLES & CONTROLS', 2, 8, 'Front brake cable / hose', 'Correct', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'CABLES & CONTROLS', 2, 9, 'Rear brake cable / rod & pedal play', 'Correct', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'CABLES & CONTROLS', 2, 10, 'Choke & speedometer cable', 'Working', 'Adjusted / oiled', 'Replace'),
  ('2w_pre_delivery', 'BRAKES, CHAIN & GEARS', 3, 11, 'Brake pad / shoe wear', 'Good', '50% worn', 'Replace'),
  ('2w_pre_delivery', 'BRAKES, CHAIN & GEARS', 3, 12, 'Braking efficiency — front & rear', 'Good', 'Adjusted', 'Poor'),
  ('2w_pre_delivery', 'BRAKES, CHAIN & GEARS', 3, 13, 'Drive chain slack & lubrication', 'Correct', 'Adjusted / oiled', 'Replace'),
  ('2w_pre_delivery', 'BRAKES, CHAIN & GEARS', 3, 14, 'Gear shifting through all gears', 'Smooth', 'Hard', 'Not shifting'),
  ('2w_pre_delivery', 'WHEELS & SUSPENSION', 4, 15, 'Front tyre — pressure & tread', 'Correct', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'WHEELS & SUSPENSION', 4, 16, 'Rear tyre — pressure & tread', 'Correct', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'WHEELS & SUSPENSION', 4, 17, 'Wheel wobble, rim & bearing', 'OK', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'WHEELS & SUSPENSION', 4, 18, 'Front fork & rear shocker', 'OK', 'Adjusted', 'Leaking / weak'),
  ('2w_pre_delivery', 'WHEELS & SUSPENSION', 4, 19, 'Steering play & handlebar', 'OK', 'Adjusted', 'Replace'),
  ('2w_pre_delivery', 'LIGHTS, INDICATORS & HORN', 5, 20, 'Headlight — low / high beam', 'Working', 'Beam set', 'Not working'),
  ('2w_pre_delivery', 'LIGHTS, INDICATORS & HORN', 5, 21, 'Tail light & brake light (both levers)', 'Working', 'Bulb changed', 'Not working'),
  ('2w_pre_delivery', 'LIGHTS, INDICATORS & HORN', 5, 22, 'Indicators — front, rear & hazard', 'All working', 'Bulb changed', 'Not working'),
  ('2w_pre_delivery', 'LIGHTS, INDICATORS & HORN', 5, 23, 'Horn & number plate light', 'Working', 'Tuned / set', 'Not working'),
  ('2w_pre_delivery', 'SWITCHES, LOCKS & CONSOLE', 6, 24, 'Handle switches — dipper, starter, kill', 'OK', 'Cleaned', 'Faulty'),
  ('2w_pre_delivery', 'SWITCHES, LOCKS & CONSOLE', 6, 25, 'Ignition lock, keys & steering lock', 'OK', 'Lubricated', 'Faulty'),
  ('2w_pre_delivery', 'SWITCHES, LOCKS & CONSOLE', 6, 26, 'Brake light switch & side stand sensor', 'OK', 'Adjusted', 'Faulty'),
  ('2w_pre_delivery', 'SWITCHES, LOCKS & CONSOLE', 6, 27, 'Speedometer & console lamps', 'Working', 'Adjusted', 'Not working'),
  ('2w_pre_delivery', 'BATTERY, BODY & DELIVERY', 7, 28, 'Battery charge & terminals', 'Healthy', 'Cleaned', 'Weak / dead'),
  ('2w_pre_delivery', 'BATTERY, BODY & DELIVERY', 7, 29, 'Body, paint, fasteners & washing', 'No damage', 'Scratches / tightened', 'Damaged'),
  ('2w_pre_delivery', 'BATTERY, BODY & DELIVERY', 7, 30, 'Documents, keys, tool kit & test ride', 'Handed over & OK', 'Partly done', 'Pending');

  INSERT INTO checklist_groups (template_id, name, sort_order)
  SELECT DISTINCT t.id, s.group_name, s.group_sort
    FROM _cl_seed s JOIN checklist_templates t ON t.code = s.tpl_code;

  INSERT INTO checklist_points (group_id, label, sort_order)
  SELECT g.id, s.label, s.point_sort
    FROM _cl_seed s
    JOIN checklist_templates t ON t.code = s.tpl_code
    JOIN checklist_groups    g ON g.template_id = t.id AND g.name = s.group_name;

  /* Unpivoted, and a NULL label inserts NOTHING - that is the "-" on the
     printed sheet, and it is why this is a filtered insert rather than three
     columns with empty strings in them. */
  INSERT INTO checklist_point_options (point_id, outcome, label)
  SELECT p.id, v.outcome, v.label
    FROM _cl_seed s
    JOIN checklist_templates t ON t.code = s.tpl_code
    JOIN checklist_groups    g ON g.template_id = t.id AND g.name = s.group_name
    JOIN checklist_points    p ON p.group_id = g.id AND p.sort_order = s.point_sort
   CROSS JOIN LATERAL (VALUES ('ok', s.ok), ('attention', s.attention), ('critical', s.critical))
        AS v(outcome, label)
   WHERE v.label IS NOT NULL;

  SELECT COUNT(*) INTO n_groups  FROM checklist_groups;
  SELECT COUNT(*) INTO n_points  FROM checklist_points;
  SELECT COUNT(*) INTO n_options FROM checklist_point_options;

  RAISE NOTICE '187: seeded % groups, % points, % options across 4 templates '
               '(4W intake 44 points / 10 groups, 2W pre-delivery 30 / 7, '
               'the other two intentionally empty). 2W vehicle_type_id=%, 4W=%.',
               n_groups, n_points, n_options,
               COALESCE(vt_2w::text, 'not matched'), COALESCE(vt_4w::text, 'not matched');
END
$seed$;

COMMIT;
