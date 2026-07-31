const fs = require('fs');
const path = require('path');

/**
 * Turns images into `data:` URIs for PDF rendering.
 *
 * WHY THIS EXISTS
 * ───────────────
 * PDFs are produced by Puppeteer via `page.setContent(html)`. That loads the
 * markup on `about:blank`, so the page has NO base URL — a root-relative
 * `src="/logo.svg"` has nothing to resolve against and Chrome silently fails
 * to load it. The document renders with a blank space where the logo should
 * be, in every theme, with no error anywhere.
 *
 * It was doubly broken for the built-in logo: `/logo.svg` lives in
 * `frontend/public/`, which Vercel serves. The API only serves `/uploads`
 * (server.js), so there was no such route on the backend at all.
 *
 * This is easy to miss because the theme PREVIEW renders in the browser, on
 * the frontend's own origin, where `/logo.svg` genuinely exists. The preview
 * looks right and the PDF doesn't.
 *
 * A data URI removes the problem rather than working around it: no origin, no
 * network request, nothing to configure per environment. It is also faster —
 * `setContent` waits for `networkidle0`, so every PDF used to sit waiting on
 * an image request that could never succeed.
 */

const MIME_BY_EXT = {
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');
const STATIC_LOGO_PATH = path.join(__dirname, '../templates/assets/logo.svg');

const cache = new Map();

function encode(absPath) {
  const mime = MIME_BY_EXT[path.extname(absPath).toLowerCase()];
  if (!mime) return null;
  const b64 = fs.readFileSync(absPath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * The bundled Spinoto logo, read once and cached.
 * Returns null (never throws) if the file is missing — a document without a
 * logo is far better than a 500 on every invoice.
 */
function staticLogoDataUri() {
  if (cache.has('__static__')) return cache.get('__static__');
  let uri = null;
  try {
    uri = encode(STATIC_LOGO_PATH);
  } catch (err) {
    console.warn('[inlineImage] built-in logo unreadable:', err.message);
  }
  cache.set('__static__', uri);
  return uri;
}

/**
 * Inline an uploaded asset served under /uploads.
 *
 * Uploaded logos hit the same wall as the built-in one when ImageKit is not
 * configured: `company_settings.logo_url` is then a local `/uploads/...` path,
 * which is just as unresolvable inside setContent. An absolute ImageKit URL is
 * returned unchanged — Chrome can fetch that.
 *
 * Cached by path, so repeated PDFs don't re-read the file. Restart the process
 * after replacing a logo (which a deploy does anyway).
 */
function inlineUploadUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^(https?:|data:)/i.test(url)) return url;   // already absolute — leave it
  if (!url.startsWith('/uploads/')) return url;    // not ours to resolve

  if (cache.has(url)) return cache.get(url);

  let uri = null;
  try {
    // Resolve, then confirm the result is still inside uploads/ — `url` comes
    // from the database, and a stored '../../etc/passwd' should not be able to
    // read arbitrary files off the server.
    const abs = path.resolve(UPLOADS_ROOT, '.' + url.slice('/uploads'.length));
    if (abs === UPLOADS_ROOT || abs.startsWith(UPLOADS_ROOT + path.sep)) {
      uri = encode(abs);
    } else {
      console.warn('[inlineImage] refusing path outside uploads:', url);
    }
  } catch (err) {
    console.warn('[inlineImage] could not inline', url, '—', err.message);
  }

  cache.set(url, uri);
  return uri;
}

/** Test hook — the cache is process-lifetime otherwise. */
function _clearCache() { cache.clear(); }

module.exports = { staticLogoDataUri, inlineUploadUrl, _clearCache };
