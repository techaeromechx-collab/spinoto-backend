-- 203_job_card_permissions.sql
--
-- The day-one grant for VIEW_JOB_CARD, EDIT_JOB_CARD, VIEW_INSPECTION and
-- EDIT_INSPECTION.
--
-- ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════
--
-- Until now the job card and inspection screens were gated on the APPOINTMENT
-- permissions. job_cards.routes.js now checks the four new codes and no longer
-- accepts the appointment ones, so without this migration everybody who works
-- on the floor loses those screens the moment it deploys.
--
-- This reproduces today's access exactly, using today's rule:
--
--     VIEW_APPOINTMENT or EDIT_APPOINTMENT or CREATE_APPOINTMENT
--         → could open a card and read its sheets
--         → gets VIEW_JOB_CARD + VIEW_INSPECTION
--
--     EDIT_APPOINTMENT or CREATE_APPOINTMENT
--         → could work on a card and fill sheets in
--         → gets EDIT_JOB_CARD + EDIT_INSPECTION
--
-- Nothing is removed. The appointment codes stay exactly as they are — they
-- still mean "may book and reschedule", which is what they always meant.
--
-- ══ BOTH PLACES, OR IT UNDOES ITSELF ═══════════════════════════════════════
--
-- A permission set lives in two tables and they are not copies of each other:
--
--   user_permissions   the live truth. auth.middleware.js reads this and
--                      nothing else, so this is what decides whether a request
--                      is refused tomorrow morning.
--   roles.permissions  the TEMPLATES, a TEXT[] per role. Applying a role
--                      rewrites a user's rows from this array
--                      (roles.controller.js). Backfilling only the first table
--                      would work until the first time somebody re-applied a
--                      role, which would then silently strip the new codes
--                      back out again.
--
-- ══ WHAT IS DELIBERATELY NOT TOUCHED ═══════════════════════════════════════
--
-- HUB LOGINS WITH NO PERMISSIONS AT ALL. requirePermissionOrHub lets a hub user
-- with zero rows through everything, and that is how most hub logins are set
-- up. Granting them these four codes would take their permission count from
-- zero to four and thereby flip them from "open access" to "strictly gated" on
-- all twelve route files that use requirePermissionOrHub — they would lose
-- estimates, invoices, customers, vehicles, technicians, checklists and chat on
-- Monday morning. They are left alone, which keeps them working; the WHERE
-- clauses below only ever match a user who already holds an appointment code.
--
-- SUPER ADMINS. is_super_admin bypasses every check in the middleware, so a row
-- would be noise.
--
-- Idempotent throughout: ON CONFLICT DO NOTHING on the rows, and the array
-- updates test for absence first, so a second run changes nothing.

BEGIN;

-- ── 1. The live per-user truth ──────────────────────────────────────────────
--
-- One INSERT ... SELECT per target code rather than a clever single statement:
-- the two source conditions differ, and a reader has to be able to check the
-- mapping against the comment above without unpicking a CASE.

INSERT INTO user_permissions (user_id, permission_code)
SELECT DISTINCT up.user_id, 'VIEW_JOB_CARD'
  FROM user_permissions up
 WHERE up.permission_code IN ('VIEW_APPOINTMENT', 'EDIT_APPOINTMENT', 'CREATE_APPOINTMENT')
ON CONFLICT DO NOTHING;

INSERT INTO user_permissions (user_id, permission_code)
SELECT DISTINCT up.user_id, 'VIEW_INSPECTION'
  FROM user_permissions up
 WHERE up.permission_code IN ('VIEW_APPOINTMENT', 'EDIT_APPOINTMENT', 'CREATE_APPOINTMENT')
ON CONFLICT DO NOTHING;

INSERT INTO user_permissions (user_id, permission_code)
SELECT DISTINCT up.user_id, 'EDIT_JOB_CARD'
  FROM user_permissions up
 WHERE up.permission_code IN ('EDIT_APPOINTMENT', 'CREATE_APPOINTMENT')
ON CONFLICT DO NOTHING;

INSERT INTO user_permissions (user_id, permission_code)
SELECT DISTINCT up.user_id, 'EDIT_INSPECTION'
  FROM user_permissions up
 WHERE up.permission_code IN ('EDIT_APPOINTMENT', 'CREATE_APPOINTMENT')
ON CONFLICT DO NOTHING;

-- ── 2. The role templates ───────────────────────────────────────────────────
--
-- array_append rather than an array literal, so a role's existing order and any
-- codes this migration knows nothing about are preserved. The NOT ... = ANY
-- guard is what makes a re-run a no-op instead of appending a duplicate.

UPDATE roles
   SET permissions = array_append(permissions, 'VIEW_JOB_CARD')
 WHERE permissions && ARRAY['VIEW_APPOINTMENT', 'EDIT_APPOINTMENT', 'CREATE_APPOINTMENT']
   AND NOT ('VIEW_JOB_CARD' = ANY(permissions));

UPDATE roles
   SET permissions = array_append(permissions, 'VIEW_INSPECTION')
 WHERE permissions && ARRAY['VIEW_APPOINTMENT', 'EDIT_APPOINTMENT', 'CREATE_APPOINTMENT']
   AND NOT ('VIEW_INSPECTION' = ANY(permissions));

UPDATE roles
   SET permissions = array_append(permissions, 'EDIT_JOB_CARD')
 WHERE permissions && ARRAY['EDIT_APPOINTMENT', 'CREATE_APPOINTMENT']
   AND NOT ('EDIT_JOB_CARD' = ANY(permissions));

UPDATE roles
   SET permissions = array_append(permissions, 'EDIT_INSPECTION')
 WHERE permissions && ARRAY['EDIT_APPOINTMENT', 'CREATE_APPOINTMENT']
   AND NOT ('EDIT_INSPECTION' = ANY(permissions));

-- ── 3. Say what happened ────────────────────────────────────────────────────
--
-- A migration that silently grants permissions is a migration nobody can audit
-- afterwards. These counts go into the deploy log, where "why can Ramesh open
-- job cards" has an answer six months from now.

DO $$
DECLARE
  n_users INT;
  n_roles INT;
BEGIN
  SELECT COUNT(DISTINCT user_id) INTO n_users
    FROM user_permissions
   WHERE permission_code IN ('VIEW_JOB_CARD', 'EDIT_JOB_CARD',
                             'VIEW_INSPECTION', 'EDIT_INSPECTION');
  SELECT COUNT(*) INTO n_roles
    FROM roles
   WHERE permissions && ARRAY['VIEW_JOB_CARD', 'EDIT_JOB_CARD',
                              'VIEW_INSPECTION', 'EDIT_INSPECTION'];
  RAISE NOTICE '[203] % user(s) and % role(s) now hold at least one job-card permission.',
    n_users, n_roles;
  RAISE NOTICE '[203] Hub logins with no permissions at all were deliberately left alone — they keep open access.';
END $$;

COMMIT;
