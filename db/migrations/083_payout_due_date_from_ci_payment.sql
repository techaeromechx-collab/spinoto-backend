-- 083_payout_due_date_from_ci_payment.sql
--
-- Hub payout due date is no longer "PI approval date + hub's payout cycle
-- days". It is now driven by the linked Customer Invoice's payment: once the
-- customer fully pays the CI, the hub payout due date becomes the next
-- Tuesday on/after that payment date. Before the CI is fully paid, there is
-- no due date (NULL) — surfaced in the Payouts UI as "Awaiting Customer
-- Payment" rather than an overdue/upcoming countdown.
--
-- pi_payment_schedule.due_date must become nullable: split-schedule
-- installments are now created at PI-approval time (amounts known) before
-- it's known when — or whether — the customer has paid, so due_date starts
-- out NULL and gets filled in later by syncPayoutDueDate().
--
-- See: backend/src/utils/payoutSchedule.js

ALTER TABLE pi_payment_schedule ALTER COLUMN due_date DROP NOT NULL;
