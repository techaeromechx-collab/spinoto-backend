/**
 * imagekit.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ImageKit upload utility for hub documents.
 * Uploads a file buffer to ImageKit and returns the CDN URL + fileId.
 *
 * Env vars required:
 *   IMAGEKIT_PUBLIC_KEY
 *   IMAGEKIT_PRIVATE_KEY
 *   IMAGEKIT_URL_ENDPOINT   e.g. https://ik.imagekit.io/your_id
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ImageKit = require('imagekit');
const { CircuitBreaker } = require('./circuitBreaker');

// ImageKit is called synchronously in the request path (upload/delete both
// `await` it before responding — see hub_documents.controller.js). Without a
// breaker, a slow/unreachable ImageKit would let every upload/delete request
// hang until the platform's own timeout, tying up a request + the file
// buffer in memory for each one — a burst of uploads during an ImageKit
// outage could exhaust the app's capacity for completely unrelated pages.
const breaker = new CircuitBreaker('imagekit', {
  failureThreshold: 4,
  failureWindowMs: 30_000,
  resetTimeoutMs: 20_000,
  requestTimeoutMs: 10_000, // uploads can legitimately take a few seconds; don't cut them too short
  maxConcurrent: 5,
});

let _client = null;

function getClient() {
  if (_client) return _client;

  const { IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT } = process.env;

  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
    throw new Error('ImageKit env vars not set (IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT)');
  }

  _client = new ImageKit({
    publicKey:   IMAGEKIT_PUBLIC_KEY,
    privateKey:  IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
  });

  return _client;
}

/**
 * uploadToImageKit(buffer, fileName, folder)
 *
 * @param {Buffer} buffer    — file buffer from multer memoryStorage
 * @param {string} fileName  — original file name
 * @param {string} folder    — ImageKit folder e.g. 'hub-docs/hub_image'
 * @returns {{ url: string, fileId: string }}
 */
async function uploadToImageKit(buffer, fileName, folder = 'hub-docs') {
  return breaker.fire(async () => {
    const client = getClient();

    const response = await client.upload({
      file:              buffer.toString('base64'),
      fileName,
      folder,
      useUniqueFileName: true,
    });

    return {
      url:    response.url,
      fileId: response.fileId,
    };
  });
}

/**
 * deleteFromImageKit(fileId)
 * Deletes a file from ImageKit by its fileId.
 * Silently ignores errors so existing DB rows are always cleaned up.
 */
async function deleteFromImageKit(fileId) {
  if (!fileId) return;
  try {
    await breaker.fire(async () => {
      const client = getClient();
      await client.deleteFile(fileId);
    });
  } catch (err) {
    // Already best-effort — a slow/down ImageKit (breaker open, timeout, or
    // a real API error) should never block the caller from finishing its
    // own DB cleanup.
    console.warn('[ImageKit] delete failed:', err.message);
  }
}

module.exports = { uploadToImageKit, deleteFromImageKit, _breaker: breaker };
