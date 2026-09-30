-- Migration 189: the job card — the working document for one vehicle visit.
--
-- ══ ONE VISIT, ONE JOB CARD, ON THE APPOINTMENT ════════════════════════════
--
-- The job card opens the moment the vehicle arrives. The estimate does not
-- exist until after diagnosis. Hanging the job card off the estimate would
-- leave nowhere to record the intake inspection, the complaint or the
-- odometer-in — the very things captured before anything is priced, and the
-- ones that settle a dispute.
--
-- appointment_id is UNIQUE. A visit is a job card. Several estimates may hang
-- off it later (phase 6), which is the other reason it cannot live on one.
--
-- ══ THE STATUS MODEL, AND THE COLLISION IT AVOIDS ══════════════════════════
--
-- appointments.status already has 21 states describing this same journey, and
-- three things already write it: a user picking by hand, the estimate's
-- auto-advance, and the pickup endpoints. A fourth independent ladder would
-- give two records that can disagree — the job card saying Quality Check while
-- the appointment says Work In Progress, with nobody able to say which is true.
--
-- So the job card becomes the SINGLE writer of the workshop-floor statuses and
-- the appointment status mirrors it. One direction only; the job card never
-- reads the appointment status back. The mapping lives in the controller, and
-- `on_hold` is the only status a person sets by hand — everything else is a
-- consequence of something that actually happened.
--
-- ══ NUMBERING ══════════════════════════════════════════════════════════════
--
-- {hub_code}_JC_{MMYY}_{001}, deliberately the same shape as the appointment
-- code (migration 084) rather than the JC-000124 form first sketched. A job
-- card sits beside an appointment code on the same screen and on the same
-- printed sheet; two different conventions there is a cost paid every time
-- somebody reads one. Sequence resets monthly, tracked per hub, claimed with
-- the same upsert-and-increment so two cards opened in the same instant cannot
-- collide.

BEGIN;

-- ── Sequence, per hub per month ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_job_card_sequences (
  hub_id      INTEGER     NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  year        INTEGER     NOT NULL,
  month       INTEGER     NOT NULL,
  last_seq    INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hub_id, year, month)
);

-- ── The card ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_cards (
  id              SERIAL PRIMARY KEY,
  appointment_id  INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  -- Denormalised from the appointment ON PURPOSE: the number is built from it
  -- and frozen, so the card must keep the hub it was opened under even if the
  -- appointment is later moved.
  hub_id          INTEGER NOT NULL REFERENCES hubs(id),
  job_card_no     TEXT UNIQUE,

  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','inspection','awaiting_estimate','awaiting_approval',
                                    'in_progress','on_hold','work_done','qc','ready',
                                    'delivered','closed','cancelled')),
  hold_reason     TEXT,
  service_package TEXT,

  -- Two columns, not one. The printed sheet prints "ODO READING (IN / OUT)" in
  -- a single box; in and out are different readings taken hours apart and the
  -- difference between them is the only proof a test drive happened.
  odometer_in     INTEGER,
  odometer_out    INTEGER,
  -- 0-4 quarters. A number rather than text so "less fuel came back than went
  -- in" is a comparison rather than a reading of two English words.
  fuel_in         SMALLINT CHECK (fuel_in  BETWEEN 0 AND 4),
  fuel_out        SMALLINT CHECK (fuel_out BETWEEN 0 AND 4),

  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  opened_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_cards_hub    ON job_cards (hub_id, status);
CREATE INDEX IF NOT EXISTS idx_job_cards_status ON job_cards (status);

-- ── Complaints and findings ────────────────────────────────────────────────
-- TWO COLUMNS, KEPT APART. `complaint` is the customer's own words — "noise
-- from the front left when braking". `finding` is what the technician found.
-- Collapsing them into one note loses the ability to prove at delivery that
-- the complaint the customer actually raised was the one addressed.
CREATE TABLE IF NOT EXISTS job_card_complaints (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  complaint    TEXT NOT NULL,
  finding      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_complaints ON job_card_complaints (job_card_id, sort_order);

-- ── Technicians on the card ────────────────────────────────────────────────
-- ON DELETE RESTRICT, and this is the point migration 188 flagged: deleting a
-- technician who has left must never delete the record of work they did.
-- Several rows per technician are expected — a mechanic breaks for lunch, or
-- another car jumps the queue, and each stretch is its own row.
CREATE TABLE IF NOT EXISTS job_card_technicians (
  id             SERIAL PRIMARY KEY,
  job_card_id    INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  technician_id  INTEGER NOT NULL REFERENCES technicians(id) ON DELETE RESTRICT,
  role           TEXT,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_techs ON job_card_technicians (job_card_id);
CREATE INDEX IF NOT EXISTS idx_jc_techs_tech ON job_card_technicians (technician_id);

-- ── Items in the vehicle ───────────────────────────────────────────────────
-- Three states, not a boolean: "not applicable" is a real answer (a bike has
-- no spare wheel) and is different from "absent", which is a dispute.
CREATE TABLE IF NOT EXISTS job_card_items (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'na' CHECK (state IN ('present','absent','na')),
  note         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jc_items ON job_card_items (job_card_id, sort_order);

-- ── Photos and video ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_card_media (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  thumb_url    TEXT,
  kind         TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','video')),
  -- WHEN it was taken is what makes it evidence. An intake photo and a
  -- delivery photo of the same panel are the whole argument.
  stage        TEXT NOT NULL DEFAULT 'intake'
               CHECK (stage IN ('intake','during','delivery')),
  caption      TEXT,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_media ON job_card_media (job_card_id, stage);

-- ── Activity timeline ──────────────────────────────────────────────────────
-- Same shape as lead_activities, which already exists, rather than a third
-- pattern. This matters more here than anywhere else in the CRM: the job card
-- is the document you would produce in a dispute, and a signature with no
-- trail behind it proves very little.
CREATE TABLE IF NOT EXISTS job_card_activities (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  note         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_activities ON job_card_activities (job_card_id, created_at DESC);

-- ── Section toggles ────────────────────────────────────────────────────────
-- One row is the global default; a row with a hub_id overrides it for that hub.
-- The compliance gates are deliberately absent from this table: if a hub can
-- switch off "was the customer's complaint addressed", the protection those
-- checks exist to give is gone.
CREATE TABLE IF NOT EXISTS job_card_settings (
  id          SERIAL PRIMARY KEY,
  hub_id      INTEGER UNIQUE REFERENCES hubs(id) ON DELETE CASCADE,
  sections    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jc_settings_global
  ON job_card_settings ((hub_id IS NULL)) WHERE hub_id IS NULL;

INSERT INTO job_card_settings (hub_id, sections)
SELECT NULL, '{
  "complaints": true, "findings": true, "technicians": true,
  "items_in_vehicle": true, "photos": true, "odometer": true,
  "fuel": true, "time_tracking": false
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM job_card_settings WHERE hub_id IS NULL);

COMMENT ON TABLE job_cards IS
  'The working document for one vehicle visit. One per appointment (appointment_id is UNIQUE). Single writer of the workshop-floor appointment statuses - see the controller mapping. Numbered {hub_code}_JC_{MMYY}_{001}, matching the appointment code format.';
COMMENT ON COLUMN job_cards.fuel_in IS
  'Quarters, 0-4. A number so fuel_out < fuel_in is a comparison rather than a reading of two English words.';
COMMENT ON TABLE job_card_complaints IS
  'complaint = the customer''s own words. finding = what the technician found. Kept apart so delivery can prove the complaint raised was the one addressed.';

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM appointments;
  RAISE NOTICE '189: job card tables ready. % appointment(s) can now open one.', n;
END $$;

COMMIT;
