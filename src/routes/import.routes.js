const express = require('express');
const multer  = require('multer');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/import.controller');

const router = express.Router();

// 25 MB file size limit enforced at the multer level
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 },
});

// Multer error handler — converts multer's LIMIT_FILE_SIZE into a clean JSON error
function handleUploadError(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error:   'File size exceeds the 25 MB limit. Please reduce your file size and try again.',
      code:    'FILE_TOO_LARGE',
    });
  }
  next(err);
}

// Permission sets
const canUpload         = [requireAuth, requirePermission('BULK_UPLOAD', 'MANAGE_MASTER_DATA')];
const canUploadVehicles = [requireAuth, requirePermission('BULK_UPLOAD_VEHICLE', 'BULK_UPLOAD', 'MANAGE_MASTER_DATA')];
const canUploadPricing  = [requireAuth, requirePermission('BULK_UPLOAD_PRICING', 'BULK_UPLOAD', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];

// ── Upload endpoints ──────────────────────────────────────────────────────────
router.post('/leads',     canUpload,         upload.single('file'), handleUploadError, c.importLeads);
router.post('/locations', canUpload,         upload.single('file'), handleUploadError, c.importLocations);
router.post('/vehicles',  canUploadVehicles, upload.single('file'), handleUploadError, c.importVehicles);
router.post('/services',  canUpload,         upload.single('file'), handleUploadError, c.importServices);
router.post('/parts',     canUpload,         upload.single('file'), handleUploadError, c.importParts);
router.post('/pricing',   canUploadPricing,  upload.single('file'), handleUploadError, c.importPricing);

// ── Template download endpoints ────────────────────────────────────────────────
// GET /api/import/template/:type?format=csv   → download CSV template
// GET /api/import/template/:type?format=xlsx  → download Excel template
router.get('/template/:type', requireAuth, requirePermission('BULK_UPLOAD','BULK_UPLOAD_VEHICLE','BULK_UPLOAD_PRICING','MANAGE_MASTER_DATA','MANAGE_PRICING'), c.downloadTemplate);

module.exports = router;
