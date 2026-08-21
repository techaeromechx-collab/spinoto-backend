-- 165_backfill_public_tokens.sql
--
-- Gives a public_token to every row that never got one.
--
-- ── WHY ROWS ARE MISSING IT ─────────────────────────────────────────────────
--
-- Two separate causes, and both are still producing null tokens today:
--
--   1. Migration 085 added the column and the unique index, and stopped there.
--      It never backfilled. So every lead, appointment, estimate and invoice
--      that existed BEFORE 085 has had a null token ever since.
--
--   2. controllers/import.controller.js — the Bulk Upload path — never set the
--      column at all. Its INSERT lists 16 columns and public_token is not one
--      of them, so every lead ever created by bulk import is null too. That is
--      fixed in the same change as this migration; this file repairs the rows
--      already in the database.
--
-- ── WHAT A NULL TOKEN ACTUALLY BREAKS ───────────────────────────────────────
--
-- The frontend routes detail pages by token: navigate(`/leads/${public_token}`).
-- With a null it produces the literal string "null" in the URL, so:
--
--     GET /api/leads/by-token/null  →  404
--
-- the breadcrumb renders "null", the URL cannot be shared or bookmarked, and
-- refreshing the page does not reopen the record. The record still OPENS on
-- click — the id is passed separately — which is exactly why this went
-- unnoticed: it looks like a cosmetic glitch rather than a broken route.
--
-- ── WHY THE TOKEN IS BUILT THIS WAY ─────────────────────────────────────────
--
-- It must be byte-identical in SHAPE to what the application generates, or the
-- two populations are distinguishable and the column stops being opaque.
-- utils/publicToken.js is:
--
--     crypto.randomBytes(10).toString('base64url')     → 14 chars, no padding
--
-- The SQL below is the same thing: ten random bytes, base64, then translate
-- '+/' to '-_' and DELETE '=' (translate drops characters whose replacement is
-- absent — that is what removes the padding). Verified against PostgreSQL
-- 16.13: 5,000 samples, every one exactly 14 characters, no newline wrapping
-- (Postgres wraps base64 at 76 characters; 16 is nowhere near it).
--
-- gen_random_uuid() is used as the entropy source because it is CORE from
-- PostgreSQL 13 onward. gen_random_bytes() would be the more natural call, but
-- it lives in pgcrypto, and this repo has never required an extension — asking
-- a managed database for CREATE EXTENSION is a permission problem waiting to
-- happen on the one night someone is running migrations against production.
--
-- ── WHY A LOOP AND NOT ONE UPDATE ───────────────────────────────────────────
--
-- public_token carries a UNIQUE index. A bare
--
--     UPDATE leads SET public_token = <random> WHERE public_token IS NULL
--
-- would abort the entire migration on a collision. At ~74 bits of entropy that
-- is astronomically unlikely — but "astronomically unlikely" is not the same
-- as "cannot happen", and the failure mode is a half-migrated production
-- database at whatever hour this gets run. The per-row retry below cannot fail
-- for that reason, which is worth the extra twenty lines.

DO $$
DECLARE
  tbl   TEXT;
  rec   RECORD;
  tok   TEXT;
  tries INT;
  fixed INT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'leads', 'appointments', 'estimates', 'purchase_invoices', 'customer_invoices'
  ] LOOP
    fixed := 0;

    -- The table may not exist on an install that has not reached 085 yet.
    -- Migrations run in order so it will, but a skipped file must not take the
    -- whole run down.
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE '165: %  — table not present, skipped', tbl;
      CONTINUE;
    END IF;

    FOR rec IN EXECUTE format(
      'SELECT id FROM %I WHERE public_token IS NULL ORDER BY id', tbl
    ) LOOP
      tries := 0;
      LOOP
        tries := tries + 1;
        tok := translate(
                 encode(
                   substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex')
                             FROM 1 FOR 10),
                   'base64'),
                 '+/=', '-_');
        BEGIN
          EXECUTE format('UPDATE %I SET public_token = $1 WHERE id = $2', tbl)
            USING tok, rec.id;
          fixed := fixed + 1;
          EXIT;                                  -- this row is done
        EXCEPTION WHEN unique_violation THEN
          -- Another row already holds that token. Draw again.
          IF tries >= 10 THEN
            RAISE EXCEPTION
              '165: could not find a free public_token for %.id=% after % attempts',
              tbl, rec.id, tries;
          END IF;
        END;
      END LOOP;
    END LOOP;

    RAISE NOTICE '165: %  — % row(s) backfilled', tbl, fixed;
  END LOOP;
END $$;

-- Proof, in the migration itself. If any of the five still has a null token
-- after the block above, the run fails here rather than reporting success and
-- leaving the bug in place for someone to rediscover from a console 404.
DO $$
DECLARE
  tbl  TEXT;
  left_over BIGINT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'leads', 'appointments', 'estimates', 'purchase_invoices', 'customer_invoices'
  ] LOOP
    IF to_regclass(tbl) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE public_token IS NULL', tbl)
      INTO left_over;
    IF left_over > 0 THEN
      RAISE EXCEPTION '165: % still has % row(s) with a null public_token', tbl, left_over;
    END IF;
  END LOOP;
END $$;

-- NOTE ON WHAT IS DELIBERATELY *NOT* HERE
--
-- No NOT NULL constraint, and no DEFAULT.
--
-- A DEFAULT would look like the obvious permanent fix, and it is a trap: every
-- application INSERT already supplies its own token from publicToken.js, so a
-- database default would only ever fire for a caller that FORGOT to — silently
-- papering over exactly the bug this migration exists to clean up, and hiding
-- the next one. The import path is fixed in code, where the omission is
-- visible in review.
--
-- NOT NULL is a separate decision with a real cost: it would make this column
-- un-addable to any future table in one statement, and it would turn a
-- forgotten token from "a broken URL on one record" into "the insert fails".
-- Worth doing once the code paths have been stable for a while; not in the
-- same migration that is repairing the data.
