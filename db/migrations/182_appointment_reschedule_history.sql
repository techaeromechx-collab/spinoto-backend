-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 182: real reschedule history for appointments
--
-- WHAT WAS WRONG
-- ──────────────
-- Migration 072 is named "reschedule history" but stores a single snapshot:
-- original_scheduled_date, original_scheduled_time, rescheduled_by,
-- rescheduled_at — four columns on the appointment, overwritten on every move.
--
-- Move an appointment 10 Sep → 12 Sep → 15 Sep and the 10th is gone. The card
-- then reads "Original 12 Sep → New 15 Sep" and nothing anywhere records that
-- the customer was moved twice. A customer who says "you have changed my
-- appointment three times" cannot be checked, agreed with, or corrected.
--
-- WHY THE OLD COLUMNS STAY
-- ────────────────────────
-- They are not dropped. The appointment card, the list payload and anything
-- else already reading them keep working exactly as before — those four columns
-- now simply mean "the most recent move", which is what they have always
-- actually held. This table is the history beside them, not a replacement, so
-- nothing has to be migrated in the same breath as the schema.
--
-- ON DELETE CASCADE: deleting an appointment already nukes its whole chain
-- (estimate → PI → CI → claims) behind its own permission. History of a
-- deleted appointment has nothing left to describe.
--
-- from_* is nullable because an appointment created without a time and later
-- given one has no previous time to record. to_* is nullable for the same
-- reason in the other direction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS appointment_reschedules (
  id              SERIAL PRIMARY KEY,
  appointment_id  INTEGER     NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_date       DATE,
  from_time       TIME,
  to_date         DATE,
  to_time         TIME,
  reason          TEXT,
  notes           TEXT,
  rescheduled_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  rescheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every read of this table is "the moves for one appointment, in order", so the
-- index carries the sort column too and the query never touches the heap twice.
CREATE INDEX IF NOT EXISTS idx_appt_resched_appt
  ON appointment_reschedules (appointment_id, rescheduled_at);

COMMENT ON TABLE appointment_reschedules IS
  'One row per date/time move of an appointment. appointments.original_scheduled_* holds only the most recent move; this is the full history.';

-- ── Backfill the moves already recorded in the snapshot columns ──────────────
--
-- Only the LAST move of each appointment survives there, so this recovers one
-- row per appointment and no more. That is everything that still exists; the
-- earlier moves were overwritten before this table did.
--
-- NOT EXISTS rather than ON CONFLICT: there is no natural unique key here (an
-- appointment may legitimately be moved to the same slot twice), so the guard
-- is "this appointment has no history yet", which makes the migration
-- re-runnable without inventing a constraint that would forbid real data.
INSERT INTO appointment_reschedules
  (appointment_id, from_date, from_time, to_date, to_time, reason, notes, rescheduled_by, rescheduled_at)
SELECT a.id,
       a.original_scheduled_date,
       a.original_scheduled_time,
       a.scheduled_date,
       a.scheduled_time,
       a.reschedule_reason,
       a.reschedule_notes,
       a.rescheduled_by,
       COALESCE(a.rescheduled_at, a.updated_at, NOW())
  FROM appointments a
 WHERE a.original_scheduled_date IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM appointment_reschedules r WHERE r.appointment_id = a.id
   );

DO $$
DECLARE moved INT;
BEGIN
  SELECT COUNT(*) INTO moved FROM appointment_reschedules;
  RAISE NOTICE 'appointment_reschedules ready — % historic move(s) recovered from the snapshot columns.', moved;
END $$;
