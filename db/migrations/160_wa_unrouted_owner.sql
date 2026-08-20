-- Migration 160: who takes a WhatsApp lead that never chose an option.
--
-- ── The hole this fills ─────────────────────────────────────────────────────
--
-- Routing has always been keyed on the customer's answer to the Interakt flow —
-- Bike/Scooter, Car, Support/Help. A customer who simply types "Interested" and
-- never taps anything produces no answer, so there is no category, so the rota
-- has nothing to sort on and the lead is left unassigned.
--
-- That was defensible when it was the rare case. It is not the rare case: the
-- flow only greets people it recognises as a new conversation, and anyone
-- replying to an old thread, answering a campaign, or just typing a sentence
-- lands here. Those leads sat in the Unassigned queue with nobody's name on
-- them and no rule that would ever put one there.
--
-- ── Why a named person and not round-robin ──────────────────────────────────
--
-- Round-robin needs a category to divide on. Dividing the uncategorised leads
-- across everyone spreads them thin and gives each advisor a trickle of
-- enquiries they know nothing about. One person who has agreed to triage them
-- can read the message, work out what it is, and hand it on. Chosen on the
-- settings screen rather than assumed, because it is a duty somebody accepts,
-- not a fact about the data.
--
-- ── Why this mirrors takes_all rather than reusing it ───────────────────────
--
-- They answer two different questions and are on at different times:
--
--   takes_all       "the rota is off today, everything comes to me"
--   takes_unrouted  "the rota is on, and I mop up what it cannot sort"
--
-- One column with two meanings would make "am I covering, or am I triaging?"
-- unanswerable. And the same person can legitimately hold both — a solo owner
-- covering a quiet week — which one column could not express.
--
-- The partial unique index over a constant is the same trick migration 159
-- uses: it makes "at most one row has this" a rule Postgres enforces, so two
-- admins choosing two different people in the same second get one winner and
-- one error rather than two owners and a coin toss.

BEGIN;

ALTER TABLE wa_agents
  ADD COLUMN IF NOT EXISTS takes_unrouted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN wa_agents.takes_unrouted IS
  'This user receives inbound WhatsApp leads that no category could be worked out for - typically a plain free-text first message. Consulted only after takes_all, continuity and the category rota have all found nobody. At most one user can have it (idx_wa_agents_takes_unrouted). Ignored if they are off duty or deactivated, which leaves the lead unassigned as before.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_agents_takes_unrouted
  ON wa_agents ((TRUE))
  WHERE takes_unrouted;

COMMENT ON INDEX idx_wa_agents_takes_unrouted IS
  'At most one user can be the fallback owner. Two admins setting it at once get one winner and one error, instead of two owners.';

-- ── The word that goes in leads.assignment_source ───────────────────────────
--
-- 'fallback' rather than another 'auto', and the distinction is load-bearing
-- rather than cosmetic. It is the flag that says "this owner was a guess" —
-- and it is what permits the lead to be moved later, once the customer's answer
-- finally arrives and names a category the guess does not handle. A lead marked
-- 'auto' was routed on real information and is never moved; a lead marked
-- 'manual' was chosen by a person and is never moved. Only 'fallback' is
-- provisional, and it stops being provisional the moment it is confirmed.
--
-- Fits the existing VARCHAR(12) with room to spare, so no widening is needed.
COMMENT ON COLUMN leads.assignment_source IS
  'How assigned_to was set: auto (WhatsApp routing on a real signal - all-leads owner, continuity, or category), fallback (the fallback owner took it because no category was known yet - provisional, and may be moved once a category arrives), reply (the first advisor to answer claimed it), manual (a person chose). NULL for leads assigned before migration 158.';

COMMIT;
