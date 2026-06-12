-- 075 — Durable guards for invariants currently enforced only in code.
-- The controllers now also use pg_advisory_xact_lock, but these unique
-- indexes make the invariants impossible to violate at the DB level.
--
-- NOTE: these will fail if duplicate rows already exist. Check first:
--   SELECT appointment_id FROM estimates GROUP BY appointment_id HAVING COUNT(*) > 1;
--   SELECT estimate_id FROM customer_invoices GROUP BY estimate_id HAVING COUNT(*) > 1;

-- One estimate per appointment
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_appointment_id
  ON estimates (appointment_id);

-- One customer invoice per estimate
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_invoices_estimate_id
  ON customer_invoices (estimate_id);
