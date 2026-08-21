-- 167_backfill_customer_vehicles.sql
--
-- Gives every vehicle that only ever existed on an appointment or an estimate
-- a real row in customer_vehicles.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- An appointment stores its vehicle in its OWN columns — vehicle_number,
-- vehicle_type_id, make_id, model_id (migration 021). Nothing ever wrote a
-- customer_vehicles row. Standalone estimates have done so since migration
-- 082; appointments never got the same treatment, and the public booking and
-- warranty-redo paths never did either.
--
-- The Customer page's vehicle list is a MERGE of two sources: real
-- customer_vehicles rows, and vehicles DERIVED from appointments. A derived
-- one has cv_id = null, and the edit button reads:
--
--     onClick={() => v.cv_id ? setEditVeh(v) : setPromoteVeh(v)}
--
-- so pressing Edit on a car that came from an appointment did not edit
-- anything. It fell through to "save this vehicle", created a SECOND record
-- that looked manually added, and left the appointment untouched — which is
-- exactly the behaviour that was reported.
--
-- The code fix stops new orphans. This repairs the ones already there.
--
-- ── WHY DISTINCT ON, AND WHY THE NEWEST WINS ────────────────────────────────
--
-- A customer who has been in ten times has ten appointments for one car.
-- customer_vehicles is UNIQUE (mobile, vehicle_number), so inserting all ten
-- would fail — and picking an arbitrary one would sometimes pick the oldest,
-- which is the row most likely to carry a wrong or missing make/model from
-- before anyone corrected it. ORDER BY created_at DESC takes the most recent
-- description of the car, which is the best guess available.
--
-- ── ON CONFLICT DO NOTHING IS NOT BELT-AND-BRACES ───────────────────────────
--
-- DISTINCT ON dedupes within this SELECT. It cannot know about rows that are
-- ALREADY in customer_vehicles — a car somebody registered by hand, complete
-- with colour, year and notes. Those must win: this migration is filling gaps,
-- not asserting that appointments are the better source. Without the conflict
-- clause the whole run would abort on the first such car.
--
-- Two statements rather than one UNION, so the NOTICE lines say which source
-- filled which gaps — and because appointments must go first: where a car
-- appears in both, the appointment is the record of what was actually worked
-- on.
--
-- ── THE PLATE IS UPPERCASED. IT IS NOT DE-SPACED. ───────────────────────────
--
-- trim + upper, matching addCustomerVehicle and utils/customerVehicle.js
-- exactly. It is tempting to also strip spaces, because 'GJ 01 AB 1234' and
-- 'GJ01AB1234' are one car to a human and this system does treat them as two
-- plates on write. That wrinkle is NOT fixed here on purpose: normalising
-- differently in this one place would make the backfill disagree with every
-- writer about what a duplicate is, and produce exactly the double rows it is
-- meant to prevent. Reads already cope — customer lookup strips punctuation
-- when matching. Only writes are strict.

DO $$
DECLARE
  from_appts BIGINT;
  from_ests  BIGINT;
BEGIN
  -- ── 1. Appointments ──────────────────────────────────────────────────────
  WITH one_per_plate AS (
    SELECT DISTINCT ON (a.mobile, UPPER(TRIM(a.vehicle_number)))
           a.mobile,
           UPPER(TRIM(a.vehicle_number))  AS plate,
           a.vehicle_type_id,
           a.make_id,
           a.model_id,
           -- segment_ids is an array on appointments; customer_vehicles holds
           -- one. The first, which is what the Customer page already displays
           -- for a derived vehicle: (a.segment_ids)[1].
           (a.segment_ids)[1]             AS segment_id
      FROM appointments a
     WHERE a.mobile IS NOT NULL
       AND a.vehicle_number IS NOT NULL
       AND TRIM(a.vehicle_number) <> ''
     ORDER BY a.mobile, UPPER(TRIM(a.vehicle_number)), a.created_at DESC, a.id DESC
  )
  INSERT INTO customer_vehicles
        (mobile, vehicle_number, vehicle_type_id, make_id, model_id, segment_id)
  SELECT mobile, plate, vehicle_type_id, make_id, model_id, segment_id
    FROM one_per_plate
  ON CONFLICT (mobile, vehicle_number) DO NOTHING;

  GET DIAGNOSTICS from_appts = ROW_COUNT;
  RAISE NOTICE '167: % vehicle(s) registered from appointments', from_appts;

  -- ── 2. Estimates ─────────────────────────────────────────────────────────
  --
  -- Standalone estimates already upsert on create, so this only catches ones
  -- written before migration 082 added that — and estimates whose upsert was
  -- skipped because they were linked to an appointment rather than standalone.
  WITH one_per_plate AS (
    SELECT DISTINCT ON (e.mobile, UPPER(TRIM(e.vehicle_number)))
           e.mobile,
           UPPER(TRIM(e.vehicle_number))  AS plate,
           e.vehicle_type_id,
           e.make_id,
           e.model_id,
           (e.segment_ids)[1]             AS segment_id
      FROM estimates e
     WHERE e.mobile IS NOT NULL
       AND e.vehicle_number IS NOT NULL
       AND TRIM(e.vehicle_number) <> ''
     ORDER BY e.mobile, UPPER(TRIM(e.vehicle_number)), e.created_at DESC, e.id DESC
  )
  INSERT INTO customer_vehicles
        (mobile, vehicle_number, vehicle_type_id, make_id, model_id, segment_id)
  SELECT mobile, plate, vehicle_type_id, make_id, model_id, segment_id
    FROM one_per_plate
  ON CONFLICT (mobile, vehicle_number) DO NOTHING;

  GET DIAGNOSTICS from_ests = ROW_COUNT;
  RAISE NOTICE '167: % vehicle(s) registered from estimates', from_ests;
  RAISE NOTICE '167: % total', from_appts + from_ests;
END $$;

-- Proof, in the migration itself.
--
-- Every appointment vehicle must now resolve to a customer_vehicles row. If
-- any does not, the run FAILS here rather than reporting success and leaving
-- the Customer page still offering to create duplicates for some customers and
-- not others — a half-fixed state nobody would think to look for.
DO $$
DECLARE
  orphans BIGINT;
  sample  TEXT;
BEGIN
  SELECT count(*), MIN(a.mobile || ' / ' || a.vehicle_number)
    INTO orphans, sample
    FROM appointments a
   WHERE a.mobile IS NOT NULL
     AND a.vehicle_number IS NOT NULL
     AND TRIM(a.vehicle_number) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM customer_vehicles cv
        WHERE cv.mobile = a.mobile
          AND cv.vehicle_number = UPPER(TRIM(a.vehicle_number))
     );

  IF orphans > 0 THEN
    RAISE EXCEPTION '167: % appointment vehicle(s) still have no customer_vehicles row (e.g. %)',
      orphans, sample;
  END IF;

  RAISE NOTICE '167: every appointment vehicle now resolves to a customer record';
END $$;

-- NOT DONE HERE, DELIBERATELY
--
-- No customer_vehicle_id column on appointments, and no FK.
--
-- That is the structurally correct model and it is a much larger change: a
-- backfill matched on a free-text plate, plus every read path that currently
-- uses the denormalised appointment columns, plus a decision about what
-- happens to a historical appointment when its vehicle is later corrected.
-- Worth doing if vehicles become a first-class record in this product. Not
-- worth bundling into the migration that stops the Customer page creating
-- duplicates today.
