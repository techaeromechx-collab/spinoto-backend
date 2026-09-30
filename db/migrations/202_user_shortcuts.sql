-- 202_user_shortcuts.sql
--
-- Per-user keyboard shortcut overrides.
--
-- ══ WHY A COLUMN ON users AND NOT localStorage ═════════════════════════════
--
-- The entire value of retraining a shortcut is muscle memory, and muscle memory
-- that stops working when somebody sits at the workshop PC is worse than no
-- shortcut at all. It has to follow the account, not the browser.
--
-- A column rather than a table because it is exactly one row per user with no
-- history to keep and nothing to join to — the same shape, and the same
-- reasoning, as users.notification_settings, which is already here.
--
-- ══ ONLY THE OVERRIDES, NEVER THE WHOLE MAP ════════════════════════════════
--
-- The defaults live in frontend/src/lib/shortcuts.js. This column holds only
-- what somebody has deliberately changed:
--
--     {"nav:/leads": "alt+k", "action:new": ""}
--
-- Storing the resolved map instead would freeze today's defaults into every
-- user's row on their first save, and no default could ever be improved again —
-- a better key for Estimates would reach only accounts created after the
-- change. An empty string is a real value and means "unbound on purpose",
-- which is not the same as absent.
--
-- ══ NOT VALIDATED HERE ═════════════════════════════════════════════════════
--
-- No CHECK on the contents. The set of bindable things is NAV_ITEMS, which is a
-- frontend concept, and a CHECK constraint listing routes would be a third copy
-- of the sidebar that nobody would remember to update — the exact failure
-- utils/leadScope.js documents. Shape and size are enforced in me.routes.js,
-- where the reserved-combination list already lives.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS shortcuts JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.shortcuts IS
  'Keyboard shortcut OVERRIDES only, as {"nav:/leads":"alt+k"}. Defaults live '
  'in frontend/src/lib/shortcuts.js and are deliberately not copied here, so '
  'improving a default still reaches everybody who never changed it. An empty '
  'string value means deliberately unbound; an absent key means "use the '
  'default". Shape and size are validated in routes/me.routes.js.';

COMMIT;
