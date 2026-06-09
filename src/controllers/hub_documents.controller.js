/**
 * Hub Documents controller
 *
 * Handles upload / list / delete of documents attached to a hub.
 * Files are uploaded to ImageKit CDN when env vars are set.
 * Falls back to local disk storage if ImageKit is not configured.
 */

const { z }    = require('zod');
const { pool } = require('../config/db');
const path     = require('path');
const fs       = require('fs');
const { uploadToImageKit, deleteFromImageKit } = require('../utils/imagekit');

const idParam = z.coerce.number().int().positive();

function imagekitEnabled() {
  return !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT);
}

const VALID_DOC_TYPES = [
  'aadhaar',
  'pan',
  'driving_license',
  'agreement',
  'gst_certificate',
  'hub_image',    // Hub profile / exterior photo
  'bank_proof',   // Cancelled cheque or bank passbook proof
];

// ── Error handler ────────────────────────────────────────────────────────────

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
}

// ── Helper: resolve disk path from a file_url ────────────────────────────────

function diskPath(fileUrl) {
  return path.join(__dirname, '../../uploads/hub-docs', path.basename(fileUrl));
}

function safeUnlink(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ── GET /api/hubs/:id/documents ──────────────────────────────────────────────

function listDocuments(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.id);
    const r = await pool.query(
      'SELECT * FROM hub_documents WHERE hub_id = $1 ORDER BY doc_type ASC',
      [hubId]
    );
    res.json({ items: r.rows });
  });
}

// ── POST /api/hubs/:id/documents ─────────────────────────────────────────────
// multer processes the file BEFORE this handler runs.

function uploadDocument(req, res, next) {
  handle(req, res, next, async () => {
    const hubId  = idParam.parse(req.params.id);
    const docType = req.body?.doc_type;

    // Validate doc_type before touching the DB
    if (!VALID_DOC_TYPES.includes(docType)) {
      if (req.file) safeUnlink(req.file.path);
      return res.status(400).json({
        error: `doc_type must be one of: ${VALID_DOC_TYPES.join(', ')}`,
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Verify hub exists
    const hubRes = await pool.query(
      'SELECT id FROM hubs WHERE id = $1 AND deleted_at IS NULL',
      [hubId]
    );
    if (hubRes.rowCount === 0) {
      safeUnlink(req.file.path);
      return res.status(404).json({ error: 'HUB not found' });
    }

    // If a file of this type already exists, delete the old one
    const existing = await pool.query(
      'SELECT file_url, imagekit_file_id FROM hub_documents WHERE hub_id = $1 AND doc_type = $2',
      [hubId, docType]
    );
    if (existing.rowCount > 0) {
      const old = existing.rows[0];
      if (old.imagekit_file_id) {
        // Delete from ImageKit
        await deleteFromImageKit(old.imagekit_file_id);
      } else {
        // Delete from local disk (legacy)
        safeUnlink(diskPath(old.file_url));
      }
    }

    let fileUrl        = null;
    let imagekitFileId = null;
    const uploadedBy   = req.user?.id || null;

    if (imagekitEnabled()) {
      // Upload to ImageKit
      const folder = `hub-docs/${docType}`;
      const result = await uploadToImageKit(req.file.buffer, req.file.originalname, folder);
      fileUrl        = result.url;
      imagekitFileId = result.fileId;
      // Clean up temp file if disk storage was used
      if (req.file.path) safeUnlink(req.file.path);
    } else {
      // Fallback: local disk
      fileUrl = `/uploads/hub-docs/${req.file.filename}`;
    }

    const r = await pool.query(
      `INSERT INTO hub_documents (hub_id, doc_type, file_name, file_url, uploaded_by, imagekit_file_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (hub_id, doc_type)
       DO UPDATE SET
         file_name          = EXCLUDED.file_name,
         file_url           = EXCLUDED.file_url,
         uploaded_at        = NOW(),
         uploaded_by        = EXCLUDED.uploaded_by,
         imagekit_file_id   = EXCLUDED.imagekit_file_id
       RETURNING *`,
      [hubId, docType, req.file.originalname, fileUrl, uploadedBy, imagekitFileId]
    );

    res.status(201).json({ item: r.rows[0] });
  });
}

// ── DELETE /api/hubs/:id/documents/:docId ────────────────────────────────────

function deleteDocument(req, res, next) {
  handle(req, res, next, async () => {
    const hubId = idParam.parse(req.params.id);
    const docId = idParam.parse(req.params.docId);

    const r = await pool.query(
      'SELECT * FROM hub_documents WHERE id = $1 AND hub_id = $2',
      [docId, hubId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Document not found' });

    const doc = r.rows[0];
    if (doc.imagekit_file_id) {
      await deleteFromImageKit(doc.imagekit_file_id);
    } else {
      safeUnlink(diskPath(doc.file_url));
    }

    await pool.query('DELETE FROM hub_documents WHERE id = $1', [docId]);
    res.status(204).end();
  });
}

module.exports = { listDocuments, uploadDocument, deleteDocument };
