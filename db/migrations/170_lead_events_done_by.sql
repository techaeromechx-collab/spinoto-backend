-- 170 — Tell a follow-up somebody DID from a follow-up that just expired.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- Two completely different things write the same two columns:
--
--   PATCH /lead-events/:id/done   an advisor ticked it: "I called them"
--   any status change             the code closed it because the follow-up was
--                                 attached to a status the lead has left
--
-- Both do `SET is_done = TRUE, done_at = NOW()` and nothing else. So the row
-- afterwards is byte-identical, and every number built on it counts them as the
-- same event:
--
--   getCompliance  on_time  = done_at::date <= due_date
--                  late     = done_at::date >  due_date
--   getStats       completed, completion_rate, avg_response_days
--
-- Which means a CSV import that updates 400 statuses closes 400 follow-ups and
-- books every one of them as "completed" — on_time for any that were not yet
-- due. Nobody called anybody. The compliance rate only ever moves up, and the
-- per-agent breakdown moves up for whoever happens to be assigned.
--
-- ── WHY TWO COLUMNS AND NOT ONE ─────────────────────────────────────────────
--
-- auto_closed answers "was this work or expiry" — that is the one the reports
-- need. done_by answers "who", which the table has never recorded at all: not
-- for the auto path and not for the manual one either. A follow-up marked done
-- by the wrong person is currently unfindable, and it is the same one-line fix
-- while we are here.
--
-- ── THE ROWS ALREADY IN THE TABLE ───────────────────────────────────────────
--
-- Not backfilled, because they CANNOT be. Every historical done row has the
-- same shape whichever path closed it — that is the entire bug — so there is no
-- rule that separates them and any guess would be fiction presented as data.
--
-- They therefore land as auto_closed = FALSE, i.e. counted as genuinely
-- completed, exactly as they are counted today. This migration does not correct
-- history; it makes history stop accumulating. The compliance figure becomes
-- trustworthy for follow-ups closed from here on, and stays as optimistic as it
-- always was for the ones before. Say so out loud rather than let somebody
-- discover the seam later and distrust the whole number.

ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT FALSE;

-- ON DELETE SET NULL, not CASCADE. Deleting a user must not delete the record
-- that a follow-up happened — the lead's history is the customer's, not the
-- employee's, and CASCADE here would quietly rewrite a month of compliance
-- figures the day somebody offboards.

COMMENT ON COLUMN lead_events.done_by IS
  'User who explicitly marked this follow-up done. NULL when auto_closed, and '
  'NULL for every row predating migration 170.';

COMMENT ON COLUMN lead_events.auto_closed IS
  'TRUE when the follow-up was closed by a status change / appointment booking '
  'rather than by somebody completing it. Excluded from compliance and stats.';

-- The compliance and stats queries filter on (is_done, auto_closed) over the
-- whole table with no date bound, so this is the index they actually want.
-- Partial on is_done = TRUE: the pending side is already served by
-- idx_lead_events_due (due_date, is_done) from migration 037.
CREATE INDEX IF NOT EXISTS idx_lead_events_done_auto
  ON lead_events (auto_closed) WHERE is_done = TRUE;
