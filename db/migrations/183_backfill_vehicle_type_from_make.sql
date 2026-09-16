-- Migration 183: fill in a missing vehicle_type_id from the vehicle's make.
--
-- WHAT WENT WRONG
-- ───────────────
-- The lead form lets somebody choose a make and a model without choosing a
-- vehicle type. The appointment created from that lead inherits the blank, the
-- customer invoice inherits it from the appointment, and the Hub Revenue report
-- then has nothing to bucket the job by — it lands under "Not set". CI-000384
-- is how this was found: one invoice, ₹4,949, no type, on a Maruti Ertiga.
--
-- WHY THE DATA IS RECOVERABLE
-- ───────────────────────────
-- vehicle_makes.vehicle_type_id is populated for ALL 62 makes. A make IS a
-- statement about the type — Maruti Suzuki is a 4W manufacturer — so a row that
-- knows its make already knows its type. Nothing is being guessed here; the
-- answer was one join away the whole time.
--
-- This is the same derivation services/bookingAppointment.service.js has always
-- done for public bookings, which is why bookings never showed this problem and
-- CRM-entered leads did.
--
-- SCOPE — deliberately narrow
-- ───────────────────────────
-- Only rows where the type is NULL and a make IS set. A row with no make is
-- left alone: there is nothing to derive from, and inventing one would be
-- worse than the blank. Nothing already filled in is touched, so this cannot
-- overwrite a type somebody chose by hand.
--
-- Idempotent: running it twice changes nothing the second time, because the
-- rows it fixed no longer match WHERE vehicle_type_id IS NULL.
--
-- Estimates are not touched. estimates.vehicle_type_id is only used as a
-- fallback behind the appointment's (COALESCE(a.vehicle_type_id,
-- e.vehicle_type_id) in reports.controller.js), and no estimate row has a make
-- to derive from anyway.

UPDATE leads l
   SET vehicle_type_id = mk.vehicle_type_id
  FROM vehicle_makes mk
 WHERE mk.id = l.make_id
   AND l.vehicle_type_id IS NULL
   AND mk.vehicle_type_id IS NOT NULL;

UPDATE appointments a
   SET vehicle_type_id = mk.vehicle_type_id,
       updated_at      = NOW()
  FROM vehicle_makes mk
 WHERE mk.id = a.make_id
   AND a.vehicle_type_id IS NULL
   AND mk.vehicle_type_id IS NOT NULL;
