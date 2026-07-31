/**
 * pdf.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side HTML → PDF rendering for themed invoices, via a headless
 * Chromium instance (Puppeteer).
 *
 * Why server-side rendering instead of window.print() in the browser:
 *   - Consistent output regardless of the user's browser/OS/print driver.
 *   - Exact page-size control (A4 vs A5), which the two "(A5)" invoice
 *     themes require and browser print dialogs can't reliably guarantee.
 *   - The same PDF bytes can be downloaded, emailed, or archived later.
 *
 * The backend is a single persistent Node process (not serverless — see
 * src/server.js), so it's safe to hold one long-lived headless-Chromium
 * instance and reuse it across requests rather than launching a fresh
 * browser per PDF (launching Chromium is the expensive part, ~0.5-1s).
 *
 * Deploy note: Puppeteer downloads a bundled Chromium on `npm install`. On
 * some minimal Linux hosts (slim Docker images, etc.) Chromium needs a
 * handful of system shared libraries that aren't installed by default —
 * see https://pptr.dev/troubleshooting for the exact package list if the
 * browser fails to launch in production. Not needed on a normal Ubuntu/
 * Debian VM/host.
 */

const puppeteer = require('puppeteer');

let _browserPromise = null;

// ─── Concurrency ──────────────────────────────────────────────────────────────
//
// One browser is shared, but each render still opens its own tab, and a tab
// rendering a full invoice costs real memory. Nothing previously limited how
// many could be open at once: twenty simultaneous "Download PDF" clicks meant
// twenty tabs, which on a small VM is enough to get the Node process OOM-killed
// — taking the whole API down, not just the PDFs.
//
// So renders queue. The limit is deliberately small: PDF generation is CPU-bound
// in Chromium's layout engine, so more parallelism past a couple of cores buys
// nothing and costs memory.
const MAX_CONCURRENT = Number(process.env.PDF_MAX_CONCURRENT || 3);
// How long a request will wait for a slot before giving up. Failing fast is
// better than holding an HTTP connection open for a minute behind a backlog.
const QUEUE_TIMEOUT_MS = Number(process.env.PDF_QUEUE_TIMEOUT_MS || 20_000);
// Ceiling on a single render, so one pathological document can't occupy a slot
// indefinitely and starve everyone behind it.
const RENDER_TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 30_000);

let active = 0;
const waiting = [];

/** Resolves when a render slot is free; rejects if the wait exceeds the timeout. */
function acquireSlot() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
        // `status` is what the controllers' handle() reads to pick an HTTP
        // code; `statusCode` mirrors it for any Express-style handler.
        reject(Object.assign(
          new Error('PDF renderer is busy. Please try again in a moment.'),
          { status: 503, statusCode: 503 },
        ));
      }, QUEUE_TIMEOUT_MS),
    };
    waiting.push(entry);
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();          // hands the slot straight over; `active` unchanged
    return;
  }
  active = Math.max(0, active - 1);
}

/** Rejects if `promise` hasn't settled within `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/** Queue depth, for health checks. */
function rendererStats() {
  return { active, queued: waiting.length, maxConcurrent: MAX_CONCURRENT };
}

async function getBrowser() {
  if (_browserPromise) {
    // Guard against a previously-resolved browser having crashed/disconnected
    // since last use — relaunch if so.
    const existing = await _browserPromise;
    if (existing.isConnected()) return existing;
    _browserPromise = null;
  }
  _browserPromise = puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // avoid /dev/shm size issues in constrained containers
    ],
  });
  return _browserPromise;
}

/**
 * renderHtmlToPdf(html, { pageSize })
 *
 * @param {string} html      — fully self-contained HTML (inline <style>, no
 *                              external asset requests other than data URIs
 *                              — keeps rendering fast and avoids the
 *                              renderer needing network access).
 * @param {'A4'|'A5'} pageSize
 * @returns {Buffer} PDF bytes
 */
async function renderHtmlToPdf(html, { pageSize = 'A4' } = {}) {
  // Wait for a slot BEFORE opening a tab — the point is to cap tabs, so the
  // tab must not exist while queued.
  await acquireSlot();
  try {
    return await withTimeout(
      renderOnce(html, pageSize),
      RENDER_TIMEOUT_MS,
      `PDF rendering timed out after ${RENDER_TIMEOUT_MS}ms.`,
    );
  } finally {
    releaseSlot();
  }
}

async function renderOnce(html, pageSize) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15_000 });
    const bytes = await page.pdf({
      format: pageSize,
      printBackground: true, // themes rely on background colors/accent bars
      // Zero here on purpose: the margin is the theme's @page rule, which is
      // pre-scaled per sheet and applies to EVERY page. Setting it in both
      // places would double it. See docShared.pageMarginCss.
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
    });

    // ⚠ Puppeteer v23 changed page.pdf() to return a Uint8Array rather than a
    // Buffer. Express's res.send() only treats a real Buffer as raw bytes — a
    // plain Uint8Array is just an object, so it gets JSON-serialised into
    // {"0":37,"1":80,...} and sent with Content-Type: application/pdf. The
    // browser then reports "Failed to load PDF document", with no server
    // error to point at. Normalising here means every caller is safe, and it's
    // a no-op if a future version goes back to returning a Buffer.
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  } finally {
    await page.close();
  }
}

// Close the shared browser cleanly on process shutdown so it doesn't linger
// as a zombie Chromium process.
async function closeBrowser() {
  if (!_browserPromise) return;
  try {
    const browser = await _browserPromise;
    await browser.close();
  } catch {
    // already gone — nothing to do
  }
  _browserPromise = null;
}

process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);

module.exports = { renderHtmlToPdf, closeBrowser, rendererStats };
