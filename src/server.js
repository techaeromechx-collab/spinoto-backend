require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');

const { pool } = require('./config/db');
const { ensureSeedPasswords } = require('./utils/seedPasswords');
const { startScheduler } = require('./scheduler');
const { startReminderPoller } = require('./services/appointmentReminders.service');

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
const appointmentStatusesRoutes  = require('./routes/appointment_statuses.routes');
const invoiceStatusesRoutes      = require('./routes/invoice_statuses.routes');
const appointmentsRoutes         = require('./routes/appointments.routes');
const customersRoutes            = require('./routes/customers.routes');
const invoicesRoutes             = require('./routes/invoices.routes');
const invoicePaymentsRoutes      = require('./routes/invoice_payments.routes');
const partsRoutes                = require('./routes/parts.routes');
const estimatesRoutes            = require('./routes/estimates.routes');
const settingsRoutes             = require('./routes/settings.routes');
const rolesRoutes                = require('./routes/roles.routes');
const logsRoutes                 = require('./routes/logs.routes');
const discountMasterRoutes       = require('./routes/discount_master.routes');
const pushRoutes                 = require('./routes/push.routes');

const app = express();

// ---- Middleware ----------------------------------------------------------
// Support multiple allowed origins (comma-separated in CORS_ORIGIN env var)
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---- Static: uploaded hub documents -------------------------------------
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ---- Health --------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, db_time: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
app.use('/api/appointment-statuses', appointmentStatusesRoutes);
app.use('/api/invoice-statuses',     invoiceStatusesRoutes);
app.use('/api/appointments',         appointmentsRoutes);
app.use('/api/customers',            customersRoutes);
app.use('/api/invoices',                    invoicesRoutes);
app.use('/api/invoices/:id/payments',       invoicePaymentsRoutes);

app.use('/api/parts',             partsRoutes);
app.use('/api/estimates',         estimatesRoutes);
app.use('/api/discount-master',   discountMasterRoutes);
app.use('/api/settings',   settingsRoutes);

const purchaseInvoicesRouter = require('./routes/purchase_invoices.routes');
const customerInvoicesRouter = require('./routes/customer_invoices.routes');
app.use('/api/purchase-invoices', purchaseInvoicesRouter);
app.use('/api/customer-invoices', customerInvoicesRouter);

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
  res.status(status).json({ error: err.message || 'Internal server error' });
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
       || '{"follow_up_scheduled": true, "appointment_reminder": true, "note_added": true}'::jsonb
     WHERE NOT (notification_settings ? 'follow_up_scheduled')
        OR NOT (notification_settings ? 'appointment_reminder')
        OR NOT (notification_settings ? 'note_added')`
  ).catch(() => {});

  app.listen(PORT, () => {
    console.log(`Spinoto API listening on http://localhost:${PORT}`);
    startScheduler();
    startReminderPoller();
  });
})();
