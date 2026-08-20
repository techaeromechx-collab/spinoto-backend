const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const {
  listWorkshops,
  getWorkshop,
  createWorkshop,
  updateWorkshop,
  deleteWorkshop,
  approveWorkshop,
  rejectWorkshop,
  dropWorkshop,
  convertWorkshop,
  uploadPhoto,
  deletePhoto,
} = require('../controllers/workshops.controller');

// ── Photo upload ─────────────────────────────────────────────────────────────
// Same storage arrangement as hub documents so there is one place files land,
// but its own directory: workshop photos belong to prospects, most of whom
// never become hubs, and mixing them into hub-docs would make them impossible
// to clear out later.
const imagekitConfigured = !!(
  process.env.IMAGEKIT_PUBLIC_KEY &&
  process.env.IMAGEKIT_PRIVATE_KEY &&
  process.env.IMAGEKIT_URL_ENDPOINT
);

let storage;
if (imagekitConfigured) {
  storage = multer.memoryStorage();
} else {
  const photoDir = path.join(__dirname, '../../uploads/workshop-photos');
  if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
  storage = multer.diskStorage({
    destination: photoDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      cb(null, `wsphoto-${uid}${ext}`);
    },
  });
}

const upload = multer({
  storage,
  // 4 MB rather than the documents' 2 MB: a document is a scan of a form, a
  // site photo is a phone camera shot of a workshop floor and compresses worse.
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Images only. A photo of the premises is the whole point — a PDF here
    // would be a document, and documents are collected at conversion.
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only JPG, PNG and WEBP images are allowed'));
  },
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

router.get('/',    requireAuth, requirePermission('VIEW_WORKSHOP', 'MANAGE_HUBS'), listWorkshops);
router.get('/:id', requireAuth, requirePermission('VIEW_WORKSHOP', 'MANAGE_HUBS'), getWorkshop);

router.post('/',      requireAuth, requirePermission('CREATE_WORKSHOP', 'MANAGE_HUBS'), createWorkshop);
router.patch('/:id',  requireAuth, requirePermission('EDIT_WORKSHOP',   'MANAGE_HUBS'), updateWorkshop);
router.delete('/:id', requireAuth, requirePermission('DELETE_WORKSHOP', 'MANAGE_HUBS'), deleteWorkshop);

// ── Lifecycle ────────────────────────────────────────────────────────────────

router.patch('/:id/approve', requireAuth, requirePermission('APPROVE_WORKSHOP', 'MANAGE_HUBS'), approveWorkshop);
router.patch('/:id/reject',  requireAuth, requirePermission('APPROVE_WORKSHOP', 'MANAGE_HUBS'), rejectWorkshop);
// Dropping is not a judgement, just an admission the conversation ended, so it
// sits with editing rather than with approval.
router.patch('/:id/drop',    requireAuth, requirePermission('EDIT_WORKSHOP',    'MANAGE_HUBS'), dropWorkshop);

// ── Convert ──────────────────────────────────────────────────────────────────
//
// TWO permission checks, both required. Conversion creates a real hub, so
// CONVERT_WORKSHOP on its own would be a back door: anyone holding it could
// mint hubs without ever being granted CREATE_HUB. Chaining the middleware
// means both must pass.
//
// MANAGE_HUBS satisfies either check on its own — it is the legacy full-access
// code and already implies both.
router.post(
  '/:id/convert',
  requireAuth,
  requirePermission('CONVERT_WORKSHOP', 'MANAGE_HUBS'),
  requirePermission('CREATE_HUB',       'MANAGE_HUBS'),
  convertWorkshop
);

// ── Photos ───────────────────────────────────────────────────────────────────

router.post('/:id/photos', requireAuth, requirePermission('EDIT_WORKSHOP', 'MANAGE_HUBS'),
  upload.single('file'), uploadPhoto);

router.delete('/:id/photos/:photoId', requireAuth, requirePermission('EDIT_WORKSHOP', 'MANAGE_HUBS'),
  deletePhoto);

module.exports = router;
