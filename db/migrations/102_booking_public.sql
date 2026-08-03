-- ═════════════════════════════════════════════════════════════════════════════
-- 102: Public booking API (booking.spinoto.com → CRM)
--
-- booking.spinoto.com is a frontend-only SPA. Until it grows its own backend,
-- the CRM serves it directly through /api/public/booking/*. This migration
-- adds the three tables that path needs, plus the master-data rows for the
-- exactly-three packages the landing page sells.
--
--   booking_packages — maps the 3 landing-page tiers to REAL services rows.
--       The price is NOT stored here: it is resolved at request time from the
--       normal pricing engine (pricing rules → services.customer_rate), so
--       changing a price in the CRM changes it on the landing page. Only the
--       marketing copy (title / tagline / feature deltas) lives here.
--       fallback_price is a last-resort so the page never renders blank.
--
--   booking_orders — one row per "Pay" tap. Survives a server restart, gives
--       an audit trail, and is the idempotency anchor for verify-payment.
--
--   booking_otps   — short-lived OTP challenges (hashed, never plaintext).
--
-- IMPORTANT (CLAUDE.md invariants): nothing here touches the `pricing` table,
-- its specificity scores, or the inc-GST convention. Packages are ordinary
-- `services` rows and are priced by the ordinary engine.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Landing-page package map ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_packages (
  id                SERIAL PRIMARY KEY,
  slug              VARCHAR(40)  NOT NULL UNIQUE,          -- basic | standard | comprehensive
  service_id        INTEGER      NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title             VARCHAR(120) NOT NULL,
  tagline           VARCHAR(160),
  -- Feature DELTA for this tier — only what it ADDS over the previous one.
  -- The UI composes the cumulative list; a full list here renders 3× over.
  features          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  includes_previous VARCHAR(40),                            -- 'Basic' | 'Standard' | NULL
  is_popular        BOOLEAN      NOT NULL DEFAULT FALSE,
  fallback_price    NUMERIC(12,2),
  sort_order        INT          NOT NULL DEFAULT 0,
  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_packages_sort
  ON booking_packages (sort_order ASC);

-- ─── 2. Orders placed on the landing page ────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_orders (
  id                  SERIAL PRIMARY KEY,
  order_ref           VARCHAR(60)  NOT NULL UNIQUE,  -- ours; becomes appointments.external_ref
  mobile              VARCHAR(20)  NOT NULL,
  package_slug        VARCHAR(40),
  amount              NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency            VARCHAR(8)   NOT NULL DEFAULT 'INR',
  payload             JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- validated booking snapshot
  razorpay_order_id   VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  -- created → paid → synced   (failed on a hard error)
  status              VARCHAR(20)  NOT NULL DEFAULT 'created',
  appointment_id      INTEGER      REFERENCES appointments(id) ON DELETE SET NULL,
  error_text          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_orders_rzp_order
  ON booking_orders (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_orders_mobile  ON booking_orders (mobile);
CREATE INDEX IF NOT EXISTS idx_booking_orders_status  ON booking_orders (status);
CREATE INDEX IF NOT EXISTS idx_booking_orders_created ON booking_orders (created_at DESC);

-- ─── 3. OTP challenges ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_otps (
  mobile      VARCHAR(20)  PRIMARY KEY,
  code_hash   TEXT         NOT NULL,       -- sha256(mobile + ':' + code + ':' + pepper)
  expires_at  TIMESTAMPTZ  NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_otps_expiry ON booking_otps (expires_at);

-- ─── 3b. "Notify me when you cover my area" waitlist ─────────────────────────
-- A visitor who passed OTP but whose pincode is outside the serviceable list.
-- Deliberately its own table rather than a lead: these are demand signals for
-- siting the next hub, not sales leads, and nobody should have to filter them
-- out of the leads pipeline.
CREATE TABLE IF NOT EXISTS booking_waitlist (
  id           SERIAL PRIMARY KEY,
  mobile       VARCHAR(20) NOT NULL,
  lat          NUMERIC(10,7),
  lng          NUMERIC(10,7),
  pincode      VARCHAR(10),
  vehicle_type VARCHAR(4),
  utm          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_waitlist_mobile  ON booking_waitlist (mobile);
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_pincode ON booking_waitlist (pincode);
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_created ON booking_waitlist (created_at DESC);

-- ─── 4. updated_at triggers (function already exists from 021) ───────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'booking_packages_updated_at') THEN
    CREATE TRIGGER booking_packages_updated_at BEFORE UPDATE ON booking_packages
      FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'booking_orders_updated_at') THEN
    CREATE TRIGGER booking_orders_updated_at BEFORE UPDATE ON booking_orders
      FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- SEED — the category, the three services, and the three package rows.
-- All idempotent: re-running never duplicates and never overwrites prices an
-- admin has since changed in the CRM.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO service_categories (name, vehicle_class, pricing_config, sort_order)
VALUES (
  'Booking Packages',
  'both',
  -- UI hint only (CLAUDE.md invariant #4): does not affect pricing lookup.
  '["vehicle_type","body_type","make","model"]'::jsonb,
  0
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO services (category_id, name, description, vehicle_class, customer_rate, gst_percent, sort_order)
SELECT sc.id, v.svc_name, v.descr, 'both', v.rate, 18, v.ord
FROM service_categories sc
CROSS JOIN (VALUES
  ('Basic Service',
   'Entry tier sold on booking.spinoto.com — essential periodic service.',
   1499.00, 1),
  ('Standard Service',
   'Mid tier sold on booking.spinoto.com — everything in Basic, plus diagnostics.',
   2499.00, 2),
  ('Comprehensive Service',
   'Top tier sold on booking.spinoto.com — everything in Standard, plus wheels & deep clean.',
   3999.00, 3)
) AS v(svc_name, descr, rate, ord)
WHERE sc.name = 'Booking Packages'
ON CONFLICT (category_id, name) DO NOTHING;

INSERT INTO booking_packages
  (slug, service_id, title, tagline, features, includes_previous, is_popular, fallback_price, sort_order)
SELECT v.slug, s.id, v.title, v.tagline, v.features::jsonb, v.includes_previous, v.is_popular, v.fallback_price, v.ord
FROM services s
JOIN service_categories sc ON sc.id = s.category_id AND sc.name = 'Booking Packages'
JOIN (VALUES
  ('basic', 'Basic Service', 'Basic Service', 'The essential care',
   '["Engine Oil Replacement","Oil Filter Replacement","Air Filter Cleaning","Coolant Top-up","Spark Plug Inspection","Battery Water Check","Interior Vacuum Cleaning","Exterior Washing","Tire & Dashboard Polishing","Road Test After Service"]',
   NULL::varchar, FALSE, 1499.00, 1),
  ('standard', 'Standard Service', 'Standard Service', 'Most popular',
   '["Air Filter Replacement","Brake Fluid Top-up","Fuel Filter Inspection","Brake Pad Check","Full Vehicle Diagnosis","AC Performance Check","Suspension Check"]',
   'Basic'::varchar, TRUE, 2499.00, 2),
  ('comprehensive', 'Comprehensive Service', 'Comprehensive Service', 'The full works',
   '["Brake Shoe Service","Wheel Balancing","Wheel Alignment","Tire Rotation","Gear Oil Top-up","Throttle Body Cleaning","Complete Vehicle Inspection","Full Exterior + Interior Cleaning","AC Filter Replacement"]',
   'Standard'::varchar, FALSE, 3999.00, 3)
) AS v(slug, svc_name, title, tagline, features, includes_previous, is_popular, fallback_price, ord)
  ON v.svc_name = s.name
ON CONFLICT (slug) DO NOTHING;

COMMIT;
