'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/settings.controller');

const router = express.Router();

// ── Multer storage for the invoice logo ──────────────────────────────────────
// Same dual-mode pattern as hubs.routes.js: memoryStorage (straight to
// ImageKit) if ImageKit env vars are set, else diskStorage fallback.
const imagekitConfigured = !!(
  process.env.IMAGEKIT_PUBLIC_KEY &&
  process.env.IMAGEKIT_PRIVATE_KEY &&
  process.env.IMAGEKIT_URL_ENDPOINT
);

// One factory for both image assets (logo, signature) — same limits, same
// allowed types, different destination folder and filename prefix.
function imageUploader(dir, prefix) {
  let storage;
  if (imagekitConfigured) {
    storage = multer.memoryStorage();
  } else {
    const abs = path.join(__dirname, '../../uploads', dir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    storage = multer.diskStorage({
      destination: abs,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cb(null, `${prefix}-${uid}${ext}`);
      },
    });
  }
  return multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB cap
    fileFilter: (_req, file, cb) => {
      const allowed = ['.jpg', '.jpeg', '.png', '.svg', '.webp'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) return cb(null, true);
      cb(new Error('Only JPG, PNG, SVG, and WEBP files are allowed'));
    },
  });
}

const uploadLogo      = imageUploader('company-logo', 'logo');
const uploadSignature = imageUploader('company-signature', 'sig');

// Readable by anyone who generates or views invoices/estimates (needed for PDF header)
router.get('/company', requireAuth, requirePermission('MANAGE_MASTER_DATA','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE'), c.getCompany);

// Only users with MANAGE_MASTER_DATA (or super admin) can write company settings
router.put('/company', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.upsertCompany);

// Document/theme config only — never company identity. This is what the
// Invoice Settings tab saves through, so MANAGE_DOCUMENT_SETTINGS can be
// granted without also handing over company_name and gstin, which the route
// above still writes behind its super-admin check.
router.put('/company/document-config', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), c.upsertDocumentConfig);

// Invoice logo — separate endpoint so a routine company-details save can
// never accidentally clear it (controller also enforces super-admin-only)
router.post('/company/logo', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), uploadLogo.single('logo'), c.uploadLogo);
router.delete('/company/logo', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), c.deleteLogo);

// Authorised-signatory image — same pattern and permissions as the logo.
router.post('/company/signature', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), uploadSignature.single('signature'), c.uploadSignature);
router.delete('/company/signature', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), c.deleteSignature);

// Live theme preview (raw HTML, not a PDF) — renders a fixed sample invoice
// through the real theme templates so the Invoice Settings page can show a
// genuine live preview. POST because the body carries the caller's UNSAVED
// invoice_config (too large for a query string); GET is kept so the small
// theme-strip thumbnails, which only need ?theme=&color=, stay cacheable.
router.get ('/company/invoice-theme-preview', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), c.previewInvoiceTheme);
router.post('/company/invoice-theme-preview', requireAuth, requirePermission('MANAGE_DOCUMENT_SETTINGS'), c.previewInvoiceTheme);

// GST state codes for the Place of Supply selector — readable by anyone who
// can edit an invoice, not just super admins.
router.get('/gst-states', requireAuth, c.listGstStates);

// Alert threshold settings.
//
// Previously the comment here claimed "super admin only (controller enforces
// this)" — but only the PUT handler checked. The GET had no check at all, so
// any authenticated user could read the thresholds. Both are now gated on the
// permission, which super admins bypass as usual.
// Accounting period lock. Its own permission, deliberately not bundled with
// document settings or PUT /company (which would expose the GSTIN).
router.get('/books-lock', requireAuth, requirePermission('MANAGE_BOOKS_LOCK'), c.getBooksLock);
router.put('/books-lock', requireAuth, requirePermission('MANAGE_BOOKS_LOCK'), c.upsertBooksLock);
router.get('/alert', requireAuth, requirePermission('MANAGE_REMINDERS'), c.getAlertSettings);
router.put('/alert', requireAuth, requirePermission('MANAGE_REMINDERS'), c.upsertAlertSettings);

module.exports = router;
