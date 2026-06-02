-- Migration 049: Customer Vehicles table

CREATE TABLE IF NOT EXISTS customer_vehicles (
  id              SERIAL PRIMARY KEY,
  mobile          VARCHAR(20) NOT NULL,
  vehicle_number  VARCHAR(30) NOT NULL,
  vehicle_type_id INT REFERENCES vehicle_types(id)  ON DELETE SET NULL,
  make_id         INT REFERENCES vehicle_makes(id)   ON DELETE SET NULL,
  model_id        INT REFERENCES vehicle_models(id)  ON DELETE SET NULL,
  color           VARCHAR(50),
  year            SMALLINT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mobile, vehicle_number)
);

CREATE INDEX IF NOT EXISTS idx_customer_vehicles_mobile ON customer_vehicles(mobile);
