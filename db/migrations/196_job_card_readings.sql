-- 196_job_card_readings.sql
--
-- A reading every time the car moves through a state, not twice a job.
--
-- ══ THE GAP ════════════════════════════════════════════════════════════════
--
-- job_cards has carried four columns since migration 189, and 189 said what
-- they were for in its own words:
--
--   "Two columns, not one. The printed sheet prints ODO READING (IN / OUT) in
--    a single box; in and out are different readings taken hours apart and the
--    difference between them is the only proof a test drive happened."
--
-- That is true and it is not enough. Two readings tell you the car moved 18 km
-- somewhere between arrival and handover. They cannot tell you WHEN, or under
-- whose name, and those are the two things asked when a customer rings to say
-- their car did 40 km it should not have.
--
-- Between those two numbers a car is road-tested, moved to a second bay, taken
-- for a wheel alignment down the road, and parked overnight. Every one of those
-- is a status change on the card, and not one of them records a reading.
--
-- ══ A TABLE, NOT MORE COLUMNS ══════════════════════════════════════════════
--
-- The obvious alternative — odometer_qc, odometer_ready, odometer_delivered —
-- fails the first time a card goes back from QC to in-progress, which is the
-- normal shape of rework. A visit has an unbounded number of transitions and a
-- row per reading is the only shape that does not need a schema change the next
-- time somebody adds a status.
--
-- ══ THE FOUR COLUMNS STAY ══════════════════════════════════════════════════
--
-- odometer_in / odometer_out / fuel_in / fuel_out are NOT deprecated by this.
-- They are what the printed job card prints, what the gate pass checks before
-- it lets a car out, and what every existing screen reads. This table is the
-- trail behind them, and the controller keeps the two in step: the first
-- reading fills `in` if it is empty, and a reading taken on the way to ready,
-- delivered or closed updates `out`.
--
-- Deliberately NOT on every reading: a mid-job reading writing odometer_out
-- would let the gate pass default to it, and the gate pass demanding a FRESH
-- reading at handover is a check this migration must not weaken.

BEGIN;

CREATE TABLE IF NOT EXISTS job_card_readings (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

  -- The transition this reading was taken at. Both NULL for a reading that
  -- belongs to an event rather than a move — a gate pass, or a correction.
  status_from  TEXT,
  status_to    TEXT,

  -- Same units and the same range as the columns on job_cards, so a reading
  -- here and a reading there cannot mean different things.
  odometer     INTEGER  CHECK (odometer >= 0 AND odometer <= 9999999),
  fuel         SMALLINT CHECK (fuel BETWEEN 0 AND 4),

  -- A row with neither number is not a reading. Without this the status
  -- endpoint would happily write an empty row per transition and the trail
  -- would fill with nothing.
  CONSTRAINT job_card_readings_has_a_number CHECK (odometer IS NOT NULL OR fuel IS NOT NULL),

  note         TEXT,

  -- What kind of event produced it. 'status_change' is the new one; the other
  -- three name readings this system already took and never kept a trail of.
  source       TEXT NOT NULL DEFAULT 'status_change'
               CHECK (source IN ('open', 'status_change', 'gate_pass', 'correction')),

  recorded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE job_card_readings IS
  'One row per odometer/fuel reading taken on a job card. job_cards.odometer_in/out remain the printed and gate-checked figures; this is the trail behind them.';
COMMENT ON COLUMN job_card_readings.source IS
  'open = taken when the card was opened. status_change = taken as the card moved. gate_pass = taken at handover. correction = somebody edited the figure afterwards.';
COMMENT ON COLUMN job_card_readings.status_to IS
  'NULL when the reading belongs to an event rather than a transition (gate_pass, correction).';

-- The trail is always read for one card, oldest first.
CREATE INDEX IF NOT EXISTS idx_jc_readings_card
  ON job_card_readings (job_card_id, recorded_at, id);

-- ══ BACKFILL ═══════════════════════════════════════════════════════════════
--
-- Only readings that already have a real time and a real name against them.
--
-- The intake reading has both: opened_at and opened_by are on the card. So does
-- the handover reading WHERE A GATE PASS EXISTS — issued_at and issued_by are
-- on the pass.
--
-- An odometer_out set by hand through the header PATCH has neither. It is a
-- number with no timestamp and no author, and writing it into this table would
-- mean inventing one of each. Migration 175 refused the same trade for
-- decided_by and the reason has not changed: a guess in an evidence column is
-- something somebody will one day be asked to answer for. Those cards get an
-- intake reading and no handover reading, which is the honest shape — the
-- reading was taken, this system simply never recorded when.

INSERT INTO job_card_readings (job_card_id, status_from, status_to, odometer, fuel,
                               source, recorded_by, recorded_at, note)
SELECT jc.id, NULL, 'open', jc.odometer_in, jc.fuel_in,
       'open', jc.opened_by, jc.opened_at,
       'Backfilled from the reading taken when the card was opened.'
  FROM job_cards jc
 WHERE (jc.odometer_in IS NOT NULL OR jc.fuel_in IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM job_card_readings r
                    WHERE r.job_card_id = jc.id AND r.source = 'open');

INSERT INTO job_card_readings (job_card_id, status_from, status_to, odometer, fuel,
                               source, recorded_by, recorded_at, note)
SELECT gp.job_card_id, NULL, NULL, gp.odometer_out, gp.fuel_out,
       'gate_pass', gp.issued_by, gp.issued_at,
       'Backfilled from gate pass ' || gp.pass_no || '.'
  FROM job_card_gate_passes gp
 WHERE (gp.odometer_out IS NOT NULL OR gp.fuel_out IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM job_card_readings r
                    WHERE r.job_card_id = gp.job_card_id
                      AND r.source = 'gate_pass'
                      AND r.recorded_at = gp.issued_at);

COMMIT;
