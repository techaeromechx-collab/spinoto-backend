-- 104_search_indexes.sql
--
-- Make the list-screen search boxes index-backed.
--
-- The searches are all `col ILIKE '%term%'`. A leading % defeats a normal
-- B-tree index — Postgres has no way to seek into the middle of a string — so
-- every keystroke was a sequential scan of the whole table. A pg_trgm GIN index
-- is the exception: it indexes every 3-character substring, so '%swift%' can be
-- answered from the index.
--
-- Why trigram and not full-text search (tsvector):
--   * FTS matches whole words. Typing "swi" would never find "Swift", and a
--     search box that only works once you finish the word is not a search box.
--   * FTS stems English. "Servicing" → "servic" is useless for names, and
--     actively wrong for Indian customer names and registration numbers.
--   * Trigram tolerates typos, which is what you want when someone is reading a
--     name off the phone.
--
-- The cost: GIN indexes are larger than B-trees and slow writes a little. At
-- this data volume that is a rounding error, and these tables are read far more
-- than they are written.
--
-- NOTE: a term shorter than 3 characters has no complete trigram, so a 1–2
-- character search still scans. That is why the API refuses to search below 2
-- characters (utils/listSearch.js) and the UI waits for the second keystroke.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Customer invoices ───────────────────────────────────────────────────────
-- Own columns; the CI list never joins for the search.
CREATE INDEX IF NOT EXISTS idx_ci_customer_name_trgm
  ON customer_invoices USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ci_mobile_trgm
  ON customer_invoices USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ci_vehicle_number_trgm
  ON customer_invoices USING gin (vehicle_number gin_trgm_ops);

-- ── Appointments ────────────────────────────────────────────────────────────
-- The estimate AND purchase-invoice lists both search through this table.
CREATE INDEX IF NOT EXISTS idx_appt_customer_name_trgm
  ON appointments USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_appt_mobile_trgm
  ON appointments USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_appt_vehicle_number_trgm
  ON appointments USING gin (vehicle_number gin_trgm_ops);

-- ── Estimates ───────────────────────────────────────────────────────────────
-- Standalone estimates carry their own copy of these, and a job with no
-- appointment is only findable through them.
CREATE INDEX IF NOT EXISTS idx_est_customer_name_trgm
  ON estimates USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_est_mobile_trgm
  ON estimates USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_est_vehicle_number_trgm
  ON estimates USING gin (vehicle_number gin_trgm_ops);

-- ── Foreign keys the search joins travel along ──────────────────────────────
-- Postgres does NOT index foreign keys automatically. The PI list joins to
-- appointments and estimates on every request, searching or not, so these earn
-- their keep beyond this migration.
CREATE INDEX IF NOT EXISTS idx_pi_appointment_id ON purchase_invoices (appointment_id);
CREATE INDEX IF NOT EXISTS idx_pi_estimate_id    ON purchase_invoices (estimate_id);
CREATE INDEX IF NOT EXISTS idx_est_appointment_id ON estimates (appointment_id);

-- Sort keys. Every list is ORDER BY <date> DESC, id DESC with a LIMIT, which
-- an index on exactly that pair answers by walking the first N entries instead
-- of sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_ci_invoice_date_id ON customer_invoices (invoice_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pi_invoice_date_id ON purchase_invoices (invoice_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_est_estimate_date_id ON estimates (estimate_date DESC, id DESC);

ANALYZE customer_invoices;
ANALYZE purchase_invoices;
ANALYZE estimates;
ANALYZE appointments;
