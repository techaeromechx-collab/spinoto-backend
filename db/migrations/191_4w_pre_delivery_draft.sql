-- Migration 191: a DRAFT 4W pre-delivery sheet.
--
-- ══ THIS IS A DRAFT AND IT SAYS SO ═════════════════════════════════════════
--
-- The 4W intake sheet and the 2W pre-delivery sheet were typed from the
-- printed forms Spinoto actually hands out. This one was NOT. It is built from
-- the shape of the 2W pre-delivery sheet — the same seven-ish groups, the same
-- three columns, the same voice — with the points a CAR needs instead of the
-- points a bike needs. Nobody at a hub has signed it off.
--
-- So the template name carries "(draft)". That word is visible on the runner,
-- on the printed sheet and in the builder, and it stays there until somebody
-- edits the template and takes it out. A checklist that looks official and is
-- not is worse than no checklist, because the signature at the bottom means
-- the same thing either way.
--
-- ══ THE THREE COLUMNS MEASURE WHAT WE DID, NOT WHAT WE FOUND ═══════════════
--
-- A pre-delivery sheet answers "did we fix it", not "what condition is it in".
-- So the columns are OK / Rectified / Not OK, exactly as on the 2W sheet:
--
--   OK        the good state, found that way        "Full",  "No leak"
--   Rectified what we did about it                  "Topped up", "Adjusted"
--   Not OK    still wrong, and the customer is told "Low", "Replace"
--
-- "Rectified" is the column that does the work. Without it a delivery sheet
-- can only say we found nothing, which is the opposite of the point.
--
-- ══ SAFE TO RE-RUN, AND IT TOUCHES NOTHING ELSE ════════════════════════════
--
-- Guarded three ways: it seeds ONLY the template with code '4w_pre_delivery',
-- it does nothing at all if that template already has points (so a hub's own
-- edits are never overwritten by re-running migrations), and it never reads or
-- writes the two templates that were typed from the real forms.

BEGIN;

DO $seed$
DECLARE
  tpl_id   INTEGER;
  existing INTEGER;
  n_g      INTEGER;
  n_p      INTEGER;
  n_o      INTEGER;
BEGIN
  SELECT id INTO tpl_id FROM checklist_templates WHERE code = '4w_pre_delivery';
  IF tpl_id IS NULL THEN
    RAISE NOTICE '191: no 4w_pre_delivery template - run 187 first. Nothing done.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO existing
    FROM checklist_groups g JOIN checklist_points p ON p.group_id = g.id
   WHERE g.template_id = tpl_id;

  IF existing > 0 THEN
    RAISE NOTICE '191: 4w_pre_delivery already has % point(s) - left alone.', existing;
    RETURN;
  END IF;

  /* The name says draft. Deliberately not a separate boolean column: a flag
     needs every screen to remember to render it, a name renders everywhere by
     itself — including on the printed sheet a customer signs. */
  UPDATE checklist_templates
     SET name            = '4W Pre-Delivery Inspection (draft — please review)',
         label_ok        = 'OK',
         label_attention = 'Rectified',
         label_critical  = 'Not OK',
         updated_at      = NOW()
   WHERE id = tpl_id;

  CREATE TEMP TABLE _pd_seed (
    group_name TEXT, group_sort INTEGER, point_sort INTEGER, label TEXT,
    ok TEXT, attention TEXT, critical TEXT
  ) ON COMMIT DROP;

  INSERT INTO _pd_seed (group_name, group_sort, point_sort, label, ok, attention, critical) VALUES
  -- 1 ───────────────────────────────────────────────────────────────────────
  ('ENGINE & FLUIDS', 1, 1,  'Engine oil — level & grade',            'Correct',    'Changed / topped up', 'Low'),
  ('ENGINE & FLUIDS', 1, 2,  'Coolant level & strength',              'Correct',    'Topped up',           'Low'),
  ('ENGINE & FLUIDS', 1, 3,  'Brake & clutch fluid level',            'Correct',    'Topped up',           'Low'),
  ('ENGINE & FLUIDS', 1, 4,  'Power steering & washer fluid',         'Correct',    'Topped up',           'Low'),
  ('ENGINE & FLUIDS', 1, 5,  'Oil, coolant or fuel leakage',          'No leak',    'Seepage — sealed',    'Leaking'),
  ('ENGINE & FLUIDS', 1, 6,  'Engine start, idling & exhaust smoke',  'Smooth',     'Tuned',               'Rough / smoky'),
  ('ENGINE & FLUIDS', 1, 7,  'Air filter & cabin filter',             'Clean',      'Cleaned / replaced',  'Replace'),
  ('ENGINE & FLUIDS', 1, 8,  'Belts & hoses',                         'No damage',  'Adjusted',            'Replace'),

  -- 2 ───────────────────────────────────────────────────────────────────────
  ('BRAKES & SUSPENSION', 2, 9,  'Brake pad / disc / drum wear',      'Within limit', 'Replaced',          'Replace'),
  ('BRAKES & SUSPENSION', 2, 10, 'Braking efficiency — road test',    'Effective',    'Adjusted / bled',   'Not effective'),
  ('BRAKES & SUSPENSION', 2, 11, 'Handbrake travel & hold',           'Correct',      'Adjusted',          'Not holding'),
  ('BRAKES & SUSPENSION', 2, 12, 'Suspension noise & shock leakage',  'No noise',     'Attended',          'Noise / leaking'),
  ('BRAKES & SUSPENSION', 2, 13, 'Steering play & pulling',           'Centred',      'Aligned',           'Pulls / loose'),

  -- 3 ───────────────────────────────────────────────────────────────────────
  ('WHEELS & TYRES', 3, 14, 'Tyre pressure — all four',               'Correct',     'Set',                'Not set'),
  ('WHEELS & TYRES', 3, 15, 'Tyre tread & uneven wear',               'Within limit','Rotated',            'Replace'),
  ('WHEELS & TYRES', 3, 16, 'Wheel nuts torqued',                     'Torqued',     NULL,                 'Not torqued'),
  ('WHEELS & TYRES', 3, 17, 'Wheel balancing & alignment',            'Not required','Done',               'Pending'),
  ('WHEELS & TYRES', 3, 18, 'Spare wheel, jack & tool kit in car',    'Present',     'Replaced in boot',   'Missing'),

  -- 4 ───────────────────────────────────────────────────────────────────────
  ('ELECTRICAL & CONSOLE', 4, 19, 'Battery charge & terminals',       'Healthy',   'Cleaned / charged',  'Weak / dead'),
  ('ELECTRICAL & CONSOLE', 4, 20, 'Headlights — low & high beam',     'Working',   'Adjusted / replaced','Not working'),
  ('ELECTRICAL & CONSOLE', 4, 21, 'Tail, brake & reverse lights',     'Working',   'Replaced',           'Not working'),
  ('ELECTRICAL & CONSOLE', 4, 22, 'Indicators & hazard lights',       'Working',   'Replaced',           'Not working'),
  ('ELECTRICAL & CONSOLE', 4, 23, 'Horn',                             'Working',   'Attended',           'Not working'),
  ('ELECTRICAL & CONSOLE', 4, 24, 'Wipers & washer spray',            'Working',   'Replaced / refilled','Not working'),
  ('ELECTRICAL & CONSOLE', 4, 25, 'Dashboard warning lights cleared', 'None on',   'Cleared',            'Still on'),
  ('ELECTRICAL & CONSOLE', 4, 26, 'AC cooling & blower',              'Cooling',   'Gas topped / serviced','Not cooling'),
  ('ELECTRICAL & CONSOLE', 4, 27, 'Stereo, speakers & reverse camera','Working',   'Attended',           'Not working'),
  ('ELECTRICAL & CONSOLE', 4, 28, 'Central locking & power windows',  'Working',   'Attended',           'Not working'),

  -- 5 ───────────────────────────────────────────────────────────────────────
  -- The group the whole document exists for. "Customer complaints addressed"
  -- is the point a delivery argument actually turns on, so it is first here
  -- and it is the one phase 5 will gate delivery on.
  ('WORK DONE & ROAD TEST', 5, 29, 'Every customer complaint addressed', 'All addressed', 'Partly — explained', 'Not addressed'),
  ('WORK DONE & ROAD TEST', 5, 30, 'Estimate items completed',           'All done',      'Partly — explained', 'Pending'),
  ('WORK DONE & ROAD TEST', 5, 31, 'Road test — gears & clutch',         'Smooth',        'Adjusted',           'Problem found'),
  ('WORK DONE & ROAD TEST', 5, 32, 'Road test — no abnormal noise',      'None',          'Attended',           'Noise present'),
  ('WORK DONE & ROAD TEST', 5, 33, 'No new fault after work',            'None',          'Attended',           'Fault present'),

  -- 6 ───────────────────────────────────────────────────────────────────────
  ('BODY, INTERIOR & CLEANING', 6, 34, 'Panels & paint — no new damage', 'No damage', 'Touched up',   'Damaged'),
  ('BODY, INTERIOR & CLEANING', 6, 35, 'Glass, mirrors & number plates',  'No damage', 'Attended',     'Damaged'),
  ('BODY, INTERIOR & CLEANING', 6, 36, 'Interior cleaned, no grease marks','Clean',    'Cleaned',      'Not done'),
  ('BODY, INTERIOR & CLEANING', 6, 37, 'Exterior wash',                   'Done',      NULL,           'Not done'),
  ('BODY, INTERIOR & CLEANING', 6, 38, 'Seat & steering covers removed',  'Removed',   NULL,           'Left on'),

  -- 7 ───────────────────────────────────────────────────────────────────────
  ('HANDOVER', 7, 39, 'Old / replaced parts shown to customer', 'Shown',          'Returned',        'Not shown'),
  ('HANDOVER', 7, 40, 'Documents & keys returned',              'Returned',       NULL,              'Pending'),
  ('HANDOVER', 7, 41, 'Personal belongings returned',           'Returned',       NULL,              'Pending'),
  ('HANDOVER', 7, 42, 'Invoice explained to customer',          'Explained',      NULL,              'Pending'),
  ('HANDOVER', 7, 43, 'Next service due told to customer',      'Told',           NULL,              'Pending'),
  ('HANDOVER', 7, 44, 'Fuel level same as at intake',           'Same',           'Explained',       'Lower');

  INSERT INTO checklist_groups (template_id, name, sort_order)
  SELECT DISTINCT tpl_id, s.group_name, s.group_sort FROM _pd_seed s;

  INSERT INTO checklist_points (group_id, label, sort_order)
  SELECT g.id, s.label, s.point_sort
    FROM _pd_seed s
    JOIN checklist_groups g ON g.template_id = tpl_id AND g.name = s.group_name;

  /* Unpivoted, and a NULL label inserts NOTHING — the same rule as 187. That
     blank IS the "–" on the printed sheet: "wheel nuts torqued" has no middle
     answer, because a nut is tight or it is not. */
  INSERT INTO checklist_point_options (point_id, outcome, label)
  SELECT p.id, v.outcome, v.label
    FROM _pd_seed s
    JOIN checklist_groups g ON g.template_id = tpl_id AND g.name = s.group_name
    JOIN checklist_points p ON p.group_id = g.id AND p.sort_order = s.point_sort
   CROSS JOIN LATERAL (VALUES ('ok', s.ok), ('attention', s.attention), ('critical', s.critical))
        AS v(outcome, label)
   WHERE v.label IS NOT NULL;

  SELECT COUNT(*) INTO n_g FROM checklist_groups WHERE template_id = tpl_id;
  SELECT COUNT(*) INTO n_p FROM checklist_points p
    JOIN checklist_groups g ON g.id = p.group_id WHERE g.template_id = tpl_id;
  SELECT COUNT(*) INTO n_o FROM checklist_point_options o
    JOIN checklist_points p ON p.id = o.point_id
    JOIN checklist_groups g ON g.id = p.group_id WHERE g.template_id = tpl_id;

  RAISE NOTICE '191: 4W pre-delivery DRAFT seeded - % groups, % points, % options. '
               'Review it at Master data > Checklists and remove "(draft)" from the '
               'name when it is right.', n_g, n_p, n_o;
END
$seed$;

COMMIT;
