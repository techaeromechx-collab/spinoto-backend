-- ════════════════════════════════════════════════════════════════════════════
-- 205 — when did this customer last reach out to us
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── The thing that was broken ───────────────────────────────────────────────
--
-- An Interakt message from a number that already has an OPEN lead is attached
-- to that lead — correctly, waInboundLead.service.js has done this since it was
-- written. What it never did was touch the lead itself. So:
--
--   a lead made on 5 July, worked, still open
--   the customer messages again today
--   → the message lands, the conversation shows it
--   → the LEAD still says 5 July, and the list sorts on created_at
--   → it stays on page 5, where nobody looks
--
-- The most valuable lead on the board — somebody who already has a quotation
-- and is asking again — was the one buried deepest.
--
-- ── Why a column of its own, and not updated_at ─────────────────────────────
--
-- updated_at moves when ANYBODY edits ANYTHING: a note, a status, a typo fix.
-- It answers "was this record touched", which is a question about us. This
-- column answers "did the customer come back", which is a question about them,
-- and it is the only one worth sorting a work queue by. Sorting on updated_at
-- would float leads our own team just edited to the top — noise, every time
-- somebody fixes a spelling.
--
-- ── Why not overwrite created_at ────────────────────────────────────────────
--
-- Because it is a fact. "When did this lead come into the business" feeds the
-- funnel reports, the source attribution and every month-on-month count. Moving
-- it would make a July lead look like an October one and quietly rewrite the
-- history of how many leads each month produced.
--
-- NULL means "has never messaged again", which is most rows and is not a gap to
-- be filled. The list sorts on GREATEST(created_at, last_enquiry_at) so a NULL
-- simply leaves the lead where its creation date puts it.
-- ════════════════════════════════════════════════════════════════════════════

-- ── No BEGIN/COMMIT in this file, deliberately ──────────────────────────────
-- backend/db/migrate.js already wraps each migration in its own transaction.
-- Migrations 201-204 each opened a second one, and Postgres answers that with
-- "there is already a transaction in progress" and then — worse — the inner
-- COMMIT ends the RUNNER's transaction early, so everything after it in the
-- file is no longer covered by the rollback-on-error guarantee. This file does
-- not repeat that.
--
-- One operational note: CREATE INDEX (not CONCURRENTLY, because it cannot run
-- inside a transaction) takes a write lock on `leads` while it builds. At this
-- table's size that is a blink; it is worth knowing before running it at 11am.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_enquiry_at TIMESTAMPTZ;

COMMENT ON COLUMN leads.last_enquiry_at IS
  'When this customer last reached out on an inbound channel (WhatsApp today). '
  'NULL until they come back. Never backfilled: the inbound history lives in '
  'wa_messages, and inventing a value here from it would claim a re-enquiry was '
  'noticed on a day nobody saw it. Set by waInboundLead.service.js; the leads '
  'list sorts on GREATEST(created_at, last_enquiry_at).';

-- ── The index the new default sort needs ────────────────────────────────────
-- The list orders by GREATEST(created_at, last_enquiry_at) DESC, and an
-- expression index is the only kind Postgres can use for that — a plain index
-- on either column alone is useless to it. Without this the default view of the
-- leads page becomes a sort of the whole table on every page load.
--
-- COALESCE inside, because GREATEST returns NULL in some versions when any
-- argument is NULL, and most rows have a NULL here. The controller's ORDER BY
-- must match this expression CHARACTER FOR CHARACTER or the planner will not
-- use the index — if you change one, change both.
--
-- The NULLS clauses are NOT decoration, and they are deliberately DIFFERENT on
-- the two columns. The controller writes exactly:
--
--     ORDER BY <expr> DESC NULLS LAST, l.id DESC
--
-- NULLS LAST on the first key (it applies to every sort the page offers, so an
-- unnamed lead sinks in a name sort instead of heading the list) and nothing on
-- the second, which means id falls back to Postgres's DESC default of NULLS
-- FIRST. An index has to match that key for key or the planner treats it as
-- unsorted and sorts the whole table anyway — the index would exist and never
-- be used. Verified with EXPLAIN: this declaration gives a plain Index Scan
-- with no sort node; declaring NULLS LAST on id as well degrades it to an
-- Incremental Sort.
--
-- Neither value can actually BE null (leads.created_at is NOT NULL, id is the
-- primary key), so none of this changes a single row's position. It only makes
-- the declaration say what the query says.
CREATE INDEX IF NOT EXISTS idx_leads_last_activity
  ON leads (GREATEST(created_at, COALESCE(last_enquiry_at, created_at)) DESC NULLS LAST,
            id DESC);

-- Partial, for the "show me only the ones who came back" filter. Tiny, because
-- it indexes only the rows that have a value.
CREATE INDEX IF NOT EXISTS idx_leads_has_enquiry
  ON leads (last_enquiry_at DESC)
  WHERE last_enquiry_at IS NOT NULL;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  has_col  BOOLEAN;
  has_idx  INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'leads' AND column_name = 'last_enquiry_at'
  ) INTO has_col;

  SELECT COUNT(*) INTO has_idx
    FROM pg_indexes
   WHERE tablename = 'leads'
     AND indexname IN ('idx_leads_last_activity', 'idx_leads_has_enquiry');

  IF NOT has_col THEN
    RAISE EXCEPTION '[205] leads.last_enquiry_at was not created';
  END IF;
  IF has_idx <> 2 THEN
    RAISE EXCEPTION '[205] expected 2 indexes, found %', has_idx;
  END IF;

  RAISE NOTICE '[205] leads.last_enquiry_at added, 2 indexes in place.';
  RAISE NOTICE '[205] Every existing row is NULL — nothing is backfilled, and the '
               'list leaves those leads exactly where their created_at puts them.';
END $$;
