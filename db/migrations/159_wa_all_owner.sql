-- Migration 159: one user handles every WhatsApp lead.
--
-- ── What it is for ──────────────────────────────────────────────────────────
--
-- A single switch that says "Raj takes all of them". The categories and the
-- round-robin stop applying while it is on; every inbound WhatsApp lead goes to
-- that one person. Turning it off restores the rota exactly as it was, because
-- nothing about the rota is deleted — it is simply skipped.
--
-- ── Why a column with a partial unique index, and not a setting ─────────────
--
-- The tempting home is integration_settings, a key/value table already used by
-- this screen. It is the wrong home twice over: that table exists for provider
-- CREDENTIALS — its own comment says values never leave the backend and its
-- endpoints mask to last4 — and a setting holding a user id there would have a
-- dangling reference the moment that user was deleted.
--
-- Here the constraint IS the feature. A partial unique index over a constant
-- makes "at most one row has this" a rule the database enforces, not a rule the
-- application remembers to enforce. Two admins ticking two different people in
-- the same second get one winner and one error, rather than two owners and a
-- rota that silently picks whichever row the planner returned first.
--
-- And ON DELETE CASCADE from wa_agents.user_id already handles the deleted-user
-- case: the row goes, the mode goes with it, and routing falls back to the rota.

BEGIN;

ALTER TABLE wa_agents
  ADD COLUMN IF NOT EXISTS takes_all BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN wa_agents.takes_all IS
  'This user receives EVERY inbound WhatsApp lead; categories and round-robin are skipped. At most one user can have it — enforced by idx_wa_agents_takes_all. Ignored if they are off duty or deactivated, which falls back to the normal rota.';

-- (true) rather than (takes_all): indexing the constant is what limits the
-- WHOLE PARTITION to a single row. Indexing the column would only make the
-- value unique among rows that have it — which, since they are all TRUE, is the
-- same thing here, but says it by accident rather than on purpose.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_agents_takes_all
  ON wa_agents ((TRUE))
  WHERE takes_all;

COMMENT ON INDEX idx_wa_agents_takes_all IS
  'At most one user can be the all-leads owner. Two admins setting it at once get one winner and one error, instead of two owners.';

COMMIT;
