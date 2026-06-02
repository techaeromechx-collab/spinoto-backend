-- Migration 025: Fix hours_before to NUMERIC(4,2)
--
-- ABSORBED INTO MIGRATION 048: appointment_reminder_log is now created with
-- hours_before NUMERIC(4,2) directly in 048_invoice_gst_cancellation.sql.
--
-- On existing DBs where the column is still INT, apply the ALTER.
-- On fresh DBs this is a no-op (table does not exist yet at this step).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointment_reminder_log'
      AND column_name = 'hours_before'
      AND data_type   = 'integer'
  ) THEN
    ALTER TABLE appointment_reminder_log
      ALTER COLUMN hours_before TYPE NUMERIC(4,2);
  END IF;
END $$;
