-- Migration 155: turn an incoming WhatsApp message into a lead, and make the
-- conversation visible on the record it belongs to.
--
-- ── What was already true before this migration ─────────────────────────────
--
-- The webhook has handled 'message_received' since migration 111/113. Every
-- reply a customer has ever sent IS in wa_messages with direction='in'. What it
-- has never had is entity_type/entity_id — and listMessages, the only read API,
-- filters on exactly those two columns:
--
--     WHERE m.entity_type = $1 AND m.entity_id = $2
--
-- So the replies were stored, orphaned, and invisible to every screen. This
-- migration does not add message storage. It adds the LINK.

BEGIN;

-- ── 1. The two sources the CRM could not express ────────────────────────────
--
-- leads.lead_source is free text (VARCHAR(80)), and lead_sources is the master
-- list the UI offers. Neither 'WhatsApp' nor 'Meta Ads' existed, so a lead
-- created by this feature had no honest value to put there.
--
-- sort_order 9/10: after 'Other' (8) is wrong for the two that will be used
-- most, but renumbering the existing eight would reorder a dropdown people
-- already know. New rows go at the end; the filter chips control their own
-- order anyway.
INSERT INTO lead_sources (name, sort_order) VALUES
  ('WhatsApp',  9),
  ('Meta Ads', 10)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Match a phone number the way a human would ───────────────────────────
--
-- THIS IS THE DUPLICATE-LEAD FIX.
--
-- Three tables hold the same phone number in three different shapes:
--
--     leads.mobile              free text, exactly as typed   '+91 97241 90308'
--     customer_profiles.mobile  10-digit national             '9724190308'
--     wa_messages.to_number     E.164                         '+919724190308'
--
-- leads.mobile has no normalisation anywhere — the create route accepts
-- z.string().max(20), and /leads/check-mobile compares with a bare `=`. So the
-- webhook's E.164 number would not equal the same person's lead typed with
-- spaces, the lookup would miss, and a SECOND lead would be created. Every
-- message from that customer would then land against whichever row matched
-- last.
--
-- A functional index rather than a generated column on purpose: it needs no
-- ALTER on a large hot table, no PG12 minimum, and no second copy of the value
-- that could drift from the first. Both functions are IMMUTABLE, which is what
-- lets them be indexed at all.
--
-- RIGHT(...,10) rather than a strict parse, because this must match what
-- utils/phone.js produces (toNational) AND what customer_profiles already
-- stores, for numbers that were typed years before either existed.
CREATE INDEX IF NOT EXISTS idx_leads_mobile_national
  ON leads (RIGHT(regexp_replace(COALESCE(mobile, ''), '\D', '', 'g'), 10));

COMMENT ON INDEX idx_leads_mobile_national IS
  'Normalised (last 10 digits) phone match. The inbound WhatsApp webhook resolves a lead through this; a plain leads.mobile = $1 misses every number typed with spaces or a +91 and creates a duplicate lead.';

-- Same problem, same fix, for the whatsapp column — a lead whose WhatsApp
-- number differs from their calling number must still be found by it.
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_national
  ON leads (RIGHT(regexp_replace(COALESCE(whatsapp, ''), '\D', '', 'g'), 10))
  WHERE whatsapp IS NOT NULL;

-- ── 3. Which lead owns this number's conversation ───────────────────────────
--
-- wa_conversations already has exactly one row per number, with mobile UNIQUE.
-- That uniqueness is the reason this column belongs here rather than anywhere
-- else: it is the serialisation point that closes the race.
--
-- Two messages from a NEW number arriving milliseconds apart would both find
-- "no lead" and both insert one. The service upserts this row FIRST — the
-- unique index on mobile makes the second one wait — and only the winner sees
-- lead_id IS NULL and creates the lead. No advisory locks, no retry loop; the
-- constraint that was already there does the work.
ALTER TABLE wa_conversations
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL;

COMMENT ON COLUMN wa_conversations.lead_id IS
  'The lead this number''s conversation belongs to. Resolved once, then remembered. NULL means the number matched an existing customer (who does not need a lead) or has not been resolved yet.';

CREATE INDEX IF NOT EXISTS idx_wa_conversations_lead
  ON wa_conversations (lead_id) WHERE lead_id IS NOT NULL;

-- ── 4. Adopt the replies that are already sitting there orphaned ────────────
--
-- Every inbound row written before today has entity_type NULL. Without this
-- they stay invisible even after the code is fixed, and the customer whose
-- question went unanswered for a week has no record of having asked.
--
-- Only rows that match exactly ONE lead are adopted. Where a number matches
-- several — which manual entry allows, there is no unique constraint on
-- leads.mobile — guessing would attach a customer's words to the wrong record,
-- and a wrong attribution is worse than a missing one. Those stay NULL and are
-- still reachable through the by-number thread view.
WITH matched AS (
  SELECT m.id AS msg_id,
         (SELECT l.id
            FROM leads l
           WHERE RIGHT(regexp_replace(COALESCE(l.mobile, ''), '\D', '', 'g'), 10)
                 = RIGHT(regexp_replace(m.to_number, '\D', '', 'g'), 10)
           ORDER BY l.created_at DESC, l.id DESC
           LIMIT 1) AS lead_id,
         (SELECT COUNT(*)
            FROM leads l
           WHERE RIGHT(regexp_replace(COALESCE(l.mobile, ''), '\D', '', 'g'), 10)
                 = RIGHT(regexp_replace(m.to_number, '\D', '', 'g'), 10)) AS n
    FROM wa_messages m
   WHERE m.direction = 'in'
     AND m.entity_type IS NULL
)
UPDATE wa_messages m
   SET entity_type = 'lead', entity_id = matched.lead_id
  FROM matched
 WHERE m.id = matched.msg_id
   AND matched.lead_id IS NOT NULL
   AND matched.n = 1;

-- Same for the conversation rows, so the link is not recomputed on every read.
UPDATE wa_conversations c
   SET lead_id = sub.lead_id
  FROM (
    SELECT c2.id,
           (SELECT l.id FROM leads l
             WHERE RIGHT(regexp_replace(COALESCE(l.mobile, ''), '\D', '', 'g'), 10)
                   = RIGHT(regexp_replace(c2.mobile, '\D', '', 'g'), 10)
             ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS lead_id
      FROM wa_conversations c2
     WHERE c2.lead_id IS NULL
  ) sub
 WHERE c.id = sub.id AND sub.lead_id IS NOT NULL;

COMMIT;
