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
}

/**
 * deleteFromImageKit(fileId)
 * Deletes a file from ImageKit by its fileId.
 * Silently ignores errors so existing DB rows are always cleaned up.
 */
async function deleteFromImageKit(fileId) {
  if (!fileId) return;
  try {
    const client = getClient();
    await client.deleteFile(fileId);
  } catch (err) {
    console.warn('[ImageKit] delete failed:', err.message);
  }
}

module.exports = { uploadToImageKit, deleteFromImageKit };
