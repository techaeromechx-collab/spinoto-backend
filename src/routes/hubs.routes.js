const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const {
  listHubs,
  getHub,
  createHub,
  updateHub,
  toggleHub,
  deleteHub,
  verifyHub,
  rejectHub,
  getHubServices,
  saveHubServices,
  createHubLogin,
  deleteHubLogin,
  getHubLogin,
  listHubLogins,
} = require('../controllers/hubs.controller');

const {
  listDocuments,
  uploadDocument,
  deleteDocument,
} = require('../controllers/hub_documents.controller');

// ── Multer: local disk storage for hub documents ──────────────────────────────

const hubDocsDir = path.join(__dirname, '../../uploads/hub-docs');
if (!fs.existsSync(hubDocsDir)) fs.mkdirSync(hubDocsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: hubDocsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `hubdoc-${uid}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only PDF, JPG, and PNG files are allowed'));
  },
});

// ── HUB CRUD ──────────────────────────────────────────────────────────────────

router.get('/',    requireAuth, requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'VIEW_OWN_LEADS', 'VIEW_LEAD', 'VIEW_TEAM_LEADS', 'CREATE_LEAD', 'EDIT_LEAD', 'CREATE_APPOINTMENT', 'VIEW_APPOINTMENT', 'ASSIGN_LEAD'), listHubs);

// !! Static routes MUST come before /:id to avoid being swallowed by the param route !!
// ── HUB LOGIN (list all) — static route, must be before /:id ─────────────────
router.get('/logins',       requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'), listHubLogins);

router.get('/:id', requireAuth, requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS'), getHub);

router.post('/',            requireAuth, requirePermission('CREATE_HUB', 'MANAGE_HUBS'), createHub);
router.patch('/:id',        requireAuth, requirePermission('EDIT_HUB',   'MANAGE_HUBS'), updateHub);
router.patch('/:id/toggle', requireAuth, requirePermission('EDIT_HUB',   'MANAGE_HUBS'), toggleHub);
router.patch('/:id/verify', requireAuth, requirePermission('VERIFY_HUB',  'MANAGE_HUBS'), verifyHub);
router.patch('/:id/reject', requireAuth, requirePermission('VERIFY_HUB',  'MANAGE_HUBS'), rejectHub);
router.delete('/:id',       requireAuth, requirePermission('MANAGE_HUBS'),                deleteHub);

// ── HUB CATEGORY + SERVICE MAPPINGS ──────────────────────────────────────────

router.get('/:id/services', requireAuth, requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'EDIT_HUB', 'VIEW_OWN_LEADS', 'VIEW_LEAD', 'VIEW_TEAM_LEADS', 'CREATE_LEAD', 'EDIT_LEAD', 'CREATE_APPOINTMENT', 'VIEW_APPOINTMENT', 'ASSIGN_LEAD'), getHubServices);
router.put('/:id/services', requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'),              saveHubServices);

// ── HUB LOGIN (per hub) ───────────────────────────────────────────────────────

router.get('/:id/login',    requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'), getHubLogin);
router.post('/:id/login',   requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'), createHubLogin);
router.delete('/:id/login', requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'), deleteHubLogin);

// ── HUB DOCUMENTS ─────────────────────────────────────────────────────────────

router.get(
  '/:id/documents',
  requireAuth, requirePermission('VIEW_HUB', 'MANAGE_HUBS', 'EDIT_HUB'),
  listDocuments
);

router.post(
  '/:id/documents',
  requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'),
  upload.single('document'),
  uploadDocument
);

router.delete(
  '/:id/documents/:docId',
  requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'),
  deleteDocument
);

module.exports = router;
