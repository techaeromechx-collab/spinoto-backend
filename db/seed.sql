-- =====================================================================
-- Spinoto — seed data for local development
-- Run AFTER schema.sql:
--   psql spinoto -f seed.sql
-- =====================================================================
-- One Super Admin user is seeded. The Super Admin can create all other
-- users (and grant per-user permissions) from the in-app Users page.
--
--   email:    super@spinoto.local
--   password: super123
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Super Admin
--   The placeholder hash below is replaced with a real bcrypt hash on
--   the first backend boot — see backend/src/utils/seedPasswords.js.
-- ---------------------------------------------------------------------
INSERT INTO users (name, email, password_hash, is_super_admin) VALUES
('Super Admin', 'super@spinoto.local',
 '$2a$10$wH8rJxzXpZ8R4yQ0oVZxLeQ1nL5w7T3F5qmjY1W3j1QbQp8z3yX0e', TRUE);

-- ---------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------
INSERT INTO states (name, code) VALUES
('Maharashtra', 'MH'),
('Karnataka',   'KA'),
('Gujarat',     'GJ');

INSERT INTO cities (state_id, name) VALUES
((SELECT id FROM states WHERE code = 'MH'), 'Mumbai'),
((SELECT id FROM states WHERE code = 'MH'), 'Pune'),
((SELECT id FROM states WHERE code = 'KA'), 'Bengaluru'),
((SELECT id FROM states WHERE code = 'KA'), 'Mysuru'),
((SELECT id FROM states WHERE code = 'GJ'), 'Ahmedabad');

INSERT INTO areas (city_id, name, pincode) VALUES
((SELECT id FROM cities WHERE name='Mumbai'    AND state_id=(SELECT id FROM states WHERE code='MH')), 'Andheri',    '400053'),
((SELECT id FROM cities WHERE name='Mumbai'    AND state_id=(SELECT id FROM states WHERE code='MH')), 'Bandra',     '400050'),
((SELECT id FROM cities WHERE name='Pune'      AND state_id=(SELECT id FROM states WHERE code='MH')), 'Kothrud',    '411038'),
((SELECT id FROM cities WHERE name='Bengaluru' AND state_id=(SELECT id FROM states WHERE code='KA')), 'Indiranagar','560038'),
((SELECT id FROM cities WHERE name='Bengaluru' AND state_id=(SELECT id FROM states WHERE code='KA')), 'Whitefield', '560066'),
((SELECT id FROM cities WHERE name='Ahmedabad' AND state_id=(SELECT id FROM states WHERE code='GJ')), 'Satellite',  '380015');

-- ---------------------------------------------------------------------
-- Vehicle taxonomy
-- ---------------------------------------------------------------------
INSERT INTO vehicle_types (name) VALUES
('Two-Wheeler'), ('Four-Wheeler'), ('Commercial');

INSERT INTO vehicle_makes (vehicle_type_id, name) VALUES
((SELECT id FROM vehicle_types WHERE name='Four-Wheeler'), 'Maruti Suzuki'),
((SELECT id FROM vehicle_types WHERE name='Four-Wheeler'), 'Hyundai'),
((SELECT id FROM vehicle_types WHERE name='Four-Wheeler'), 'Honda'),
((SELECT id FROM vehicle_types WHERE name='Two-Wheeler'),  'Hero'),
((SELECT id FROM vehicle_types WHERE name='Two-Wheeler'),  'Bajaj'),
((SELECT id FROM vehicle_types WHERE name='Commercial'),   'Tata');

INSERT INTO vehicle_models (make_id, name) VALUES
((SELECT id FROM vehicle_makes WHERE name='Maruti Suzuki'), 'Swift'),
((SELECT id FROM vehicle_makes WHERE name='Maruti Suzuki'), 'Baleno'),
((SELECT id FROM vehicle_makes WHERE name='Maruti Suzuki'), 'Brezza'),
((SELECT id FROM vehicle_makes WHERE name='Hyundai'),       'i20'),
((SELECT id FROM vehicle_makes WHERE name='Hyundai'),       'Creta'),
((SELECT id FROM vehicle_makes WHERE name='Honda'),         'City'),
((SELECT id FROM vehicle_makes WHERE name='Hero'),          'Splendor'),
((SELECT id FROM vehicle_makes WHERE name='Bajaj'),         'Pulsar'),
((SELECT id FROM vehicle_makes WHERE name='Tata'),          'Ace');

INSERT INTO segments (name) VALUES
('Petrol'), ('Diesel'), ('CNG'), ('Electric');

INSERT INTO body_types (name) VALUES
('Hatchback'), ('Sedan'), ('SUV'), ('MUV'), ('Pickup');

-- ---------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------
INSERT INTO service_categories (name) VALUES
('Service Package'), ('Repair'), ('Detailing');

INSERT INTO services (category_id, name, description) VALUES
((SELECT id FROM service_categories WHERE name='Service Package'), 'Basic Service',     'Engine oil change, oil filter, general check'),
((SELECT id FROM service_categories WHERE name='Service Package'), 'Standard Service',  'Basic + air filter, brake check, fluids top-up'),
((SELECT id FROM service_categories WHERE name='Service Package'), 'Premium Service',   'Full inspection + spark plugs + coolant replacement'),
((SELECT id FROM service_categories WHERE name='Repair'),          'Brake Pad Replacement', 'Front or rear brake pads'),
((SELECT id FROM service_categories WHERE name='Repair'),          'Battery Replacement',   'New battery + installation'),
((SELECT id FROM service_categories WHERE name='Detailing'),       'Interior Detailing',    'Vacuum, dashboard, seats'),
((SELECT id FROM service_categories WHERE name='Detailing'),       'Exterior Polish',       'Wash, polish and wax');

-- ---------------------------------------------------------------------
-- Pricing — by body type (general) and a few make/model overrides
-- ---------------------------------------------------------------------
INSERT INTO pricing (service_id, body_type_id, price)
SELECT s.id, b.id,
       CASE
         WHEN s.name='Basic Service'    THEN 1499 + (b.id-1)*200
         WHEN s.name='Standard Service' THEN 2499 + (b.id-1)*250
         WHEN s.name='Premium Service'  THEN 3999 + (b.id-1)*300
       END
FROM services s
CROSS JOIN body_types b
WHERE s.name IN ('Basic Service','Standard Service','Premium Service');

INSERT INTO pricing (service_id, body_type_id, price)
SELECT s.id, b.id,
       CASE
         WHEN s.name='Brake Pad Replacement' THEN 1200
         WHEN s.name='Battery Replacement'   THEN 4500
         WHEN s.name='Interior Detailing'    THEN 1800
         WHEN s.name='Exterior Polish'       THEN 1500
       END
FROM services s
CROSS JOIN body_types b
WHERE s.name IN ('Brake Pad Replacement','Battery Replacement','Interior Detailing','Exterior Polish');

INSERT INTO pricing (service_id, body_type_id, make_id, price)
SELECT s.id, b.id, m.id, ROUND(p.price * 1.10, 0)
FROM pricing p
JOIN services s     ON s.id = p.service_id
JOIN body_types b   ON b.id = p.body_type_id
JOIN vehicle_makes m ON m.name = 'Honda'
WHERE s.name='Premium Service';

COMMIT;
