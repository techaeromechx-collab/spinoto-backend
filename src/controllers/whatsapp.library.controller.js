'use strict';

/**
 * /api/whatsapp/images and /api/whatsapp/quick-replies — the agent's toolbox,
 * configured by an admin.
 *
 * ── TWO RESOURCES, ONE FILE ─────────────────────────────────────────────────
 *
 * They are structurally identical: list, create, update, delete, each with an
 * is_active flag and the same read/write permission split. Two files would be
 * two near-copies, and the pair that drifts is always the second one — the
 * enable/disable that got fixed in images and not in quick replies. The parts
 * that genuinely differ (an image URL must be publicly fetchable; a shortcut
 * must start with a slash) live in one `validate` function each, and
 * everything around them is shared.
 *
 * ── THE PERMISSION SPLIT IS THE POINT ───────────────────────────────────────
 *
 *   READ    SEND_WHATSAPP — an agent needs the list to use it
 *   WRITE   MANAGE_WHATSAPP_TEMPLATES — the same right that governs what every
 *           automatic message says
 *
 * Enforced by the router, not here. What this file guarantees instead is the
 * thing a permission cannot: that the READ endpoints an agent calls return
 * only ACTIVE rows, so a disabled image is not merely hidden by the frontend
 * but genuinely absent from the response.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch((err) => {
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error: 'The WhatsApp library tables are missing — run npm run db:migrate.',
        code: 'MIGRATION_PENDING',
      });
    }
    // 23505 is the unique index on name / title / shortcut. Turned into a
    // sentence naming the field, because "duplicate key value violates unique
    // constraint idx_wa_images_name" is not an answer to anybody's question.
    if (err && err.code === '23505') {
      const what = /shortcut/.test(err.constraint || '') ? 'shortcut'
                 : /title/.test(err.constraint || '')    ? 'title'
                 : 'name';
      return res.status(409).json({ error: `Another entry already uses that ${what}.` });
    }
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: err.errors[0]?.message || 'Invalid input' });
    }
    next(err);
  });
}

const idParam = z.coerce.number().int().positive();

/* ══ IMAGES ═════════════════════════════════════════════════════════════════ */

const IMAGE_COLS = `
  id, name, imagekit_url, imagekit_file_id, is_active,
  created_by, updated_by, created_at, updated_at`;

const imageBody = z.object({
  name:             z.string().trim().min(1, 'Give the image a name.').max(120),
  imagekit_url:     z.string().trim().min(1, 'The ImageKit URL is required.').max(2000),
  imagekit_file_id: z.string().trim().max(120).optional().nullable(),
  is_active:        z.boolean().optional(),
});

/**
 * The URL rule, and it is not cosmetic.
 *
 * WhatsApp fetches the image from ITS OWN servers. A relative path, an
 * intranet host or a file:// address is reachable by us and by nobody else, so
 * the send fails with a provider error that blames the image — while the image
 * is fine and the address is not. Catching it here turns a confusing rejection
 * days later into a sentence at the moment somebody pastes the wrong thing.
 *
 * http is allowed as well as https, because a self-hosted install behind a
 * plain-http CDN is somebody's real situation and refusing it would be us
 * inventing a rule WhatsApp does not have.
 */
function badImageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return 'That is not a complete web address. It must start with https://'; }
  if (!/^https?:$/.test(u.protocol)) {
    return 'The address must start with https:// — WhatsApp fetches the image over the web.';
  }
  if (!u.hostname || u.hostname === 'localhost' || /^127\./.test(u.hostname)) {
    return 'That address only works on this machine. WhatsApp cannot reach it.';
  }
  return null;
}

/**
 * Does that address actually serve an image, right now?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * badImageUrl above checks the SHAPE — https, a real host, not localhost. It
 * cannot tell you the file is there, and every way a pasted ImageKit address
 * goes wrong is invisible to a shape check:
 *
 *   • the filename had spaces, and ImageKit sanitised them on upload, so the
 *     address you copied from the design tool is not the address it lives at
 *   • the file was renamed, and every rename mints a new address
 *   • the URL was pasted into the middle of the old one
 *   • the file is marked PRIVATE in ImageKit and answers 400 to anyone unsigned
 *
 * All four save cleanly, show a broken card, and — the part that matters —
 * fail at SEND time, where WhatsApp fetches the same address and returns a
 * provider error blaming the picture. One request here turns a confusing
 * failure days later into a sentence at the moment somebody pastes it.
 *
 * ── WHY A FAILED PROBE IS NOT ALWAYS A REFUSAL ──────────────────────────────
 *
 * Two different things can go wrong and they deserve different answers:
 *
 *   the SERVER answered badly (404, 400, a PDF) — their address is wrong, and
 *   refusing it is the whole point.
 *
 *   we could not ASK (timeout, DNS, no egress) — that is our network, not
 *   their URL. Refusing would mean a firewall change silently locks an admin
 *   out of a screen that worked yesterday, and the address may be perfectly
 *   good. So the save is allowed and the reason is logged.
 *
 * Returns null when the address is fine or unknowable; a sentence when it is
 * definitely wrong.
 */
async function probeImageUrl(url) {
  // Range: bytes=0-0 rather than HEAD. Some CDNs answer HEAD with 405 while
  // serving GET perfectly, and one byte is enough to read a status and a
  // content-type without pulling a 4 MB poster through this server.
  const attempt = async (method, headers) => {
    const ctl = setTimeoutController(6000);
    try {
      return await fetch(url, { method, headers, redirect: 'follow', signal: ctl.signal });
    } finally {
      ctl.done();
    }
  };

  let r;
  try {
    r = await attempt('GET', { Range: 'bytes=0-0' });
  } catch (err) {
    console.warn('[wa-library] could not reach', url, '—', err.message);
    return null;   // our side, not theirs
  }

  if (r.status === 400 || r.status === 401 || r.status === 403) {
    return 'That address exists but refuses to be read without a signature — in ImageKit the '
         + 'file is marked private. Open it in the Media Library and turn the private setting '
         + 'off, or upload it here instead.';
  }
  if (r.status === 404 || r.status === 410) {
    return 'There is nothing at that address. If you renamed the file in ImageKit its address '
         + 'changed too — use the Copy URL button there rather than typing the name.';
  }
  if (!r.ok && r.status !== 206) {
    return `That address answered with an error (${r.status}). WhatsApp would get the same thing.`;
  }

  // 206 is the partial content the Range asked for; 200 means it ignored the
  // Range and sent the lot, which is also fine.
  const type = String(r.headers.get('content-type') || '').toLowerCase();
  if (type && !type.startsWith('image/')) {
    return `That address serves ${type.split(';')[0]}, not an image. WhatsApp will refuse it.`;
  }
  if (!type) {
    return 'That address does not say what kind of file it is. WhatsApp needs an image with a '
         + 'proper type — make sure the filename ends in .jpg or .png.';
  }
  return null;
}

/** AbortSignal.timeout is not in every Node this runs on; this is. */
function setTimeoutController(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

function listImages(req, res, next) {
  handle(req, res, next, async () => {
    // ── The active-only rule ────────────────────────────────────────────────
    //
    // An agent's list must contain ONLY active rows, and that is enforced here
    // rather than by the frontend filtering what it was given. A disabled
    // image that arrives in the response and is merely not drawn is one
    // devtools tab away from being sent, and "we hid it" is not the same
    // promise as "we did not send it".
    //
    // The admin screen asks for all=1, and the router only lets a manager
    // through to that.
    const wantAll = req.query.all === '1' || req.query.all === 'true';
    const r = await pool.query(
      `SELECT ${IMAGE_COLS} FROM wa_images
        ${wantAll ? '' : 'WHERE is_active'}
        ORDER BY LOWER(name)`);
    res.json({ items: r.rows });
  });
}

function createImage(req, res, next) {
  handle(req, res, next, async () => {
    const d = imageBody.parse(req.body || {});
    const bad = badImageUrl(d.imagekit_url);
    if (bad) return res.status(422).json({ error: bad });

    // Shape first, then reality. The order matters only for the error message:
    // a typo'd scheme should say so rather than time out reaching nothing.
    const dead = await probeImageUrl(d.imagekit_url);
    if (dead) return res.status(422).json({ error: dead, code: 'URL_UNREACHABLE' });

    const r = await pool.query(
      `INSERT INTO wa_images (name, imagekit_url, imagekit_file_id, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), $5, $5)
       RETURNING ${IMAGE_COLS}`,
      [d.name, d.imagekit_url, d.imagekit_file_id || null, d.is_active ?? null, req.user?.id || null]);

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'CREATE',
      entity: 'wa_image', entityId: r.rows[0].id,
      description: `WhatsApp image added: ${d.name}`,
    });
    res.status(201).json({ item: r.rows[0] });
  });
}

/**
 * POST /api/whatsapp/images/upload — the file, not the address.
 *
 * ── WHY THIS EXISTS ALONGSIDE PASTING A URL ─────────────────────────────────
 *
 * Pasting an ImageKit address looks like the simpler option and is not. It
 * asks an admin to copy a string exactly, from a different product, and every
 * one of the ways that goes wrong (a renamed file, a sanitised space, a paste
 * landing in the middle of the old value, a file uploaded private) produces
 * the same useless outcome: a saved row that cannot be delivered.
 *
 * This path removes every one of them. The bytes go up through THIS server
 * using the same uploader the WhatsApp paperclip already uses — which is
 * demonstrably reachable, because its images arrive on customers' phones — and
 * the address comes back from ImageKit rather than being typed. Nothing is
 * ever public that we did not just put there ourselves, and nothing is
 * private, because we never ask for it to be.
 *
 * Pasting stays, for the case it is actually good at: an image that is already
 * on ImageKit and already known to work.
 *
 * ── WHY THE FILENAME IS THROWN AWAY ─────────────────────────────────────────
 *
 * The original name is user text that would end up in a public URL, and it is
 * also the source of the space-sanitising confusion this endpoint exists to
 * end. A generated name plus ImageKit's useUniqueFileName means the address is
 * never something anybody has to read, spell or copy.
 */
function uploadImage(req, res, next) {
  handle(req, res, next, async () => {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Choose an image file to upload.' });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(422).json({ error: 'Give the image a name.' });
    if (name.length > 120) return res.status(422).json({ error: 'That name is too long.' });

    /* The duplicate check runs BEFORE the upload, not after.
       Both orders end with the admin seeing "another entry already uses that
       name", and only this one avoids leaving an orphaned file on ImageKit
       that no row points at and nothing will ever clean up. It is a check, not
       a lock — two admins racing the same name still end at the unique index,
       which is the thing that actually guarantees it. */
    const clash = await pool.query(
      `SELECT 1 FROM wa_images WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`, [name]);
    if (clash.rowCount) {
      return res.status(409).json({ error: 'Another entry already uses that name.' });
    }

    const ext = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    let up;
    try {
      const { uploadToImageKit } = require('../utils/imagekit');
      up = await uploadToImageKit(req.file.buffer, `wa-lib${ext}`, 'whatsapp-library');
    } catch (err) {
      console.error('[wa-library] ImageKit upload failed —', err.message);
      return res.status(502).json({
        error: 'The image could not be uploaded to ImageKit. Try again in a moment.',
        code: 'UPLOAD_FAILED',
      });
    }
    if (!up?.url) {
      return res.status(502).json({
        error: 'The image uploaded but no public address came back, so it cannot be sent.',
        code: 'UPLOAD_NO_URL',
      });
    }

    /* fileId is stored, and it is the reason this path is better than pasting
       in one more way: a row created from a pasted address has no handle on
       the file, so deleting the row can never delete the picture. A row
       created here does. Nothing uses it yet. */
    const r = await pool.query(
      `INSERT INTO wa_images (name, imagekit_url, imagekit_file_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING ${IMAGE_COLS}`,
      [name, up.url, up.fileId || null, req.user?.id || null]);

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'CREATE',
      entity: 'wa_image', entityId: r.rows[0].id,
      description: `WhatsApp image uploaded: ${name}`,
    });
    res.status(201).json({ item: r.rows[0] });
  });
}

const imagePatch = imageBody.partial();

function updateImage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = imagePatch.parse(req.body || {});
    if (!Object.keys(d).length) return res.status(400).json({ error: 'Nothing to update' });

    if (d.imagekit_url !== undefined) {
      const bad = badImageUrl(d.imagekit_url);
      if (bad) return res.status(422).json({ error: bad });
      const dead = await probeImageUrl(d.imagekit_url);
      if (dead) return res.status(422).json({ error: dead, code: 'URL_UNREACHABLE' });
    }

    // COALESCE per column, so a PATCH carrying only is_active cannot null the
    // name. Sending every column from the frontend would work too, and would
    // mean a screen that forgets one field silently erases it.
    const r = await pool.query(
      `UPDATE wa_images SET
         name             = COALESCE($2, name),
         imagekit_url     = COALESCE($3, imagekit_url),
         imagekit_file_id = COALESCE($4, imagekit_file_id),
         is_active        = COALESCE($5, is_active),
         updated_by       = $6,
         updated_at       = NOW()
       WHERE id = $1
       RETURNING ${IMAGE_COLS}`,
      [id, d.name ?? null, d.imagekit_url ?? null, d.imagekit_file_id ?? null,
       d.is_active ?? null, req.user?.id || null]);

    if (!r.rowCount) return res.status(404).json({ error: 'Image not found' });

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'UPDATE',
      entity: 'wa_image', entityId: id,
      description: d.is_active !== undefined && Object.keys(d).length === 1
        ? `WhatsApp image ${d.is_active ? 'enabled' : 'disabled'}: ${r.rows[0].name}`
        : `WhatsApp image updated: ${r.rows[0].name}`,
    });
    res.json({ item: r.rows[0] });
  });
}

function deleteImage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    // Hard delete, and it costs nothing: wa_messages stores the URL it sent at
    // send time, so removing the library entry cannot blank a photo already in
    // a customer's chat or in our thread.
    const r = await pool.query(`DELETE FROM wa_images WHERE id = $1 RETURNING name`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Image not found' });

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'DELETE',
      entity: 'wa_image', entityId: id,
      description: `WhatsApp image removed: ${r.rows[0].name}`,
    });
    res.json({ ok: true });
  });
}

/* ══ QUICK REPLIES ══════════════════════════════════════════════════════════ */

const QR_COLS = `
  id, title, shortcut, message, is_active,
  created_by, updated_by, created_at, updated_at`;

const qrBody = z.object({
  title:     z.string().trim().min(1, 'Give the quick reply a title.').max(120),
  shortcut:  z.string().trim().max(40).optional().nullable(),
  message:   z.string().trim().min(1, 'A quick reply needs a message.').max(4096),
  is_active: z.boolean().optional(),
});

/**
 * Shortcuts are normalised to a leading slash and lower case.
 *
 * Not merely tidiness: the unique index is on LOWER(TRIM(shortcut)), so
 * '/Location' and '/location' already collide. Normalising on the way IN means
 * the collision is reported as "another entry already uses that shortcut"
 * rather than accepted and then found later.
 */
function normaliseShortcut(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  return t.startsWith('/') ? t : `/${t}`;
}

function listQuickReplies(req, res, next) {
  handle(req, res, next, async () => {
    const wantAll = req.query.all === '1' || req.query.all === 'true';
    const r = await pool.query(
      `SELECT ${QR_COLS} FROM wa_quick_replies
        ${wantAll ? '' : 'WHERE is_active'}
        ORDER BY LOWER(title)`);
    res.json({ items: r.rows });
  });
}

function createQuickReply(req, res, next) {
  handle(req, res, next, async () => {
    const d = qrBody.parse(req.body || {});
    const r = await pool.query(
      `INSERT INTO wa_quick_replies (title, shortcut, message, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), $5, $5)
       RETURNING ${QR_COLS}`,
      [d.title, normaliseShortcut(d.shortcut), d.message, d.is_active ?? null, req.user?.id || null]);

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'CREATE',
      entity: 'wa_quick_reply', entityId: r.rows[0].id,
      description: `WhatsApp quick reply added: ${d.title}`,
    });
    res.status(201).json({ item: r.rows[0] });
  });
}

const qrPatch = qrBody.partial();

function updateQuickReply(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = qrPatch.parse(req.body || {});
    if (!Object.keys(d).length) return res.status(400).json({ error: 'Nothing to update' });

    // shortcut is the one field where COALESCE is wrong: clearing it is a real
    // edit, and COALESCE would read '' as "leave alone". Handled explicitly.
    const clearingShortcut = d.shortcut !== undefined && !normaliseShortcut(d.shortcut);

    const r = await pool.query(
      `UPDATE wa_quick_replies SET
         title     = COALESCE($2, title),
         shortcut  = CASE WHEN $3::boolean THEN NULL ELSE COALESCE($4, shortcut) END,
         message   = COALESCE($5, message),
         is_active = COALESCE($6, is_active),
         updated_by = $7,
         updated_at = NOW()
       WHERE id = $1
       RETURNING ${QR_COLS}`,
      [id, d.title ?? null, clearingShortcut,
       d.shortcut !== undefined ? normaliseShortcut(d.shortcut) : null,
       d.message ?? null, d.is_active ?? null, req.user?.id || null]);

    if (!r.rowCount) return res.status(404).json({ error: 'Quick reply not found' });

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'UPDATE',
      entity: 'wa_quick_reply', entityId: id,
      description: d.is_active !== undefined && Object.keys(d).length === 1
        ? `WhatsApp quick reply ${d.is_active ? 'enabled' : 'disabled'}: ${r.rows[0].title}`
        : `WhatsApp quick reply updated: ${r.rows[0].title}`,
    });
    res.json({ item: r.rows[0] });
  });
}

function deleteQuickReply(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query(`DELETE FROM wa_quick_replies WHERE id = $1 RETURNING title`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Quick reply not found' });

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'DELETE',
      entity: 'wa_quick_reply', entityId: id,
      description: `WhatsApp quick reply removed: ${r.rows[0].title}`,
    });
    res.json({ ok: true });
  });
}

/* ══ THE PAPERCLIP SWITCH ═══════════════════════════════════════════════════
 *
 * Whether agents may attach a file from their own computer.
 *
 * Kept in integration_settings (migration 152) rather than a table of its own,
 * because that is precisely what that table is: one value, read by the app,
 * written from a settings screen.
 *
 * ── DEFAULT ON, AND THE COMPARISON IS AGAINST 'false' ───────────────────────
 *
 * getSetting returns '' when there is no row — an install that has never
 * visited this screen, which is every install the moment this ships. Treating
 * '' as OFF would silently remove a working button from every CRM on upgrade.
 * So only the literal string 'false' turns it off; anything else is on.
 */
const UPLOAD_KEY = 'wa_allow_local_upload';

function localUploadAllowed() {
  const { getSetting } = require('../services/integrationSettings.service');
  return getSetting(UPLOAD_KEY) !== 'false';
}

/** GET /api/whatsapp/library-settings — read by the composer AND the admin screen. */
function getLibrarySettings(req, res, next) {
  handle(req, res, next, async () => {
    res.json({ allow_local_upload: localUploadAllowed() });
  });
}

/** PUT /api/whatsapp/library-settings */
function saveLibrarySettings(req, res, next) {
  handle(req, res, next, async () => {
    const d = z.object({ allow_local_upload: z.boolean() }).parse(req.body || {});
    const { putSetting } = require('../services/integrationSettings.service');

    // Stored as the STRING 'true'/'false' because integration_settings is a
    // text key/value store and putSetting deletes the row for an empty value —
    // so a boolean false must not arrive here as ''.
    await putSetting(pool, UPLOAD_KEY, d.allow_local_upload ? 'true' : 'false', req.user?.id || null);

    logActivity({
      userId: req.user?.id, userName: req.user?.name, action: 'UPDATE',
      entity: 'integration_settings', entityId: null,
      description: `WhatsApp: attaching images from a computer ${d.allow_local_upload ? 'enabled' : 'disabled'}`,
    });
    res.json({ allow_local_upload: d.allow_local_upload });
  });
}

module.exports = {
  listImages, createImage, uploadImage, updateImage, deleteImage,
  listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
  getLibrarySettings, saveLibrarySettings,
  // Used by whatsapp.messages.controller to gate the upload endpoint, and by
  // the suite. The switch must be enforced on the SERVER as well as hidden in
  // the UI, or turning it off only hides a button that still works.
  localUploadAllowed, UPLOAD_KEY,
};
