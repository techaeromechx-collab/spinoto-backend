-- Migration 163: has THIS person seen this WhatsApp conversation?
--
-- ── Why there is nothing to reuse ───────────────────────────────────────────
--
-- wa_messages already has read_at, and it is the wrong read_at. That column is
-- the customer's blue tick on a message WE sent — Interakt reports it, the
-- thread renders it. Nothing anywhere records whether an ADVISOR has looked at
-- a message the customer sent.
--
-- Which is why the topbar has never had a WhatsApp badge: a badge that can
-- count up but never come back down is worse than no badge. Within a day it
-- reads "47" permanently and everybody stops seeing it.
--
-- ── Why per user and not a column on the conversation ───────────────────────
--
-- One last_read_at on wa_conversations would be one line of migration and one
-- line of SQL. It also means an admin opening a thread to check something wipes
-- the advisor's badge, and the advisor never learns the customer wrote. The
-- unassigned queue makes it worse: those conversations are visible to
-- everybody, so the first person to glance at one clears it for the whole team.
--
-- A row per (user, conversation) costs one small table and makes the badge mean
-- what it says: unread BY YOU.
--
-- ── Keyed on the mobile number, like the rest of the module ─────────────────
--
-- wa_conversations.mobile is UNIQUE (migration 113) and it is what wa_messages
-- joins on (to_number). Keying this on a conversation id instead would be the
-- only place in the WhatsApp module that does, and every query would need one
-- more join to get back to the number it actually has in hand.
--
-- Deliberately NOT a foreign key to wa_conversations. A conversation row is
-- created by the webhook and could in principle be tidied up; a read marker
-- outliving it is harmless — it points at a number with no messages, so it
-- contributes nothing to any count — whereas a cascade delete that silently
-- resurrects somebody's unread badge is a bug nobody would ever trace back
-- here.

BEGIN;

CREATE TABLE IF NOT EXISTS wa_conversation_reads (
  user_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- E.164, from utils/phone.js — the same normalisation wa_conversations.mobile
  -- and wa_messages.to_number use, or the counts will not join.
  mobile  VARCHAR(20) NOT NULL,

  -- A CURSOR, not a flag. "Everything on this number up to this moment has been
  -- seen." A boolean would need clearing on every new inbound message, from the
  -- webhook, for every user who might care — three writes and a race, to store
  -- less than one timestamp does.
  --
  -- It also makes the query trivially correct: a message counts as unread when
  -- its created_at is after this. Nothing to keep in step.
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, mobile)
);

COMMENT ON TABLE wa_conversation_reads IS
  'Per-user read cursor for WhatsApp conversations. One row per (user, number); read_at means everything inbound on that number before this moment has been seen by that user. Feeds the WhatsApp badge in the topbar. Distinct from wa_messages.read_at, which is the CUSTOMER''S blue tick on an outbound message.';

COMMENT ON COLUMN wa_conversation_reads.read_at IS
  'Everything inbound on this number before this timestamp has been seen by this user. A cursor rather than a flag, so a new message needs no write here at all.';

-- The badge query reads every row for one user on every poll and every socket
-- nudge. The primary key already serves that (user_id leads it), so no second
-- index is added — one that duplicates the PK's leading column would be paid
-- for on every write and used on nothing.

COMMIT;
