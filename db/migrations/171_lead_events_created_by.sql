-- 171 — Who ASKED for this follow-up.
--
-- 170 recorded who completed a follow-up. This records who set one, which the
-- table has never held either. Between them the row can finally answer both
-- halves of "whose call was this".
--
-- ── WHY IT MATTERS SEPARATELY FROM done_by ──────────────────────────────────
--
-- The compliance report groups by COALESCE(l.assigned_to, l.created_by) — the
-- lead's owner. That is the right basis for "did you make your calls", because
-- the owner is who owes the call, and it is NOT changed here: rescoring a
-- report as a side effect of adding a column is how a number quietly stops
-- meaning what the person reading it thinks it means.
--
-- What was missing is the other question. A manager reviewing a lead can
-- schedule a follow-up on somebody else's lead; so can anybody with EDIT_LEAD.
-- The advisor then finds a chase in their list that they did not set, for a
-- reason they were not told, and there is no way — none, not in the timeline
-- either — to find out who put it there. That is the gap.
--
-- ── THE ROWS ALREADY IN THE TABLE ───────────────────────────────────────────
--
-- NULL, and not backfilled. The information was never captured, so there is
-- nothing to recover it from: lead_activities records the status change that
-- accompanied a follow-up, but not every follow-up has one and the times do not
-- reliably match. A join that is right most of the time is worse than a NULL
-- here — NULL reads as "not recorded", a wrong name reads as an accusation.

ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- SET NULL for the same reason as done_by in 170: offboarding somebody must not
-- delete the record that a follow-up existed.

COMMENT ON COLUMN lead_events.created_by IS
  'User who scheduled this follow-up. NULL for rows predating migration 171.';
