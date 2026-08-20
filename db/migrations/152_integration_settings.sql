-- Migration 152: integration_settings — provider credentials an admin can set
-- from Settings → WhatsApp → Connection, without SSH and a restart.
--
-- ── Why its OWN table and not columns on company_settings ───────────────────
--
-- company_settings is read broadly: the profile screen, the invoice themes,
-- the alert settings all SELECT from it, and several of those responses flow
-- to the frontend more or less whole. A secret column there is one careless
-- `SELECT *` away from an API response. This table is read by exactly one
-- module (integrationSettings.service.js) and its GET endpoint returns only
-- {configured, last4} — the value itself never leaves the backend.
--
-- ── Precedence: database over environment ───────────────────────────────────
--
-- A row here WINS over the corresponding env var; the env var is the fallback
-- so existing deployments keep working untouched. Clearing a key in the UI
-- deletes the row, which falls back to env — it does not write an empty row
-- that would silently disable a working env configuration.
--
-- Values are stored as plain text. This is a deliberate, stated trade-off:
-- the database already holds every customer's phone number and every invoice,
-- an attacker with SQL access has worse things than a messaging key, and a
-- reversible in-app encryption layer would only move the key one file over.
-- What the design DOES enforce: never returned by any API, masked to last4 in
-- the UI, write permission-gated, every change stamped with who and when.

BEGIN;

CREATE TABLE IF NOT EXISTS integration_settings (
    key         VARCHAR(60) PRIMARY KEY,
    value       TEXT        NOT NULL,
    updated_by  INTEGER     REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE integration_settings IS
  'Provider credentials set from the UI. DB wins over env; deleting a row falls back to env. Values never leave the backend — endpoints return {configured, last4} only.';

-- Known keys today (a closed list enforced in the controller, not here):
--   interakt_api_key        — overrides INTERAKT_API_KEY
--   interakt_webhook_secret — overrides INTERAKT_WEBHOOK_SECRET
--   whatsapp_test_number    — overrides WHATSAPP_TEST_NUMBER

COMMIT;
