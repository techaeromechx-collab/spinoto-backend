const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { requireAuth, requirePermission, requirePermissionOrHub, requireSuperAdmin } = require('../middleware/auth.middleware');
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
  resetHubLoginPassword,
  updateOwnHubProfile,
  getHubLogin,
  listHubLogins,
} = require('../controllers/hubs.controller');

const {
  listDocuments,
  uploadDocument,
  deleteDocument,
} = require('../controllers/hub_documents.controller');

// ── Multer storage ────────────────────────────────────────────────────────────
// Use memoryStorage when ImageKit is configured (files go straight to CDN).
// Fall back to diskStorage if ImageKit env vars are not set.

const imagekitConfigured = !!(
  process.env.IMAGEKIT_PUBLIC_KEY &&
  process.env.IMAGEKIT_PRIVATE_KEY &&
  process.env.IMAGEKIT_URL_ENDPOINT
);

let storage;
if (imagekitConfigured) {
  storage = multer.memoryStorage();
} else {
  const hubDocsDir = path.join(__dirname, '../../uploads/hub-docs');
  if (!fs.existsSync(hubDocsDir)) fs.mkdirSync(hubDocsDir, { recursive: true });
  storage = multer.diskStorage({
    destination: hubDocsDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      cb(null, `hubdoc-${uid}${ext}`);
    },
  });
}

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB cap (frontend compresses before upload)
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

// ── HUB SELF-SERVICE — also static, also before /:id ─────────────────────────
// Literally '/me', so it MUST sit above '/:id' or Express matches it as an id
// and idParam.parse('me') throws a 400 on a perfectly valid request — the same
// reason '/logins' is up here.
//
// No permission gate: the controller refuses any session without a hub_id.
// This is about WHO you are, not what you may do — a hub login can carry codes
// like CREATE_INVOICE, and a staff member has no "own hub" to update.
router.patch('/me', requireAuth, updateOwnHubProfile);

router.get('/:id', requireAuth, requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS'), getHub);

router.post('/',            requireAuth, requirePermission('CREATE_HUB',   'MANAGE_HUBS'), createHub);
router.patch('/:id',        requireAuth, requirePermission('EDIT_HUB',     'MANAGE_HUBS'), updateHub);
router.patch('/:id/toggle', requireAuth, requirePermission('ACTIVATE_HUB', 'EDIT_HUB', 'MANAGE_HUBS'), toggleHub);
router.patch('/:id/verify', requireAuth, requirePermission('VERIFY_HUB',   'MANAGE_HUBS'), verifyHub);
router.patch('/:id/reject', requireAuth, requirePermission('VERIFY_HUB',   'MANAGE_HUBS'), rejectHub);
router.delete('/:id',       requireAuth, requirePermission('DELETE_HUB',   'MANAGE_HUBS'), deleteHub);

// ── HUB CATEGORY + SERVICE MAPPINGS ──────────────────────────────────────────

router.get('/:id/services', requireAuth, requirePermissionOrHub('VIEW_HUB', 'MANAGE_HUBS', 'EDIT_HUB', 'VIEW_OWN_LEADS', 'VIEW_LEAD', 'VIEW_TEAM_LEADS', 'CREATE_LEAD', 'EDIT_LEAD', 'CREATE_APPOINTMENT', 'VIEW_APPOINTMENT', 'ASSIGN_LEAD'), getHubServices);
router.put('/:id/services', requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS'),              saveHubServices);

// ── HUB LOGIN (per hub) ───────────────────────────────────────────────────────

// requireSuperAdmin, not requirePermission. These four already demanded
// is_super_admin INSIDE the controller while the route let EDIT_HUB through, so
// a manager with MANAGE_HUBS passed the door and got a 403 from the room — a
// button that rendered and then failed. The gate is now the route's job alone,
// which is also what lets the UI hide the section from someone who cannot use
// it. Behaviour for callers is unchanged; only where the refusal happens moved.
//
// GET '/logins' above deliberately keeps the wider gate: it is a read, and the
// Users screen's Hubs tab uses it for anyone who administers hubs.
router.get('/:id/login',    requireAuth, requireSuperAdmin, getHubLogin);
router.post('/:id/login',   requireAuth, requireSuperAdmin, createHubLogin);
// Reset an existing login's password. Before this the only way to change a hub
// password was delete-and-recreate, which also dropped that user's permission
// rows and locked the hub out entirely if the email was retyped wrong.
router.patch('/:id/login',  requireAuth, requireSuperAdmin, resetHubLoginPassword);
router.delete('/:id/login', requireAuth, requireSuperAdmin, deleteHubLogin);

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
