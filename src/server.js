/* FIRST. Before dotenv, before any require that might format a Date.
   Node caches the zone the first time one is used, so setting process.env.TZ
   after that point changes the variable and not the behaviour — which looks
   exactly like the fix working until somebody checks a timestamp. */
require('./utils/appTime').applyProcessTimezone();

require('dotenv').config();

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const zlib    = require('zlib');
const compression = require('compression');
const { initIO } = require('./socket');

const { pool } = require('./config/db');
const { ensureSeedPasswords } = require('./utils/seedPasswords');
const { startScheduler } = require('./scheduler');
const { startReminderPoller } = require('./services/appointmentReminders.service');
const { startWhatsappOutbox } = require('./services/whatsappOutbox.service');
const { startIntegrationSettings } = require('./services/integrationSettings.service');

const authRoutes      = require('./routes/auth.routes');
const meRoutes        = require('./routes/me.routes');
const usersRoutes     = require('./routes/users.routes');
const locationsRoutes = require('./routes/locations.routes');
const vehiclesRoutes  = require('./routes/vehicles.routes');
const servicesRoutes  = require('./routes/services.routes');
const pricingRoutes   = require('./routes/pricing.routes');
const leadsRoutes          = require('./routes/leads.routes');
const leadStatusesRoutes   = require('./routes/lead_statuses.routes');
const leadSourcesRoutes    = require('./routes/lead_sources.routes');
const importRoutes         = require('./routes/import.routes');
const reportsRoutes      = require('./routes/reports.routes');
const ccCategoriesRoutes = require('./routes/cc_categories.routes');
const leadEventsRoutes       = require('./routes/lead_events.routes');
const notificationsRoutes    = require('./routes/notifications.routes');
const leadNotesRoutes        = require('./routes/lead_notes.routes');
const leadActivitiesRoutes   = require('./routes/lead_activities.routes');
const departmentsRoutes          = require('./routes/departments.routes');
const hubsRoutes                 = require('./routes/hubs.routes');
const workshopsRoutes            = require('./routes/workshops.routes');
const appointmentStatusesRoutes  = require('./routes/appointment_statuses.routes');
const invoiceStatusesRoutes      = require('./routes/invoice_statuses.routes');
const appointmentsRoutes         = require('./routes/appointments.routes');
const customersRoutes            = require('./routes/customers.routes');
const invoicesRoutes             = require('./routes/invoices.routes');
// invoice_payments.routes is deliberately not required — see the note at its
// former mount below. Requiring it here would leave a router built and ready
// for one line to re-enable by accident.
const partsRoutes                = require('./routes/parts.routes');
const estimatesRoutes            = require('./routes/estimates.routes');
const settingsRoutes             = require('./routes/settings.routes');
const rolesRoutes                = require('./routes/roles.routes');
const logsRoutes                 = require('./routes/logs.routes');
const discountMasterRoutes       = require('./routes/discount_master.routes');
const warrantyMasterRoutes       = require('./routes/warranty_master.routes');
const warrantyClaimsRoutes       = require('./routes/warranty_claims.routes');
const integrationsRoutes         = require('./routes/integrations.routes');
const publicBookingRoutes        = require('./routes/public.booking.routes');
const publicDocumentsRoutes      = require('./routes/public.documents.routes');
const whatsappRoutes             = require('./routes/whatsapp.routes');
// Read-only master data for outside systems. Key-authenticated, versioned
// separately from the internal /api/* routes so its shape can stay stable
// while those keep changing with the frontend.
const v1MasterRoutes             = require('./routes/v1_master.routes');
// Admin side of the same feature: issuing and revoking those keys.
const apiKeysRoutes              = require('./routes/api_keys.routes');
const callOutcomesRoutes         = require('./routes/call_outcomes.routes');
const lostReasonsRoutes          = require('./routes/lost_reasons.routes');
const competitorsRoutes          = require('./routes/competitors.routes');
const pushRoutes                 = require('./routes/push.routes');

const app = express();

// ── WHO THE CLIENT IS, FOR RATE LIMITING ─────────────────────────────────────
//
// Every rate limit in this application is keyed on req.ip, and req.ip is only
// the real client when Express knows how many proxies sit in front of it.
//
// TRUST_PROXY is a HOP COUNT, not a boolean, and the number matters:
//
//   unset / 0  → no proxy. req.ip is the socket address and any
//                X-Forwarded-For a caller sends is ignored. Correct for a
//                directly-exposed server.
//   1          → one trusted hop (Render, Railway, Fly, a single nginx).
//   2          → e.g. Cloudflare in front of a platform proxy.
//
// Setting it too HIGH is the dangerous direction: Express then walks further
// left into the forwarded chain than any trusted hop actually wrote, and reads
// an address the caller supplied — which is what the limiter used to do
// unconditionally, and which let one caller occupy an unlimited number of rate
// buckets by sending a different value each request.
//
// Setting it too LOW is merely inconvenient: every request appears to come from
// the proxy, so one bucket is shared by everybody. Safe, and loud.
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);
if (TRUST_PROXY > 0) {
  app.set('trust proxy', TRUST_PROXY);
  console.log(`[http] trusting ${TRUST_PROXY} proxy hop(s) for client IP`);
} else if (process.env.NODE_ENV === 'production') {
  // Worth saying out loud: in production this almost always means the limits
  // are counting the load balancer rather than the caller.
  console.warn('[http] TRUST_PROXY is not set — rate limits will key on the '
    + 'connecting address. If this server is behind a proxy, set TRUST_PROXY to the hop count.');
}

// ---- Middleware ----------------------------------------------------------
// Response compression — negotiated via the client's Accept-Encoding header
// (browsers send "gzip, deflate, br" → brotli wins; older clients get gzip;
// no header → uncompressed). Measured on a typical 60 KB list response:
// gzip ≈ 7% of raw, brotli(q4) ≈ 3.4% of raw.
//  - threshold 1 KB: tiny responses aren't worth the header overhead
//  - default filter: only compressible content-types (JSON/text/HTML/SVG…);
//    images/PDFs under /uploads and any response that already has a
//    Content-Encoding are skipped — no double compression
//  - brotli quality pinned to 4: near-best ratio at ~1–2 ms per response;
//    the default (11) is designed for static assets and is far too slow
//    for dynamic API responses
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false; // debugging escape hatch
    return compression.filter(req, res);
  },
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
}));

// Support multiple allowed origins (comma-separated in CORS_ORIGIN env var)
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (allowedOrigins.includes('*') && process.env.NODE_ENV === 'production') {
  console.warn('[cors] CORS_ORIGIN is not set — all origins are allowed. Set CORS_ORIGIN in production.');
}
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  // Auth uses Bearer tokens (Authorization header), not cookies — so
  // credentials are not needed. Never combine credentials with origin '*'.
  credentials: false,
  // Response headers are invisible to cross-origin JS unless listed here, and
  // the frontend and API are on different ports in development.
  //   X-Page-Size         — the sheet the theme preview rendered for (A4/A5)
  //   Content-Disposition — the PDF's filename. The client fetches the PDF with
  //     a Bearer token and wraps it in a blob URL, and a blob URL carries no
  //     name, so the browser would otherwise save it as its blob UUID. The
  //     client has to read the name from this header and apply it itself.
  exposedHeaders: ['X-Page-Size', 'Content-Disposition'],
}));
app.use(express.json({
  limit: '2mb',
  // Keep the raw bytes for signature verification.
  //
  // Interakt signs webhooks with HMAC-SHA256 over the EXACT body it sent.
  // Re-serialising the parsed object would produce different bytes — key order,
  // whitespace and number formatting all differ — and every signature check
  // would fail. Only the WhatsApp webhook reads this; the cost elsewhere is one
  // retained Buffer reference per request.
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---- Static: uploaded hub documents -------------------------------------
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ---- Health --------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, db_time: r.rows[0].now });
  } catch (err) {
    console.error('[health]', err);
    res.status(500).json({ ok: false, error: 'Database unreachable' });
  }
});

// ---- Routes --------------------------------------------------------------
app.use('/api/auth',      authRoutes);
app.use('/api/me',        meRoutes);
app.use('/api/users',     usersRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/vehicles',  vehiclesRoutes);
app.use('/api/services',  servicesRoutes);
app.use('/api/pricing',   pricingRoutes);
app.use('/api/leads',         leadsRoutes);
app.use('/api/lead-statuses', leadStatusesRoutes);
app.use('/api/lead-sources',  leadSourcesRoutes);
app.use('/api/import',         importRoutes);
app.use('/api/reports',        reportsRoutes);
app.use('/api/cc-categories',  ccCategoriesRoutes);
app.use('/api/lead-events',      leadEventsRoutes);
app.use('/api/notifications',    notificationsRoutes);
app.use('/api/lead-notes',       leadNotesRoutes);
app.use('/api/lead-activities',  leadActivitiesRoutes);
app.use('/api/departments',          departmentsRoutes);
app.use('/api/hubs',                 hubsRoutes);
app.use('/api/workshops',            workshopsRoutes);
app.use('/api/appointment-statuses', appointmentStatusesRoutes);
app.use('/api/invoice-statuses',     invoiceStatusesRoutes);
app.use('/api/appointments',         appointmentsRoutes);
app.use('/api/customers',            customersRoutes);
app.use('/api/invoices',                    invoicesRoutes);

// NOT MOUNTED: /api/invoices/:id/payments (routes/invoice_payments.routes.js).
//
// It operated on `invoice_payments` (migration 023) — a table superseded by
// customer_invoice_payments, which is the money ledger every other feature
// reads. Nothing in the app reached these endpoints any more: InvoicesPage.jsx
// is no longer imported by App.jsx and /invoices redirects to
// /customer-invoices. But the routes stayed mounted, and they were materially
// weaker than the ones that replaced them:
//
//   • EDIT_INVOICE alone authorised DELETING a payment, where the customer
//     invoice equivalent requires its own DELETE_INVOICE_PAYMENT permission;
//   • no hub scoping of any kind — no assertHubOwns, no hubScopeSql — so a hub
//     login could read and delete payments belonging to any hub;
//   • no status recalculation, so anything written here never reached an
//     invoice's status, the hub payout schedule or a warranty claim;
//   • no CHECK constraint on `method`, and no audit log;
//   • a transaction leaked on the delete handler's 404 branch.
//
// Unreachable UI over a live, weakly-guarded door is the worst of both: nobody
// exercises it, so nobody notices it. The router file and its controller are
// left on disk — the table still holds historical rows, and deleting the code
// that can read them is a separate decision from closing the door.
// app.use('/api/invoices/:id/payments', require('./routes/invoice_payments.routes'));

app.use('/api/parts',             partsRoutes);
app.use('/api/estimates',         estimatesRoutes);
app.use('/api/discount-master',   discountMasterRoutes);
app.use('/api/warranty-master',   warrantyMasterRoutes);
app.use('/api/warranty-claims',   warrantyClaimsRoutes);
app.use('/api/integrations',      integrationsRoutes);
app.use('/api/v1/master',         v1MasterRoutes);
app.use('/api/api-keys',          apiKeysRoutes);
// UNAUTHENTICATED — booking.spinoto.com. Rate-limited inside the router;
// requires https://booking.spinoto.com in CORS_ORIGIN.
app.use('/api/public/booking',    publicBookingRoutes);
// UNAUTHENTICATED — customer invoice links (WhatsApp message + the QR already
// printed on every invoice, which until now led to a login screen). Serves a
// PDF built from a deliberately narrow SELECT; see the header of
// public.documents.controller.js before touching it.
app.use('/api/public/documents',  publicDocumentsRoutes);
app.use('/api/call-outcomes',     callOutcomesRoutes);
app.use('/api/lost-reasons',      lostReasonsRoutes);
app.use('/api/competitors',       competitorsRoutes);
app.use('/api/whatsapp',          whatsappRoutes);
app.use('/api/settings',   settingsRoutes);

const purchaseInvoicesRouter = require('./routes/purchase_invoices.routes');
const customerInvoicesRouter = require('./routes/customer_invoices.routes');
app.use('/api/purchase-invoices', purchaseInvoicesRouter);
app.use('/api/customer-invoices', customerInvoicesRouter);

// Payments. The authenticated surface only — the public pay page and the
// gateway webhook are mounted separately below, so nothing can be added to this
// router and accidentally end up reachable without a session.
const paymentsRouter = require('./routes/payments.routes');
app.use('/api/payments', paymentsRouter);

// Money OUT. Its own mount for the same reason it is its own router: sending
// funds to a hub is gated on PAY_HUB_ONLINE, which nothing else in the system
// grants. Authenticated — the RazorpayX webhook that reports the RESULT is
// mounted with the other webhooks below.
const hubPayoutsRouter = require('./routes/hub_payouts.routes');
app.use('/api/hub-payouts', hubPayoutsRouter);

// UNAUTHENTICATED — the payment gateway posts here. Its credential is the
// HMAC-SHA256 signature over the request body, verified against
// RAZORPAY_WEBHOOK_SECRET before anything else runs. The raw bytes it signs are
// the ones express.json's verify hook parked on req.rawBody above; re-encoding
// the parsed object would produce different bytes and fail every check.
//
// Without this endpoint, any customer whose browser closes before the checkout
// callback fires has paid money we never record — which on a phone, mid
// UPI app-switch, is a routine occurrence rather than an edge case.
const paymentWebhookRoutes = require('./routes/webhooks.payments.routes');
app.use('/api/webhooks', paymentWebhookRoutes);

// UNAUTHENTICATED — the customer's pay-by-link page. Rate-limited inside the
// router; returns a deliberately narrow projection of the invoice (number,
// amount due, masked mobile) because a payment URL gets forwarded. See the
// header of public.payments.controller.js.
const publicPaymentsRoutes = require('./routes/public.payments.routes');
app.use('/api/public/pay', publicPaymentsRoutes);

app.use('/api/roles', rolesRoutes);
app.use('/api/push',  pushRoutes);
app.use('/api/logs',  logsRoutes);

// Stubs for upcoming modules — every module will plug in here.

// ---- 404 + error handler -------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  // Only expose messages for intentional errors (err.status set by our code).
  // Unexpected 500s (pg errors etc.) must not leak internals to the client.
  const message = err.status ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
});

// ---- Boot ----------------------------------------------------------------
const PORT = process.env.PORT || 4000;

(async () => {
  try {
    // Make sure seeded users have valid bcrypt hashes for documented passwords.
    await ensureSeedPasswords();
  } catch (err) {
    console.warn('[seed] could not refresh seed passwords:', err.message);
  }
  // Fix null-body no_activity notifications created before body text was added
  pool.query(
    `UPDATE notifications
     SET body = 'No lead activity logged in 2+ hours. Please update your leads.'
     WHERE type = 'no_activity' AND (body IS NULL OR body = '')`
  ).catch(() => {});

  // Ensure all users have new notification types enabled by default
  pool.query(
    `UPDATE users
     SET notification_settings = notification_settings
       || '{"follow_up_scheduled": true, "appointment_reminder": true, "note_added": true, "pricing_changed": true, "reference_data_changed": true}'::jsonb
     WHERE NOT (notification_settings ? 'follow_up_scheduled')
        OR NOT (notification_settings ? 'appointment_reminder')
        OR NOT (notification_settings ? 'note_added')
        OR NOT (notification_settings ? 'pricing_changed')
        OR NOT (notification_settings ? 'reference_data_changed')`
  ).catch(() => {});

  const httpServer = http.createServer(app);
  initIO(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`Spinoto API listening on http://localhost:${PORT}`);
    startScheduler();
    startReminderPoller();
    // Primes the DB-stored provider credentials (Interakt key, webhook
    // secret, test number — migration 152) into the in-process cache and
    // keeps them fresh. BEFORE the outbox starts, so its very first
    // isConfigured() check can already see a database-stored key.
    startIntegrationSettings(pool);
    // Drains wa_messages. Safe to start unconditionally: with no API key it
    // logs a warning and claims nothing, and with every template disabled it
    // finds nothing to claim. Nothing reaches a customer until a template is
    // explicitly enabled in Settings → WhatsApp.
    startWhatsappOutbox();
  });
})();
