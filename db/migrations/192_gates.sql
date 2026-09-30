-- Migration 192: the compliance gates and the gate pass.
--
-- ══ WHAT IS NOT IN HERE, AND WHY ═══════════════════════════════════════════
--
-- Four of the five gates are COMPUTED and none of them is stored. A gate says
-- "every complaint has a finding" or "a pre-delivery check is completed" — the
-- answer is already in job_card_complaints and job_card_inspections, and
-- copying it into a column would mean two places that can disagree about
-- whether a car may be handed over. The first time somebody edits a complaint
-- after the gate was stored, the stored answer is a lie with a timestamp on it.
--
-- So the gates are recomputed on every read. Only two things need rows:
--
--   1. the ONE gate a machine cannot answer — did a human look at the old
--      parts next to the new ones
--   2. an override — a super admin deciding to let a car go with a gate red
--
-- ══ THE ORDER THE PLAN COULD NOT HAVE ══════════════════════════════════════
--
-- The plan asked for "no invoice until the card reaches ready" AND for
-- "estimate approved and invoice generated" to be one of the gates that makes
-- it ready. Those cannot both hold: the car would never leave.
--
-- Resolved by splitting the gates across the two transitions they actually
-- belong to, which is also the order a workshop floor works in:
--
--   → ready       quality check, complaints answered, parts inspected, photos
--   invoicing     allowed once the card is ready (phase 5b)
--   → delivered   billing green, and a gate pass issued
--
-- ══ NOTHING IN FLIGHT BREAKS ═══════════════════════════════════════════════
--
-- Every gate is scoped to a job card. An appointment with no job card keeps
-- today's behaviour exactly, which is the whole reason this can be deployed on
-- a working Tuesday.

BEGIN;

-- ── The manual gate, and any override ──────────────────────────────────────
-- One row per (card, gate) holding CURRENT state. The audit trail is
-- job_card_activities, which already records every change with who and when —
-- a second append-only log here would be the same facts in two shapes.
CREATE TABLE IF NOT EXISTS job_card_gate_checks (
  id           SERIAL PRIMARY KEY,
  job_card_id  INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

  gate         TEXT NOT NULL CHECK (gate IN (
                 'quality_check', 'job_card_verification',
                 'parts_inspection', 'media_upload', 'billing')),

  -- 'passed'     a human confirmed the manual check
  -- 'overridden' a super admin let a red gate through, with a reason
  state        TEXT NOT NULL CHECK (state IN ('passed', 'overridden')),

  -- Required for 'overridden' — enforced in the controller, because a CHECK
  -- constraint here would give the user a constraint name instead of a
  -- sentence. The reason is the only thing that makes an override reviewable.
  reason       TEXT,
  -- The old-vs-new parts photograph. Optional: a hub without a camera to hand
  -- must still be able to confirm it looked.
  photo_url    TEXT,

  checked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (job_card_id, gate)
);
CREATE INDEX IF NOT EXISTS idx_jc_gates ON job_card_gate_checks (job_card_id);

-- ── The gate pass ──────────────────────────────────────────────────────────
-- The piece of paper the security guard at the gate actually looks at.
--
-- SNAPSHOTS the readings, like an inspection does. odometer_out lives on
-- job_cards and can be corrected afterwards; what the pass SAID when the car
-- drove out must not change with it, because the pass is the thing both sides
-- relied on.
--
-- No new sequence: the number is the job card's own, with a suffix. A second
-- counter to maintain, reset and reconcile earns nothing here — there is
-- exactly one pass per card.
CREATE TABLE IF NOT EXISTS job_card_gate_passes (
  id             SERIAL PRIMARY KEY,
  job_card_id    INTEGER NOT NULL UNIQUE REFERENCES job_cards(id) ON DELETE CASCADE,
  pass_no        TEXT NOT NULL UNIQUE,

  odometer_out   INTEGER,
  fuel_out       SMALLINT CHECK (fuel_out BETWEEN 0 AND 4),
  items_total    INTEGER NOT NULL DEFAULT 0,
  items_returned INTEGER NOT NULL DEFAULT 0,

  -- The customer signature this pass was issued against. SET NULL rather than
  -- CASCADE: deleting a signature is a super-admin act that must not silently
  -- delete the gate pass along with it.
  signature_id   INTEGER REFERENCES job_card_signatures(id) ON DELETE SET NULL,

  notes          TEXT,
  issued_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jc_gatepass ON job_card_gate_passes (job_card_id);

-- ── Section toggles ────────────────────────────────────────────────────────
-- `gates` controls whether the PANEL is shown, not whether the gates are
-- ENFORCED. A hub that could switch the enforcement off would be a hub with no
-- enforcement, and the checks exist precisely because somebody under pressure
-- wants to skip them. Turning them off is a super-admin override, per card,
-- with a reason — never a setting.
UPDATE job_card_settings
   SET sections = sections || '{"gates": true, "gate_pass": true}'::jsonb,
       updated_at = NOW()
 WHERE NOT (sections ? 'gates');

COMMENT ON TABLE job_card_gate_checks IS
  'Only the manual gate and overrides are stored. The other four gates are computed on every read - a stored computed value is a lie the moment the data behind it changes.';
COMMENT ON COLUMN job_card_gate_checks.reason IS
  'Required when state = overridden. Enforced in the controller so the user gets a sentence rather than a constraint name.';
COMMENT ON TABLE job_card_gate_passes IS
  'Snapshots the readings as they stood when the vehicle left. job_cards.odometer_out can be corrected later; what the pass said must not change with it.';

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM job_cards;
  RAISE NOTICE '192: gates and gate pass ready. % job card(s) now gated; appointments without one are untouched.', n;
END $$;

COMMIT;
