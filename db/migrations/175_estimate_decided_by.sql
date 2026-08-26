-- 175_estimate_decided_by.sql
--
-- Who, inside the CRM, recorded the customer's decision.
--
-- ══ THE GAP ════════════════════════════════════════════════════════════════
--
-- Migration 118 added the evidence columns for a customer decision and said
-- what they were for, in its own words:
--
--   "Evidence, not analytics. 'Someone approved ₹15,000 of work and it wasn't
--    me' is answerable with these and unanswerable without them."
--
-- It defined decision_source as 'customer_link' | 'staff'. The public route
-- writes all of it — source, timestamp, comment, IP, user agent. The in-app
-- route (POST /api/estimates/:id/customer-approval) writes NONE of it: it
-- applies the item approvals and returns.
--
-- So the question 118 set out to answer is still unanswerable for exactly the
-- half where it matters most. An estimate approved by an advisor and one
-- approved by the customer are byte-identical, on the document that authorises
-- both the work and the bill.
--
-- ══ WHY A NEW COLUMN AND NOT JUST IP ═══════════════════════════════════════
--
-- 118's IP and user-agent identify a stranger on a phone, which is the right
-- evidence for a public link. They identify nobody inside an office: every
-- advisor shares one WAN address and a similar browser. For the staff path the
-- only meaningful evidence is the user id, which is why warranty_claims has
-- carried decided_by since migration 089. Same column, same reason.
--
-- ══ WHAT decision_source WILL AND WILL NOT SAY ═════════════════════════════
--
-- The controller sets decision_source ONLY when it is currently NULL, so it
-- keeps naming whoever decided FIRST. Staff are allowed to re-record a decision
-- afterwards (the endpoint accepts partially_approved, fully_approved and
-- work_in_progress — a customer changing their mind mid-job is a real thing),
-- and overwriting 'customer_link' with 'staff' on that second pass would erase
-- the fact that the customer ever decided at all.
--
-- decided_by and decided_at therefore mean "who last recorded a decision", and
-- decision_source means "who made the first one". Two different questions, and
-- both get asked when a bill is disputed.

BEGIN;

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES users(id);

COMMENT ON COLUMN estimates.decided_by IS
  'The CRM user who last recorded a customer decision on this estimate. NULL when the only decision came through the customer link - that one is evidenced by decision_ip and decision_ua instead. See decision_source for who decided FIRST.';

-- No backfill, deliberately.
--
-- Every decision recorded in the CRM before this migration was made by somebody
-- whose identity was never captured. Filling the column with a guess — the
-- estimate's creator, the last person to touch it — would turn "we do not know"
-- into a name, and a name in an evidence column is something somebody will one
-- day be asked to answer for. NULL is the honest answer and stays.

COMMIT;
