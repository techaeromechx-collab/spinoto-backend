/**
 * Hub Documents controller
 *
 * Handles upload / list / delete of documents attached to a hub.
 * Files are stored locally under backend/uploads/hub-docs/
 * (when switching to cloud later, only this file + the multer storage
 *  config in hubs.routes.js need to change).
 */

const { z }  = require('zod');
const { pool } = require('../config/db');
const path   = require('path');
const fs     = require('fs');

const idParam = z.coerce.number().int().positive();

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

    // If a file of this type already exists, delete the old file from disk
    // (the DB row will be replaced via ON CONFLICT ... DO UPDATE)
    const existing = await pool.query(
      'SELECT file_url FROM hub_documents WHERE hub_id = $1 AND doc_type = $2',
      [hubId, docType]
    );
    if (existing.rowCount > 0) {
      safeUnlink(diskPath(existing.rows[0].file_url));
    }

    const fileUrl     = `/uploads/hub-docs/${req.file.filename}`;
    const uploadedBy  = req.user?.id || null;

    const r = await pool.query(
      `INSERT INTO hub_documents (hub_id, doc_type, file_name, file_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hub_id, doc_type)
       DO UPDATE SET
         file_name   = EXCLUDED.file_name,
         file_url    = EXCLUDED.file_url,
         uploaded_at = NOW(),
         uploaded_by = EXCLUDED.uploaded_by
       RETURNING *`,
      [hubId, docType, req.file.originalname, fileUrl, uploadedBy]
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

    safeUnlink(diskPath(r.rows[0].file_url));
    await pool.query('DELETE FROM hub_documents WHERE id = $1', [docId]);
    res.status(204).end();
  });
}

module.exports = { listDocuments, uploadDocument, deleteDocument };
