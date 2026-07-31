'use strict';

/**
 * Inlines images referenced by a document template as data URIs.
 *
 * ── Why this is necessary ───────────────────────────────────────────────────
 * The PDF is produced by Puppeteer from a self-contained HTML STRING via
 * page.setContent(). That page has no document URL — it's effectively
 * about:blank — so a relative src like "/logo.svg" or
 * "/uploads/company-logo/logo-x.png" has no origin to resolve against and the
 * image simply never loads. No error, no broken-image icon in the PDF: it just
 * silently isn't there. That's exactly how the logo went missing.
 *
 * Absolute http(s) URLs (ImageKit) would load, but only if the renderer has
 * network access and the fetch finishes inside the setContent timeout, which
 * makes PDF generation depend on an external service being up. Inlining
 * removes that dependency too.
 *
 * Every failure path returns null so the theme just omits the image — a
 * missing logo must never take a whole invoice down.
 */

const fs = require('fs/promises');
const path = require('path');

const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Guards against inlining something enormous into every PDF.
const MAX_BYTES = 3 * 1024 * 1024;

const BACKEND_ROOT = path.join(__dirname, '../..');
const REPO_ROOT = path.join(BACKEND_ROOT, '..');

/**
 * Candidate disk locations for a root-relative URL.
 *
 * /uploads/... is served by the backend from backend/uploads.
 * /logo.svg (and any other bare asset) is a frontend public-dir file; the
 * built copy in dist/ is checked first since that's what a deployed box has,
 * falling back to public/ for local dev.
 */
function candidatePaths(urlPath) {
  const clean = urlPath.split('?')[0].split('#')[0];
  if (clean.startsWith('/uploads/')) {
    return [path.join(BACKEND_ROOT, clean)];
  }
  return [
    path.join(REPO_ROOT, 'frontend', 'dist', clean),
    path.join(REPO_ROOT, 'frontend', 'public', clean),
  ];
}

/** Reject anything that escapes the directory it should live in. */
function isSafe(resolved, urlPath) {
  const roots = urlPath.startsWith('/uploads/')
    ? [path.join(BACKEND_ROOT, 'uploads')]
    : [path.join(REPO_ROOT, 'frontend', 'dist'), path.join(REPO_ROOT, 'frontend', 'public')];
  return roots.some(r => resolved.startsWith(r + path.sep));
}

async function fromDisk(urlPath) {
  for (const p of candidatePaths(urlPath)) {
    const resolved = path.resolve(p);
    if (!isSafe(resolved, urlPath)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      const buf = await fs.readFile(resolved);
      const mime = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function fromHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * @param {string|null} url  root-relative ("/logo.svg", "/uploads/...") or absolute http(s)
 * @returns {Promise<string|null>} a data URI, or null if it couldn't be inlined
 */
async function inlineAsset(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return url;               // already inlined
  if (/^https?:\/\//i.test(url)) return fromHttp(url);
  if (url.startsWith('/')) return fromDisk(url);
  return null;
}

module.exports = { inlineAsset };
