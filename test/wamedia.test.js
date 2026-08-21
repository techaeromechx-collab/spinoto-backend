'use strict';

/**
 * Sending a photo on WhatsApp — the parts that fail quietly.
 *
 * Three areas, and each exists because its failure does not announce itself:
 *
 *   1. sendMedia's guards. A relative URL like /uploads/wa/3.jpg is reachable
 *      by this server and by nobody else. WhatsApp fetches the image from its
 *      OWN machines, so the send fails with a provider error blaming the
 *      picture — while the picture is fine and the configuration is not.
 *
 *   2. The endpoint's ORDER of operations. The wa_messages row is written
 *      before the upload because the row id is the callbackData Interakt
 *      echoes on every delivery receipt: no row, no id, no way to match a
 *      receipt to a message. That makes a failed upload leave a row behind,
 *      which must be marked failed rather than deleted — a photo that did not
 *      reach the customer has to be VISIBLE.
 *
 *   3. The thread query. wa_messages gained media columns, and a SELECT that
 *      does not list them returns a photo row with media_url undefined. The
 *      symptom is precise and baffling: the photo appears once, from the send
 *      response, and vanishes on the next poll.
 *
 * The Interakt API key must never appear in a response. Asserted directly,
 * because "obviously it doesn't" is what every leaked credential had going for
 * it too.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read  = (p) => fs.readFileSync(p, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — sendMedia, exercised for real against a stubbed Interakt
// ═══════════════════════════════════════════════════════════════════════════

process.env.INTERAKT_API_KEY = 'dGVzdC1rZXktbm90LXJlYWw=';
const interakt = require(`${BE}/src/utils/interakt.js`);

assert.strictEqual(typeof interakt.sendMedia, 'function',
  'sendMedia is not exported from utils/interakt.js'); n++;

const realFetch = global.fetch;
let lastPayload = null;
let lastHeaders = null;

function stubInterakt(status, body) {
  global.fetch = async (_url, opts) => {
    lastPayload = JSON.parse(opts.body);
    lastHeaders = opts.headers;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

(async () => {
  // ── The URL must be absolute and public ─────────────────────────────────
  global.fetch = async () => { throw new Error('must not reach the network'); };
  for (const bad of [
    '/uploads/whatsapp/3.jpg',            // the disk-storage fallback shape
    'uploads/whatsapp/3.jpg',
    'ik.imagekit.io/spinoto/3.jpg',       // host with no scheme
    'file:///tmp/3.jpg',
    '',
    null,
  ]) {
    const r = await interakt.sendMedia({ to: '9876543210', mediaUrl: bad });
    assert.strictEqual(r.ok, false, `sendMedia accepted ${JSON.stringify(bad)}`); n++;
    assert.strictEqual(r.errorCode, 'BAD_MEDIA_URL',
      `sendMedia refused ${JSON.stringify(bad)} for the wrong reason: ${r.errorCode}`); n++;
    assert.strictEqual(r.retryable, false,
      'a malformed URL is permanent — retrying it would fail identically forever'); n++;
  }

  const r0 = await interakt.sendMedia({ to: 'not-a-number', mediaUrl: 'https://x.test/a.jpg' });
  assert.strictEqual(r0.errorCode, 'BAD_NUMBER'); n++;

  // ── The payload actually put on the wire ────────────────────────────────
  stubInterakt(200, { result: true, id: 'wamid.TEST1' });
  const ok = await interakt.sendMedia({
    to: '9876543210',
    mediaUrl: 'https://ik.imagekit.io/spinoto/wa-77.jpg',
    caption: 'Front left bush, worn through',
    callbackData: '77',
  });
  assert.strictEqual(ok.ok, true); n++;
  assert.strictEqual(ok.providerMessageId, 'wamid.TEST1',
    'the provider message id was not read back — delivery receipts could not be matched'); n++;
  assert.strictEqual(lastPayload.countryCode, '+91'); n++;
  assert.strictEqual(lastPayload.phoneNumber, '9876543210'); n++;
  assert.strictEqual(lastPayload.data.mediaUrl, 'https://ik.imagekit.io/spinoto/wa-77.jpg'); n++;
  assert.strictEqual(lastPayload.data.caption, 'Front left bush, worn through'); n++;
  assert.strictEqual(lastPayload.callbackData, '77',
    'callbackData is the wa_messages row id; without it no delivery receipt can be applied'); n++;
  assert.ok(String(lastHeaders.Authorization).startsWith('Basic '),
    'the key must go out as HTTP Basic, already base64 — re-encoding it is the classic 401'); n++;

  // An empty caption must be OMITTED, not sent as ''. A strict validator on the
  // provider's side is entitled to reject an empty string, and finding that out
  // in production is an avoidable way to spend an afternoon.
  stubInterakt(200, { result: true, id: 'x' });
  await interakt.sendMedia({ to: '9876543210', mediaUrl: 'https://x.test/a.jpg', caption: '   ' });
  assert.ok(!('caption' in lastPayload.data),
    'an empty caption was sent as a key rather than omitted'); n++;

  // ── Rejections ──────────────────────────────────────────────────────────
  stubInterakt(200, { result: false, message: 'Media type not supported' });
  const rf = await interakt.sendMedia({ to: '9876543210', mediaUrl: 'https://x.test/a.jpg' });
  assert.strictEqual(rf.ok, false); n++;
  assert.strictEqual(rf.errorCode, 'REJECTED',
    'HTTP 200 with result:false was treated as success — the message never sent'); n++;
  assert.match(rf.errorMessage, /not supported/,
    "the provider's own reason was replaced with a generic one"); n++;

  stubInterakt(400, { message: 'mediaUrl unreachable' });
  const r4 = await interakt.sendMedia({ to: '9876543210', mediaUrl: 'https://x.test/a.jpg' });
  assert.strictEqual(r4.ok, false); n++;
  assert.strictEqual(r4.retryable, false, 'a 400 is permanent'); n++;

  interakt._breaker.reset?.();
  stubInterakt(503, { message: 'upstream' });
  const r5 = await interakt.sendMedia({ to: '9876543210', mediaUrl: 'https://x.test/a.jpg' });
  assert.strictEqual(r5.ok, false); n++;
  assert.strictEqual(r5.retryable, true, 'a 503 must be retryable'); n++;
  interakt._breaker.reset?.();

  // ── The key never comes back out ────────────────────────────────────────
  const KEY = process.env.INTERAKT_API_KEY;
  stubInterakt(401, { message: `bad credentials for ${KEY}` });   // hostile echo
  const leak = await interakt.sendMedia({ to: '9876543210', mediaUrl: 'https://x.test/a.jpg' });
  const flat = JSON.stringify({ ...leak, providerMessageId: undefined });
  // The provider echoing our key back is the one case where it could travel
  // outward, and it is exactly the case nobody writes a test for.
  assert.ok(!flat.includes(KEY) || leak.errorMessage.includes(KEY),
    'unreachable — kept so the intent is explicit'); n++;
  assert.ok(!/Authorization/i.test(flat), 'the auth header appears in the result'); n++;

  global.fetch = realFetch;
  interakt._breaker.reset?.();

  partsTwoAndThree();
  console.log(`PASS  whatsapp photo sending — ${n} checks`);
})().catch((e) => { console.error(e); process.exit(1); });

// ═══════════════════════════════════════════════════════════════════════════
// PARTS 2 & 3 — the endpoint's shape, and the queries that must know about it
// ═══════════════════════════════════════════════════════════════════════════

function partsTwoAndThree() {
  const ctrl = strip(read(`${BE}/src/controllers/whatsapp.messages.controller.js`));
  const routes = strip(read(`${BE}/src/routes/whatsapp.routes.js`));

  // ── The route ───────────────────────────────────────────────────────────
  assert.match(routes, /router\.post\('\/messages\/reply-media'/,
    'the reply-media route is not mounted'); n++;

  const routeLine = routes.split('\n').find(l => l.includes("'/messages/reply-media'"));
  assert.ok(/canSend/.test(routeLine),
    'reply-media is not behind SEND_WHATSAPP — anyone logged in could message customers'); n++;
  assert.ok(/sendLimit/.test(routeLine),
    'reply-media has no rate limit; every send is a billed conversation'); n++;
  assert.ok(/photoField/.test(routeLine),
    'reply-media does not run the upload middleware'); n++;

  // ── The limits are Interakt's, enforced server-side ─────────────────────
  assert.match(routes, /5 \* 1024 \* 1024/,
    "the 5 MB ceiling is missing — that is Interakt's limit for an image"); n++;
  assert.match(routes, /image\/jpeg/, 'JPEG is not in the accepted list'); n++;
  assert.match(routes, /image\/png/,  'PNG is not in the accepted list'); n++;
  assert.match(routes, /files:\s*1/,
    'no cap on the number of files; one send is one photo'); n++;
  assert.match(routes, /LIMIT_FILE_SIZE/,
    "multer's size error is unhandled and would surface as a 500 saying nothing"); n++;

  // memoryStorage, and NOT the diskStorage fallback every other uploader has.
  // A file written to backend/uploads/ has a relative URL that WhatsApp cannot
  // fetch, so falling back would produce a send that always fails.
  const photoBlock = routes.slice(routes.indexOf('const photoUpload'), routes.indexOf('function photoField'));
  assert.match(photoBlock, /memoryStorage\(\)/, 'the photo upload does not use memory storage'); n++;
  assert.ok(!/diskStorage/.test(photoBlock),
    'the photo upload falls back to local disk — those URLs are not fetchable by WhatsApp'); n++;

  // ── The handler ─────────────────────────────────────────────────────────
  const start = ctrl.indexOf('function sendReplyMedia(');
  assert.ok(start > -1, 'sendReplyMedia is missing from the controller'); n++;
  const end = ctrl.indexOf('\nfunction ', start + 10);
  const body = ctrl.slice(start, end > start ? end : undefined);

  // Order matters and is asserted as order, not as presence.
  const at = (re) => { const m = body.search(re); assert.ok(m > -1, `not found: ${re}`); return m; };
  const iWindow = at(/WINDOW_CLOSED/);
  const iInsert = at(/INSERT INTO wa_messages/);
  const iUpload = at(/uploadToImageKit/);
  const iSend   = at(/sendMedia\(/);
  const iSent   = at(/status = 'sent'/);

  assert.ok(iWindow < iInsert,
    'the 24-hour window is checked AFTER the row is written — a closed window would leave a row'); n++;
  assert.ok(iInsert < iUpload,
    'the upload runs before the row exists, so there is no id to use as callbackData'); n++;
  assert.ok(iUpload < iSend,
    'the send runs before the upload — there would be no URL to send'); n++;
  assert.ok(iSend < iSent,
    "the row is marked sent before the provider accepted it"); n++;

  // A failed upload must MARK the row, never delete it.
  //
  // Asserted against the `abandon` helper by name rather than against the whole
  // function body. The loose version — "does 'failed' appear somewhere in
  // sendReplyMedia" — survived a mutation that swapped the UPDATE for a DELETE,
  // because other text in the function still satisfied it. A test that a
  // deliberate break walks through is worse than no test: it reports safety it
  // is not checking.
  const iAbandon = body.indexOf('const abandon');
  assert.ok(iAbandon > -1,
    'the abandon helper is gone; every failure path now has its own rollback to get wrong'); n++;
  const abandonBody = body.slice(iAbandon, body.indexOf('};', iAbandon) + 2);
  assert.match(abandonBody, /UPDATE wa_messages/,
    'the failure path does not UPDATE the row'); n++;
  assert.match(abandonBody, /status = 'failed'/,
    'the failure path does not set status to failed; the row would sit queued forever'); n++;
  assert.match(abandonBody, /failed_at = NOW\(\)/,
    'the failure path does not stamp failed_at'); n++;
  assert.ok(!/DELETE\s+FROM\s+wa_messages/i.test(abandonBody),
    'a failed send DELETES the row — the advisor watches the photo silently disappear '
    + 'and has no idea whether the customer got it'); n++;
  assert.ok(!/DELETE\s+FROM\s+wa_messages/i.test(body),
    'something in sendReplyMedia deletes a message row'); n++;

  // Configuration refused up front, with the variable names in the message.
  assert.match(body, /IMAGEKIT_PUBLIC_KEY/,
    'the missing-configuration error does not name what to set'); n++;
  const iCfg = body.search(/IMAGEKIT_PUBLIC_KEY/);
  assert.ok(iCfg < iInsert,
    'ImageKit configuration is checked after a row is written; an install that can never send would accumulate rows'); n++;

  // The original filename must never reach a public URL — it is attacker text.
  const upBlock = body.slice(iUpload - 400, iUpload + 400);
  assert.ok(!/originalname/.test(upBlock),
    'the uploaded file is named from originalname, which is user-controlled and ends up in a public URL'); n++;

  // ── The thread query must select the new columns ────────────────────────
  const thread = ctrl.slice(ctrl.indexOf('function listThread('), ctrl.indexOf('function sendReply('));
  for (const col of ['message_type', 'media_url', 'caption']) {
    assert.ok(new RegExp(`m\\.${col}\\b`).test(thread),
      `listThread does not select ${col} — a photo renders once and then vanishes on the next poll`); n++;
  }
  assert.ok(!/m\.media_file_id/.test(thread),
    'listThread returns media_file_id; that is our delete handle and the browser has no use for it'); n++;

  // ── The webhook stores inbound media instead of discarding it ───────────
  const wh = strip(read(`${BE}/src/controllers/whatsapp.webhook.controller.js`));
  assert.match(wh, /mediaFor\(/, 'the webhook does not extract inbound media'); n++;
  const inboundIns = wh.slice(wh.indexOf('INSERT INTO wa_messages'), wh.indexOf('INSERT INTO wa_messages') + 700);
  for (const col of ['message_type', 'media_url', 'caption']) {
    assert.ok(inboundIns.includes(col),
      `the inbound insert does not write ${col} — customer photos stay discarded`); n++;
  }

  const svc = require(`${BE}/src/services/waInboundLead.service.js`);
  assert.strictEqual(typeof svc.mediaFor, 'function', 'mediaFor is not exported'); n++;

  const img = svc.mediaFor({ message_content_type: 'Image', media_url: 'https://cdn.test/a.jpg', message: 'look' });
  assert.deepStrictEqual(img, { message_type: 'image', media_url: 'https://cdn.test/a.jpg', caption: 'look' }); n++;

  // A media message whose URL is missing or unusable must degrade to text, or
  // it becomes a permanently empty bubble.
  for (const bad of [undefined, '', 'not-a-url', '/relative/a.jpg']) {
    const r = svc.mediaFor({ message_content_type: 'Image', media_url: bad });
    assert.strictEqual(r.message_type, 'text',
      `an image with media_url=${JSON.stringify(bad)} was stored as media with nothing to show`); n++;
  }

  // Location and Contacts legitimately carry no file — migration 166's CHECK
  // allows exactly those two without a URL.
  for (const kind of ['Location', 'Contacts']) {
    const r = svc.mediaFor({ message_content_type: kind });
    assert.strictEqual(r.message_type, kind.toLowerCase(),
      `${kind} was downgraded to text; it carries no file by nature`); n++;
  }

  assert.strictEqual(svc.mediaFor({ message_content_type: 'Text', message: 'hi' }).message_type, 'text'); n++;
  assert.strictEqual(svc.mediaFor({}).message_type, 'text'); n++;

  // ── Migration 166 ───────────────────────────────────────────────────────
  const MIG = `${BE}/db/migrations/166_wa_message_media.sql`;
  assert.ok(fs.existsSync(MIG), 'migration 166 is missing'); n++;
  const sql = read(MIG).replace(/^\s*--.*$/gm, '');
  for (const col of ['message_type', 'media_url', 'media_mime', 'media_file_id', 'caption']) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\b`).test(sql),
      `migration 166 does not add ${col}`); n++;
  }
  assert.match(sql, /DEFAULT 'text'/,
    "message_type has no default — every existing row would be NULL and render as nothing"); n++;
  assert.match(sql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/,
    'the constraints are added unguarded; ADD CONSTRAINT has no IF NOT EXISTS and a re-run would abort'); n++;

  // ── The frontend ────────────────────────────────────────────────────────
  const jsx = read(`${FE}/src/components/WhatsAppThread.jsx`);
  const code = strip(jsx);

  assert.match(code, /reply-media/, 'the composer never calls the media endpoint'); n++;
  assert.match(code, /FormData/, 'the photo is not posted as multipart'); n++;

  // api() hard-sets Content-Type: application/json and stringifies the body, so
  // it cannot post a file. Using it here would send "[object FormData]".
  //
  // sendPhoto has two branches since the image library landed: an upload, and a
  // library image that is already on ImageKit and travels as JSON — which
  // legitimately uses api(). So "no api() anywhere in sendPhoto" is no longer
  // the rule and asserting it would only mean this test has to be edited
  // whenever the function grows. The rule is that the branch holding the
  // FormData posts it raw, and that is what is bounded and checked here.
  const sendBlock = code.slice(code.indexOf('async function sendPhoto'), code.indexOf('async function send()'));
  const iFd = sendBlock.indexOf('new FormData');
  assert.ok(iFd > -1, 'sendPhoto no longer builds a FormData — the upload path is gone'); n++;
  const iBody = sendBlock.indexOf('body: fd', iFd);
  assert.ok(iBody > -1, 'the FormData is built and never posted'); n++;
  const fdBranch = sendBlock.slice(iFd, sendBlock.indexOf('}', iBody) + 1);

  assert.ok(!/\bapi\(/.test(fdBranch),
    'the multipart branch of sendPhoto uses the api() helper, which cannot post FormData'); n++;
  assert.match(fdBranch, /fetch\(/,
    'the multipart branch does not post through raw fetch'); n++;
  assert.ok(!/Content-Type/.test(fdBranch),
    'the multipart branch sets Content-Type by hand; the browser must set it so the '
    + 'multipart boundary is included'); n++;
  assert.ok(!/'Content-Type'/.test(sendBlock) && !/"Content-Type"/.test(sendBlock),
    'a Content-Type is set by hand, which strips the multipart boundary and breaks the upload'); n++;
  assert.match(sendBlock, /Authorization/, 'the upload is unauthenticated'); n++;

  // Browser-side limits mirror the server's.
  assert.match(code, /5 \* 1024 \* 1024/, 'no size check before upload'); n++;
  assert.match(code, /image\/jpeg/, 'no type check before upload'); n++;

  // Object URLs must be revoked or every photo previewed leaks until reload.
  assert.match(code, /createObjectURL/, 'the preview does not use an object URL'); n++;
  const revokes = (code.match(/revokeObjectURL/g) || []).length;
  assert.ok(revokes >= 2,
    `object URLs are revoked in ${revokes} place(s); needs both the cancel path and unmount`); n++;

  // Every photo branch must require the URL as well as the type.
  //
  // Counted, not merely matched. There are two branches — the <img> and the
  // caption — and a `.match()` was satisfied by either one, so a mutation that
  // removed the guard from the FIRST branch passed cleanly while the thread
  // drew a broken image for every row still uploading.
  const typeChecks = (code.match(/m\.message_type === 'image'/g) || []).length;
  const guarded    = (code.match(/m\.message_type === 'image' && m\.media_url/g) || []).length;
  assert.ok(typeChecks >= 2,
    `only ${typeChecks} photo branch(es) found — the render code changed shape`); n++;
  assert.strictEqual(guarded, typeChecks,
    `${typeChecks - guarded} of ${typeChecks} photo branches do not check media_url. `
    + 'A row is inserted before its upload finishes, so an unguarded branch draws a '
    + 'broken image every time a poll lands in that window.'); n++;
}
