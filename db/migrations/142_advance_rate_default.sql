-- Migration 142: switch on money-with-no-job, at 18%.
--
-- ── READ THIS BEFORE ASSUMING IT IS RIGHT ───────────────────────────────────
-- Migration 141 added advance_default_gst_rate and left it NULL on purpose.
-- NULL means "nobody has answered the tax question yet", and while it is NULL
-- the feature stays off: the Take Payment button does not appear and the
-- endpoint refuses. That was deliberate — a guessed rate ends up printed on a
-- tax document the customer keeps.
--
-- This migration answers it with 18, because that is the rate automobile
-- servicing generally carries and because the alternative was the workshop
-- editing the database by hand. It is a BUSINESS decision this file is making
-- on the company's behalf, not a technical one, and it should be confirmed
-- with the company's accountant.
--
-- The question to ask them, in full: "If we take an advance from a customer
-- before the job is quoted, and we do not yet know which services it will
-- cover, what rate goes on the receipt voucher?"
--
-- ── HOW TO CHANGE IT ────────────────────────────────────────────────────────
-- It is one column, and changing it takes effect on the next receipt only —
-- the rate is snapshotted onto each payment at capture, so no voucher already
-- issued is ever altered.
--
--     UPDATE company_settings SET advance_default_gst_rate = 5 WHERE id = 1;
--
-- To switch the feature back OFF entirely:
--
--     UPDATE company_settings SET advance_default_gst_rate = NULL WHERE id = 1;
--
-- ── WHY THE WHERE CLAUSE MATTERS ────────────────────────────────────────────
-- Only rows that are still unanswered are touched. If someone has already set
-- a rate — by hand, or through a settings screen added later — this migration
-- must not overwrite their answer with its assumption. Re-running it is then a
-- no-op, which is what makes it safe to keep in the folder for ever.

UPDATE company_settings
   SET advance_default_gst_rate = 18
 WHERE advance_default_gst_rate IS NULL;
