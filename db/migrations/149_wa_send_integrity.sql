-- Migration 149: three audit findings that each need a column.
--
-- All three are about the same thing — the gap between what we INTENDED to send
-- and what actually went out — and none of them could be closed in code alone.

BEGIN;

-- ── 1. Which number did we actually use, and why ────────────────────────────
--
-- utils/phone.js already returns this. Its own header states the contract:
-- "this returns WHICH field was used and the caller logs it — 'we messaged the
-- mobile because no WhatsApp number was set' is a support answer; silently
-- doing it is a mystery."
--
-- The dispatcher computed it and dropped it. So when a customer says "that went
-- to my husband's phone", the only record is a bare +91 number with nothing
-- saying whether it came from the WhatsApp field, the mobile fallback, or a
-- number an advisor typed at the counter.
--
-- previewWhatsApp exposes fell_back_to_mobile. The SEND path — the one that
-- spends money and reaches a real person — did not.
ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS target_source VARCHAR(12);

COMMENT ON COLUMN wa_messages.target_source IS
  'Where to_number came from: whatsapp (the customer''s WhatsApp field), mobile (fallback because no WhatsApp number was set), or override (typed by hand at send time). NULL on rows queued before migration 149.';

-- ── 2. Was the template still the same when we sent it? ─────────────────────
--
-- claimBatch re-reads provider_template_name, language_code and the variable
-- order from the template row at SEND time, while the resolved VALUES were
-- frozen at queue time. That is deliberate for one case — correcting a bad
-- mapping should fix messages already queued — and dangerous for another.
--
-- The dangerous one: a message is queued and previewed, then an admin corrects
-- provider_template_name from 'invoice_' to 'invoice_v2_'. The queued row now
-- sends against a DIFFERENT Meta template, whose placeholder count may differ,
-- carrying values resolved for the old one. Nothing warns, and body_rendered
-- still shows the old rendering.
--
-- The fingerprint makes that detectable. Recorded at queue time, compared at
-- send time. A mismatch fails the row with TEMPLATE_CHANGED rather than sending
-- something nobody intended — a failed message an advisor can resend is
-- recoverable; a wrong message on a customer's phone is not.
ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS template_fingerprint TEXT;

COMMENT ON COLUMN wa_messages.template_fingerprint IS
  'provider_template_name | language_code | variables | header_variables as they stood when this row was queued. Compared at send time; a mismatch means the template was edited in between and the row is failed rather than sent. NULL on rows queued before migration 149, which skip the check.';

-- ── 3. Stop a replayed webhook growing the log without bound ────────────────
--
-- Migration 115 established that Interakt signs the body with NO timestamp and
-- NO nonce, and guarded the inbound MESSAGE rows with a unique index. The raw
-- EVENT insert has no such guard and runs before any dedupe, for every event.
--
-- So anyone who captures one valid webhook — a proxy log, an APM trace, a
-- mirrored request — can replay it in a loop. The message insert no-ops and the
-- status ladder is idempotent, so nothing incorrect happens; wa_events simply
-- grows at whatever rate they can post, on a route that is deliberately not
-- rate limited (rate limiting it would let an attacker suppress real webhooks).
--
-- A partial unique index is the smallest fix that keeps the log honest. Partial,
-- because provider_message_id is nullable and several event kinds legitimately
-- arrive without one — those keep inserting freely, as they must.
--
-- (event_type, provider_message_id) rather than provider_message_id alone: one
-- message genuinely produces Sent, then Delivered, then Read, and collapsing
-- those would throw away the timeline this table exists to keep.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_events_replay
  ON wa_events (provider_message_id, event_type)
  WHERE provider_message_id IS NOT NULL AND event_type IS NOT NULL;

COMMIT;
