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
 * Deploy note — why this no longer uses the `puppeteer` package
 * ─────────────────────────────────────────────────────────────
 * `puppeteer` downloads a full Chromium during `npm install` and then expects
 * a pile of system shared libraries (libnss3, libatk, libgbm, libasound2 …)
 * to already exist on the host. Render's image happened to have them. The AWS
 * task does not, which is what produced:
 *
 *     GET /api/customer-invoices/:id/pdf  →  500
 *
 * Installing those libraries means a Dockerfile, and a Dockerfile means the
 * "just push code and it auto-deploys" workflow stops working.
 *
 * So instead: `puppeteer-core` (the driver, no download, no post-install) plus
 * `@sparticuz/chromium` (a Chromium build that is statically linked against
 * the libraries a stock host is missing). Both arrive through `npm install`
 * like any other dependency — no Dockerfile, no host packages, no deploy
 * pipeline change.
 *
 * Both are pinned EXACTLY, not with a caret. puppeteer-core speaks one
 * specific DevTools protocol revision and @sparticuz/chromium ships one
 * specific Chromium; a caret range lets either drift independently, and the
 * failure mode is a launch error in production rather than anything npm
 * would flag. Bump them together or not at all:
 *
 *     puppeteer-core 23.11.1   ⟷   @sparticuz/chromium 131.0.1
 *
 * Fonts are handled separately and deliberately — see templates/fonts/.
 */

const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { withEmbeddedFonts } = require('../templates/fonts');

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

/** Args used when driving a Chromium we didn't get from @sparticuz/chromium. */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // avoid /dev/shm size issues in constrained containers
];

/**
 * Where to find a Chromium to drive.
 *
 * Three cases, in priority order:
 *
 *   1. PUPPETEER_EXECUTABLE_PATH — an explicit override. Always wins. This is
 *      the escape hatch if the bundled build ever misbehaves on a new host:
 *      install a system Chromium, point this at it, restart. No code change.
 *
 *   2. Linux (every deployed environment) — @sparticuz/chromium. It unpacks a
 *      self-contained Chromium into /tmp on first launch (~1s, once per
 *      process) and needs no system libraries.
 *
 *   3. macOS / Windows — local development. `@sparticuz/chromium` is a Linux
 *      binary and cannot run here, and we deliberately do NOT depend on the
 *      full `puppeteer` package just to make laptops work: it would reappear
 *      in the AWS install and re-create the original problem. So we look for
 *      a Chrome that is almost certainly already installed. If it isn't, the
 *      error below says exactly what to do rather than failing obscurely
 *      several frames deep inside the launcher.
 */
const LOCAL_CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

async function launchConfig() {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    return { executablePath: override, args: BASE_ARGS, headless: true };
  }

  if (process.platform === 'linux') {
    // Required lazily: on a developer's Mac this module is a Linux binary
    // wrapper that never needs to be touched, and requiring it at file scope
    // would make a laptop pay for it on every boot.
    const chromium = require('@sparticuz/chromium');

    // @sparticuz/chromium is tuned for AWS Lambda, where the process handles
    // one request and dies. This backend is the opposite — a single Node
    // process that stays up for weeks (see src/server.js) — so two of its
    // defaults are actively wrong here:
    //
    //   --single-process  puts the renderer in the browser process. One bad
    //                     document then takes down the whole browser instead
    //                     of one tab, and MAX_CONCURRENT renders serialise
    //                     onto a single thread. Puppeteer documents this flag
    //                     as unsupported.
    //   --no-zygote       without the zygote, every tab re-does full process
    //                     setup. Fine for one render; wasteful for thousands.
    //
    // Everything else it sets (swiftshader, no-sandbox, dev-shm, colour
    // profile) is either required on a minimal host or harmless, so it stays.
    const args = chromium.args.filter(
      (a) => a !== '--single-process' && a !== '--no-zygote',
    );

    return {
      args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    };
  }

  const candidates = LOCAL_CHROME_CANDIDATES[process.platform] || [];
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (found) return { executablePath: found, args: BASE_ARGS, headless: true };

  throw new Error(
    `No Chromium found for local PDF rendering on ${process.platform}. `
    + 'Install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary. '
    + '(Deployed Linux hosts use @sparticuz/chromium and need neither.)',
  );
}

async function getBrowser() {
  if (_browserPromise) {
    // Guard against a previously-resolved browser having crashed/disconnected
    // since last use — relaunch if so.
    try {
      const existing = await _browserPromise;
      if (existing.isConnected()) return existing;
    } catch {
      // A launch that rejected must not be cached forever: without this, one
      // failed start (a cold /tmp, a transient OOM) would make every
      // subsequent PDF request replay the same rejected promise until the
      // process restarted.
    }
    _browserPromise = null;
  }

  _browserPromise = (async () => puppeteer.launch(await launchConfig()))();

  // Same reason as above, one level up: drop the cached promise if this
  // particular launch fails, so the next request gets a fresh attempt.
  _browserPromise.catch(() => { _browserPromise = null; });

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
    // Every themed document passes through here, which makes this the one
    // place the embedded fonts have to be added. Doing it per-template would
    // mean eight files to keep in sync and a silent regression the first time
    // someone adds a ninth. See templates/fonts/index.js for what and why.
    await page.setContent(withEmbeddedFonts(html), { waitUntil: 'networkidle0', timeout: 15_000 });

    // The fonts are data: URIs, so they resolve without network and
    // networkidle0 does not wait for them. Without this, a render can start
    // before the faces finish decoding and fall back to whatever the host
    // has — the exact failure we are shipping fonts to avoid, except
    // intermittent, which is worse.
    await page.evaluate(() => document.fonts.ready);
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
