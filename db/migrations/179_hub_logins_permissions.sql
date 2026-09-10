-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 179: give existing hub logins the Hub Partner permissions
--
-- Runs AFTER 178, which defines the role. The list is read FROM that role
-- rather than repeated here — one definition, and re-running 178 with a changed
-- set followed by this file is how the set is ever amended.
--
-- WHY EXISTING HUB LOGINS HAVE NONE
-- ─────────────────────────────────
-- Not a setting anybody chose. Hub logins are created from the Hubs page, and
-- that path (hubs.controller.js, createHubLogin) inserts the users row and
-- nothing else:
--
--     INSERT INTO users (name, email, password_hash, is_active,
--                        is_super_admin, hub_id) VALUES (...)
--
-- No role_id, no user_permissions. Settings -> Users cannot fix it either — it
-- lists `WHERE u.hub_id IS NULL`, so hub logins are not on that screen at all.
-- The controller patch that ships with this migration closes the source; this
-- file closes the backlog.
--
-- WHAT CHANGES FOR A HUB THE MOMENT THIS RUNS
-- ───────────────────────────────────────────
-- Zero permissions is NOT "no access": requirePermissionOrHub reads an empty
-- set as open access. Filling the set switches that fallback off, so every
-- OrHub route now demands an explicit code — which is why this grants the whole
-- verified set at once and not a subset. Checked against every
-- requirePermissionOrHub guard in routes/: 23 guards, 0 uncovered.
--
-- It also GRANTS two things hubs cannot do today. ADD_INVOICE_PAYMENT and
-- EDIT_APPOINTMENT sit behind plain requirePermission, which has no
-- zero-permission fallback, so a hub has been seeing a Record Payment button
-- whose POST returns 403.
--
-- TO UNDO, COMPLETELY:
--     DELETE FROM user_permissions
--      WHERE user_id IN (SELECT id FROM users WHERE hub_id IS NOT NULL);
--   Back to zero permissions, which is exactly today's behaviour.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  role_id_v  INT;
  n_users    INT;
  n_rows     INT;
BEGIN
  SELECT id INTO role_id_v FROM roles WHERE LOWER(name) = 'hub partner';

  IF role_id_v IS NULL THEN
    -- 178 defines it. Without it there is nothing to grant, and inventing a
    -- list here would create the second source of truth this avoids.
    RAISE EXCEPTION 'Role "Hub Partner" not found — run migration 178 first.';
  END IF;

  SELECT count(*) INTO n_users FROM users WHERE hub_id IS NOT NULL;

  -- Stamp the role so the hub's own record says which one it is on. The
  -- effective permissions are still the user_permissions rows below — role_id
  -- is a label, and the auth middleware never reads it.
  UPDATE users SET role_id = role_id_v, updated_at = NOW()
   WHERE hub_id IS NOT NULL AND role_id IS DISTINCT FROM role_id_v;

  -- ON CONFLICT DO NOTHING, so this is safe to re-run and safe on a hub that
  -- was granted by hand during testing. It ADDS; it never removes a permission
  -- somebody deliberately gave one workshop.
  INSERT INTO user_permissions (user_id, permission_code)
  SELECT u.id, p
    FROM users u
    CROSS JOIN LATERAL unnest(
      (SELECT permissions FROM roles WHERE id = role_id_v)
    ) AS p
   WHERE u.hub_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n_rows = ROW_COUNT;

  RAISE NOTICE 'Hub Partner applied to % hub login(s); % permission row(s) added.',
    n_users, n_rows;
END $$;
