-- Migration 162: actually create the two statuses migration 161 points at.
--
-- ── Why this is a second migration and not an edit to 161 ───────────────────
--
-- db/migrate.js records applied migrations by FILENAME. Editing 161 after it
-- has run on a database changes nothing there and quietly leaves two
-- installations behaving differently — the worst outcome available. A new file
-- runs everywhere, once.
--
-- ── Why seed at all, having deliberately not seeded ─────────────────────────
--
-- 161 shipped inert on purpose: two flags, nothing ticked, no behaviour change
-- until somebody chose where returning customers should land. Defensible, and
-- wrong in practice. "Add two statuses and tick the boxes" is four screens of
-- work to switch on a feature that has exactly one sensible configuration, and
-- until it is done the feature looks like it did not install.
--
-- So the statuses are created and ticked here. They can be renamed, recoloured
-- or unticked afterwards like anything else on that screen — and renaming them
-- is safe, because the code reads the flag and never the name.
--
-- ── Both halves are guarded, and against different things ───────────────────
--
--   the INSERT   against a name that already exists, in any spelling. Somebody
--                who read the release note and made "Re-enquiry" by hand this
--                morning must not end up with two of them.
--   the UPDATE   against a choice already made. If a status already holds a
--                flag, that was a decision, and a migration that overrode it
--                would be a migration that undid somebody's work overnight.
--
-- The second guard is also what keeps the partial unique indexes from 161
-- happy: at most one row may hold each flag, and this refuses to be the second.

BEGIN;

-- ── The two statuses ────────────────────────────────────────────────────────
--
-- Not is_closed: a returning customer is the opposite of finished.
-- is_pipeline TRUE: this is live money and belongs in the dashboard figure.
-- needs_follow_up FALSE deliberately — ticking it would pop a scheduling form
-- open every time one of these leads is touched, which is a decision for the
-- person running the desk, not for a migration.
INSERT INTO lead_statuses (name, color, bg_color, sort_order, is_pipeline, is_closed)
SELECT v.name, v.color, v.bg,
       COALESCE((SELECT MAX(sort_order) FROM lead_statuses), 0) + v.ord,
       TRUE, FALSE
  FROM (VALUES
    -- Purple, next to Retargeting: a lead you already chased once.
    ('Re-Enquiry',      '#7c3aed', '#ede9fe', 1),
    -- Teal, next to Quotation Shared: somebody who has already paid you.
    ('Repeat Customer', '#0f766e', '#ccfbf1', 2)
  ) AS v(name, color, bg, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM lead_statuses ls
    WHERE LOWER(TRIM(ls.name)) = LOWER(TRIM(v.name))
 );

-- ── Point the flags at them, unless somebody already chose ──────────────────
UPDATE lead_statuses
   SET is_reenquiry = TRUE
 WHERE LOWER(TRIM(name)) = 're-enquiry'
   AND NOT EXISTS (SELECT 1 FROM lead_statuses x WHERE x.is_reenquiry);

UPDATE lead_statuses
   SET is_repeat_customer = TRUE
 WHERE LOWER(TRIM(name)) = 'repeat customer'
   AND NOT EXISTS (SELECT 1 FROM lead_statuses x WHERE x.is_repeat_customer);

COMMIT;
