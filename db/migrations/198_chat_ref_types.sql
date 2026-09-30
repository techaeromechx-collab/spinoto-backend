-- 198_chat_ref_types.sql
--
-- Narrows chat_messages.ref_type to the kinds of record that can actually be
-- resolved safely.
--
-- ══ WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO 197 ═══════════════════
--
-- 197 is very likely not applied anywhere yet — it sits behind ten migrations
-- (187-196) that are still outstanding. Editing it would be tidier.
--
-- But production reads are blocked, so "very likely" is the strongest thing
-- anybody can say about it from here, and a migration that has already run is
-- not editable by definition. A separate, additive narrowing is correct whether
-- 197 ran or not. That is worth more than a tidy history.
--
-- ══ WHAT COMES OUT, AND WHY ════════════════════════════════════════════════
--
-- 197 listed eight ref_types. The rule this feature is built on is that
-- receiving a pointer is not permission to open the record, which means every
-- type needs a resolver that reproduces THAT RECORD'S OWN access rule. Two of
-- the eight cannot have one, and both were found by reading the routes rather
-- than by assuming:
--
--   'customer'  — customers are addressed by MOBILE NUMBER, not by id:
--                 routes/customers.routes.js has GET /:mobile and no GET /:id.
--                 A 10-digit Indian mobile (6-9 leading) is larger than
--                 2,147,483,647, so ref_id INTEGER cannot even hold one. This
--                 was never going to work, and a wider column would not fix it
--                 — a mobile is not an identifier of a row, it is an identifier
--                 of a person, and several customer_profiles can share one.
--
--   'vehicle'   — there is no per-vehicle record to share. vehicles.routes.js
--                 serves MASTER DATA: /types, /makes, /models, /segments,
--                 /body-types. "A vehicle" in this system is a plate on an
--                 appointment, not a row with a page of its own.
--
-- Neither is a gap to be filled in later by adding a resolver. Both are the
-- list having been written from what sounded shareable rather than from what is
-- addressable, and this corrects it.
--
-- The six that stay all have: an integer primary key, a GET /:id route, and a
-- single canView permission list read off that route.
--
--   lead              VIEW_LEAD, VIEW_TEAM_LEADS, VIEW_OWN_LEADS
--                       ...and row scoping: a VIEW_OWN_LEADS holder sees only
--                       leads they created or were given. The resolver reuses
--                       leads.controller.js's own scopeConditions rather than
--                       restating it — that function's comment records that
--                       three copies of the rule had already drifted.
--   appointment       VIEW_APPOINTMENT, CREATE_APPOINTMENT, EDIT_APPOINTMENT
--   job_card          VIEW_APPOINTMENT, EDIT_APPOINTMENT, CREATE_APPOINTMENT
--   estimate          VIEW_ESTIMATE, CREATE_ESTIMATE, EDIT_ESTIMATE,
--                     SUBMIT_ESTIMATE, EXECUTE_ESTIMATE
--   customer_invoice  VIEW_INVOICE, CREATE_INVOICE, EDIT_INVOICE,
--                     ADD_INVOICE_PAYMENT
--   purchase_invoice  VIEW_HUB, MANAGE_HUBS, VIEW_INVOICE,
--                     VIEW_PURCHASE_INVOICE
--
-- ══ NO DATA TO MIGRATE ═════════════════════════════════════════════════════
--
-- Nothing can have written 'customer' or 'vehicle': the only code that inserts
-- a ref is chat.controller.js's sendMessage, the share control did not exist
-- before this change, and no UI ever offered either type. The guarded delete
-- below is there so this migration cannot fail on a database where somebody
-- inserted one by hand — not because any is expected.

BEGIN;

-- Belt and braces. Reports what it did rather than deleting in silence, because
-- a row disappearing from a message thread should be visible in the migration
-- log if it ever happens.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM chat_messages WHERE ref_type IN ('customer', 'vehicle');
  IF n > 0 THEN
    RAISE NOTICE '198: clearing ref_type on % message(s) pointing at a customer or vehicle', n;
    -- The POINTER is cleared, never the message. Somebody wrote those words and
    -- they stay; only the chip that could never have resolved goes.
    UPDATE chat_messages
       SET ref_type = NULL, ref_id = NULL
     WHERE ref_type IN ('customer', 'vehicle')
       AND body IS NOT NULL AND BTRIM(body) <> '';
    -- A pointer-only message has nothing left once the pointer goes, so it is
    -- withdrawn rather than left as an empty bubble. chat_messages_has_content
    -- permits a contentless row only when deleted_at is set — which is exactly
    -- the state this is.
    UPDATE chat_messages
       SET ref_type = NULL, ref_id = NULL, deleted_at = COALESCE(deleted_at, NOW())
     WHERE ref_type IN ('customer', 'vehicle');
  END IF;
END $$;

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_ref_type_known;

ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_ref_type_known CHECK (
  ref_type IS NULL OR ref_type IN (
    'lead', 'appointment', 'job_card',
    'estimate', 'customer_invoice', 'purchase_invoice'
  )
);

COMMENT ON COLUMN chat_messages.ref_type IS
  'A POINTER to a CRM record, never a copy of it. No label, customer name, '
  'amount, plate or phone number is stored here, so there is nothing in this '
  'row to leak if the viewer turns out not to have access. What the chip says '
  'is resolved per viewer at render time by services/chatRefs.service.js, '
  'against the same permission list that record''s own GET route uses. '
  'A type belongs in the CHECK above only once a resolver exists for it: '
  'adding one without its resolver is a data leak with a chip around it. '
  '''customer'' and ''vehicle'' were removed in 198 — see that file.';

COMMIT;
