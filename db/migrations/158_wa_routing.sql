-- Migration 158: route an inbound WhatsApp lead to a specific CRM user.
--
-- ── The problem ─────────────────────────────────────────────────────────────
--
-- A WhatsApp lead is created by the webhook, so created_by is NULL and nobody
-- is assigned. Every visibility filter in leads.controller.js keys off exactly
-- those two columns, which means an auto-created lead is an unowned pile to an
-- admin and INVISIBLE to anyone on VIEW_OWN_LEADS or VIEW_TEAM_LEADS. Two
-- advisors answer the same customer, or nobody does.
--
-- ── Why a new table and not users.department ────────────────────────────────
--
-- department is an HR field off the departments master (Sales, Support,
-- Operations…). Routing on it means the day somebody's department changes for
-- payroll reasons, WhatsApp routing changes with it, silently, with nothing on
-- that screen saying so.
--
-- This project already made that mistake once: migration 047 wired lead routing
-- to is_pipeline, a REPORTING flag, and the two drifted. Routing gets its own
-- table with its own screen.

BEGIN;

-- ── Which flow answers exist ────────────────────────────────────────────────
--
-- A table rather than a hardcoded list, because these strings live in the
-- Interakt flow, not in this codebase. Editing the flow must not require a
-- deploy — it must require ticking a box.
CREATE TABLE IF NOT EXISTS wa_categories (
  id         SERIAL PRIMARY KEY,
  -- Compared to the customer's answer with TRIM + LOWER. Interakt's own payload
  -- has "Car " with a trailing space, so an exact match would already be broken
  -- on day one.
  name       VARCHAR(80) NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_categories_name
  ON wa_categories (LOWER(TRIM(name)));

-- The three the Welcome flow asks first. Seeded so the screen is not empty on
-- first open; editable like anything else.
INSERT INTO wa_categories (name, sort_order)
SELECT v.name, v.ord FROM (VALUES
  ('Bike/Scooter', 1),
  ('Car',          2),
  ('Support/Help', 3)
) AS v(name, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM wa_categories c WHERE LOWER(TRIM(c.name)) = LOWER(TRIM(v.name))
);

-- ── Who handles what ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_agents (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The category names this user takes. An array rather than a join table on
  -- purpose: it is read on every inbound message and written only when somebody
  -- opens the settings screen, it is never queried FROM the category side, and
  -- three checkboxes per user is not a relationship worth a third table.
  handles          TEXT[]      NOT NULL DEFAULT '{}',

  -- Round-robin skips anyone off. Unticked at the end of a shift, ticked in the
  -- morning — otherwise a lead is handed to someone who is not there, and a
  -- lead with a name on it looks handled when it is not.
  on_duty          BOOLEAN     NOT NULL DEFAULT TRUE,

  -- The whole round-robin. Not a counter and not a pointer: "whoever was given
  -- a lead longest ago goes next". NULL means never assigned, which sorts
  -- first, so a newly added agent gets the next lead rather than the last.
  -- Self-correcting when someone is added, removed, or goes off duty mid-day.
  last_assigned_at TIMESTAMPTZ,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The picker filters on these two before it sorts.
CREATE INDEX IF NOT EXISTS idx_wa_agents_duty
  ON wa_agents (on_duty, last_assigned_at NULLS FIRST);

COMMENT ON COLUMN wa_agents.last_assigned_at IS
  'Round-robin cursor. The eligible agent with the oldest value gets the next lead; NULL sorts first so a new agent goes next, not last.';

-- ── Did routing actually do this, or did a person fix it by hand? ───────────
--
-- Without this, "is the routing working?" is unanswerable in a month — every
-- lead just has a name on it and no record of how it got there.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assignment_source VARCHAR(12);

COMMENT ON COLUMN leads.assignment_source IS
  'How assigned_to was set: auto (WhatsApp routing), reply (the first advisor to answer claimed it), manual (a person chose). NULL for leads assigned before migration 158.';

COMMIT;
