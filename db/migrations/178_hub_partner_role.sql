-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 178: a real permission set for hub-portal logins
--
-- WHY THIS EXISTS
-- ───────────────
-- Hub users have been running on ZERO permissions, which is not "no access" —
-- requirePermissionOrHub (middleware/auth.middleware.js) reads an empty
-- permission set as "open access" and waves them through every route guarded
-- that way:
--
--     if (req.user.permissions.size === 0) return next();
--
-- That has two consequences nobody chose:
--
--   1. Routes guarded by plain requirePermission — which has NO such fallback —
--      are refused. Recording an invoice payment (ADD_INVOICE_PAYMENT) and
--      editing an appointment (EDIT_APPOINTMENT) are both in that category, so
--      a hub has been seeing buttons whose POST would 403.
--
--   2. The moment a hub is given ANY permission, the fallback switches off and
--      EVERY OrHub route starts demanding an explicit code. So a role cannot be
--      built up one permission at a time — the first one added takes the rest
--      away. It has to arrive complete, which is what this is.
--
-- WHAT THIS MIGRATION DOES AND DOES NOT DO
-- ────────────────────────────────────────
-- It creates (or refreshes) the ROLE only. It assigns it to NOBODY.
--
-- Effective permissions live in user_permissions, one row per user; this role
-- is the definition those rows are copied from. Nothing changes for any login
-- until migration 179 runs.
--
-- NOT via Settings -> Users. That screen lists `WHERE u.hub_id IS NULL`, so hub
-- logins are not on it — they are created and managed from the Hubs page
-- (POST /api/hubs/:id/login). Which is also why they have no permissions today:
-- that insert writes a users row and nothing else.
--
-- COVERAGE
-- ────────
-- Verified against every requirePermissionOrHub guard in routes/ — 23 guards,
-- 0 uncovered. Each guard passes on ANY one of its listed codes, so the set
-- below is the minimum that satisfies all of them, not a copy of their union.
--
-- DELIBERATELY ABSENT
-- ───────────────────
--   VIEW_LEAD          — grants "see every lead", and in the WhatsApp inbox it
--                        means seeing every conversation including other hubs'
--                        unassigned ones. A hub has no business in the lead
--                        pipeline at all.
--   VIEW_TEAM_LEADS, VIEW_OWN_LEADS, CREATE_LEAD, EDIT_LEAD, ASSIGN_LEAD
--   MANAGE_HUBS, MANAGE_MASTER_DATA, MANAGE_PRICING, MANAGE_WARRANTIES,
--   MANAGE_DISCOUNTS   — administration of shared data, company-side.
--   APPROVE_CLAIM, RESOLVE_CLAIM, MANAGE_CLAIMS — a hub raises a warranty
--                        claim; it does not decide its own claim.
--   DELETE_*           — nothing in the portal deletes.
--
-- ONE THING TO KNOW: EDIT_ESTIMATE also satisfies the APPROVE_ESTIMATE guard
-- (that route accepts either). That is unchanged from today, where a
-- zero-permission hub passed it via the fallback — not a new authority.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO roles (name, description, permissions, is_active)
VALUES (
  'Hub Partner',
  'Workshop / hub portal login. Runs jobs, raises estimates and Spinoto invoices, records and collects payment. No access to leads or to company administration.',
  ARRAY[
    -- Appointments: see the work, and move it through the bench states
    'VIEW_APPOINTMENT', 'EDIT_APPOINTMENT',
    -- Estimates: the hub's main job
    'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE',
    'SUBMIT_ESTIMATE', 'EXECUTE_ESTIMATE', 'REVISE_ESTIMATE',
    -- Customer invoices: read, and record money received
    'VIEW_INVOICE', 'ADD_INVOICE_PAYMENT',
    -- Their own sales invoices to Spinoto
    'VIEW_PURCHASE_INVOICE', 'CREATE_PURCHASE_INVOICE',
    -- Warranty: raise a claim, do not decide it
    'VIEW_CLAIM', 'CREATE_CLAIM',
    -- Master data they read to build an estimate
    'VIEW_SERVICE', 'VIEW_VEHICLE', 'VIEW_PRICING_RULE',
    -- Their own hub record
    'VIEW_HUB', 'EDIT_HUB',
    -- Taking payment through the gateway. Remove either of these two from the
    -- role if a workshop should not charge cards or mint public pay links.
    'COLLECT_PAYMENT', 'CREATE_PAYMENT_LINK'
  ]::text[],
  TRUE
)
-- Idempotent, and re-running REFRESHES the permission list: the role is
-- described here, so this file is the source of truth for what it contains.
--
-- ON CONFLICT (LOWER(name)), not (name). The unique index migration 034 created
-- is roles_name_lower_idx ON roles (LOWER(name)) — an EXPRESSION index — and a
-- conflict target has to match the index expression, not just the column it is
-- built from. `ON CONFLICT (name)` fails outright with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification": no row inserted,
-- no role created, and the NOTICE below cheerfully reporting NULL permissions.
ON CONFLICT (LOWER(name)) DO UPDATE
  SET permissions = EXCLUDED.permissions,
      description = EXCLUDED.description,
      updated_at  = NOW();

DO $$
DECLARE n INT;
BEGIN
  SELECT cardinality(permissions) INTO n FROM roles WHERE name = 'Hub Partner';
  RAISE NOTICE 'Hub Partner role ready with % permissions. Granted to nobody yet — migration 179 applies it to existing hub logins.', n;
END $$;
