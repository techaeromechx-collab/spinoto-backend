ALTER TABLE hubs
  ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2) DEFAULT NULL;

COMMENT ON COLUMN hubs.commission_percent IS 'Spinoto take rate percentage (e.g. 15.00 means 15%). Used to calculate purchase invoice payable to hub.';
