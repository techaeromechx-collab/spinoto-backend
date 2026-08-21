'use strict';

/**
 * The WhatsApp image library and quick replies.
 *
 * ── WHAT THIS SUITE IS ACTUALLY GUARDING ────────────────────────────────────
 *
 * Not "does the picker work". Four things that would work perfectly on screen
 * and be wrong:
 *
 *   1. THE SEND ENDPOINT MUST NOT TAKE A URL FROM THE BROWSER. The composer
 *      knows the image's address — it drew the thumbnail from it — so posting
 *      that address is the obvious implementation and it turns the endpoint
 *      into an open relay: anything with an advisor's token could send any
 *      image on the internet from the workshop's WhatsApp number. The id is
 *      sent; the server resolves the address. The difference is invisible in
 *      the UI and total in effect.
 *
 *   2. "SWITCHED OFF" MUST MEAN ABSENT, NOT HIDDEN. A disabled image that
 *      arrives in the agent's response and is merely not drawn is one devtools
 *      tab away from being sent. Both the LIST and the SEND re-check.
 *
 *   3. THE PAPERCLIP SWITCH MUST BE ENFORCED ON THE SERVER. Hiding a button is
 *      a suggestion. An advisor with the page already open, or anyone who has
 *      seen the network tab, still has the route.
 *
 *   4. A QUICK REPLY MUST BE INSERTED, NEVER SENT. One tap that puts the
 *      opening hours in front of somebody who asked what a clutch costs is the
 *      failure this feature is one line of code away from at all times.
 *
 * The permission split is asserted from the router text rather than trusted,
 * because a wrong middleware on one of eleven routes is invisible until the
 * wrong person uses it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE   = path.resolve(__dirname, '..');
const ROOT = path.join(BE, 'src');
const FE   = path.resolve(BE, '../frontend');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — Migration 168
// ═══════════════════════════════════════════════════════════════════════════

const MIG = path.join(BE, 'db/migrations/168_wa_library.sql');
assert.ok(fs.existsSync(MIG), 'migration 168 is missing'); n++;
const sql = read(MIG).replace(/^\s*--.*$/gm, '');

for (const t of ['wa_images', 'wa_quick_replies']) {
  assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${t}\\b`).test(sql),
    `migration 168 does not create ${t}`); n++;
}

// Case-insensitive uniqueness on the picker labels. Two rows called "Price
// list" and "Price List" are the same choice to the person picking, and a
// picker offering both is a coin toss.
assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_images_name[\s\S]*?LOWER\(TRIM\(name\)\)/,
  'wa_images.name is not uniquely indexed case-insensitively'); n++;
assert.match(sql, /idx_wa_quick_replies_title[\s\S]*?LOWER\(TRIM\(title\)\)/,
  'wa_quick_replies.title is not uniquely indexed case-insensitively'); n++;

// The shortcut index MUST be partial. A plain UNIQUE would also permit several
// NULLs in PostgreSQL, so this is not about correctness of the NULL case — it
// is that '' is not NULL, and two rows saved with an empty shortcut would
// collide under a non-partial index and be refused for a reason nobody could
// act on.
const shortcutIdx = sql.slice(sql.indexOf('idx_wa_quick_replies_shortcut'));
assert.match(shortcutIdx.slice(0, 300), /WHERE\s+shortcut IS NOT NULL AND TRIM\(shortcut\) <> ''/,
  'the shortcut unique index is not partial; two blank shortcuts would collide'); n++;

// No seeded row for the upload flag. Seeding 'true' would look tidier and make
// an install that never opens the screen depend on a row that may not exist.
assert.ok(!/INSERT INTO integration_settings/i.test(sql),
  "migration 168 seeds the upload flag; absence must mean ON, so there is nothing to insert"); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — The router: who may do what
// ═══════════════════════════════════════════════════════════════════════════

const routes = read(path.join(ROOT, 'routes/whatsapp.routes.js'));
const routesNC = strip(routes);

/* Parsed rather than eyeballed. The mistake this catches is a single route
   given canRead instead of canManage, which no screen would reveal — the admin
   tab works, and so does everyone else's. */
function middlewareFor(method, urlPath) {
  const re = new RegExp(
    `router\\.${method}\\s*\\(\\s*['"]${urlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*,([^)]*)\\)`);
  const m = routesNC.match(re);
  assert.ok(m, `route ${method.toUpperCase()} ${urlPath} is not registered`); n++;
  return m[1];
}

const MANAGE_ONLY = [
  ['post',   '/images'],
  ['patch',  '/images/:id'],
  ['delete', '/images/:id'],
  ['post',   '/quick-replies'],
  ['patch',  '/quick-replies/:id'],
  ['delete', '/quick-replies/:id'],
  ['put',    '/library-settings'],
];
for (const [method, p] of MANAGE_ONLY) {
  const mw = middlewareFor(method, p);
  assert.ok(/\bcanManage\b/.test(mw),
    `${method.toUpperCase()} ${p} is not behind canManage — an advisor could change what the business sends`); n++;
  assert.ok(!/\bcanSend\b/.test(mw) && !/\bcanRead\b/.test(mw) && !/canReadLib/.test(mw),
    `${method.toUpperCase()} ${p} is reachable with a read-level permission`); n++;
}

const READ_ONLY = [
  ['get', '/images'],
  ['get', '/quick-replies'],
  ['get', '/library-settings'],
];
for (const [method, p] of READ_ONLY) {
  const mw = middlewareFor(method, p);
  assert.ok(/canRead(Lib)?\b/.test(mw),
    `GET ${p} is not readable by an agent — the picker would be empty for the people who use it`); n++;
}

// The two LIST routes, and only those, carry the ?all=1 guard. library-settings
// has no such flag, and putting the guard there would be cargo cult.
for (const p of ['/images', '/quick-replies']) {
  assert.ok(/guardAllFlag/.test(middlewareFor('get', p)),
    `GET ${p} has no guardAllFlag — an agent could ask for the disabled rows with four extra characters`); n++;
}

// The send route sits with the other sends: same permission, same rate limit.
// A library image costs the same 24-hour conversation as a typed reply, so an
// endpoint that skipped sendLimit would be the cheap way around it.
const sendImage = middlewareFor('post', '/messages/reply-image');
assert.ok(/\bcanSend\b/.test(sendImage), 'reply-image is not behind canSend'); n++;
assert.ok(/\bsendLimit\b/.test(sendImage),
  'reply-image skips sendLimit — an unlimited image sender beside a rate-limited text one'); n++;

// guardAllFlag downgrades; it must not reject. An agent who somehow sends the
// flag should get the list they are entitled to, not a 403 they cannot act on.
const guard = routesNC.slice(routesNC.indexOf('function guardAllFlag'));
const guardBody = guard.slice(0, guard.indexOf('\n}') + 2);
assert.match(guardBody, /delete req\.query\.all/,
  'guardAllFlag does not clear the flag; the handler would still see it'); n++;
assert.ok(!/res\.status\(4\d\d\)/.test(guardBody),
  'guardAllFlag rejects instead of downgrading'); n++;
assert.match(guardBody, /MANAGE_WHATSAPP_TEMPLATES/,
  'guardAllFlag does not check the manage permission'); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — The controller, run for real against a fake pool
// ═══════════════════════════════════════════════════════════════════════════

const QUERIES = [];
let NEXT = { rows: [], rowCount: 0 };
const fakePool = {
  query: async (s, params) => { QUERIES.push({ sql: String(s), params }); return NEXT; },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};

let SETTINGS = {};
for (const [file, exp] of Object.entries({
  [path.join(ROOT, 'config/db.js')]: { pool: fakePool },
  [path.join(ROOT, 'services/activityLog.service.js')]: { logActivity: () => {} },
  // getSetting returns '' for an unknown key, exactly as the real one does —
  // that empty string is what "default ON" is asserted against below.
  [path.join(ROOT, 'services/integrationSettings.service.js')]: {
    getSetting: (k) => (k in SETTINGS ? SETTINGS[k] : ''),
    putSetting: async (_pool, k, v) => { SETTINGS[k] = v; },
  },
})) require.cache[file] = { id: file, filename: file, loaded: true, exports: exp };

const lib = require(path.join(ROOT, 'controllers/whatsapp.library.controller.js'));

function run(handler, req) {
  return new Promise((resolve) => {
    const res = {
      json: (b) => resolve({ status: 200, body: b }),
      status: (s) => ({ json: (b) => resolve({ status: s, body: b }), end: () => resolve({ status: s }) }),
    };
    handler(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
    setTimeout(() => resolve({ status: 'timeout' }), 500);
  });
}

const ADMIN = { id: 7, name: 'Admin', permissions: new Set(['MANAGE_WHATSAPP_TEMPLATES']) };

(async () => {

  // ── The agent's list is filtered in SQL, not in the browser ─────────────
  QUERIES.length = 0;
  NEXT = { rows: [], rowCount: 0 };
  await run(lib.listImages, { query: {}, user: { id: 1, permissions: new Set(['SEND_WHATSAPP']) } });
  assert.match(QUERIES[0].sql, /WHERE is_active/,
    'the agent image list does not filter on is_active — a disabled image is sent to the browser '
    + 'and only hidden there, which is not the same promise'); n++;

  QUERIES.length = 0;
  await run(lib.listQuickReplies, { query: {}, user: { id: 1, permissions: new Set(['SEND_WHATSAPP']) } });
  assert.match(QUERIES[0].sql, /WHERE is_active/,
    'the agent quick-reply list does not filter on is_active'); n++;

  // The admin screen must see everything, or an image cannot be switched back
  // on once it is off.
  QUERIES.length = 0;
  await run(lib.listImages, { query: { all: '1' }, user: ADMIN });
  assert.ok(!/WHERE is_active/.test(QUERIES[0].sql),
    'all=1 still filters — a disabled image would be unreachable from the screen that disabled it'); n++;

  // ── The URL rule ────────────────────────────────────────────────────────
  //
  // Every one of these is reachable from OUR server and from nobody else's.
  // WhatsApp fetches the image itself, so each would fail at send time with a
  // provider error blaming the picture.
  for (const bad of [
    '/uploads/wa/1.jpg',
    'uploads/wa/1.jpg',
    'ik.imagekit.io/spinoto/1.jpg',
    'file:///tmp/1.jpg',
    'http://localhost:4000/a.jpg',
    'http://127.0.0.1/a.jpg',
    'ftp://example.test/a.jpg',
  ]) {
    QUERIES.length = 0;
    const r = await run(lib.createImage,
      { body: { name: `X${n}`, imagekit_url: bad }, user: ADMIN });
    assert.strictEqual(r.status, 422,
      `createImage accepted ${bad} (status ${r.status})`); n++;
    assert.strictEqual(QUERIES.length, 0,
      `createImage wrote ${bad} to the database before validating it`); n++;
  }

  NEXT = { rows: [{ id: 3, name: 'Price list', imagekit_url: 'https://ik.imagekit.io/s/p.jpg', is_active: true }], rowCount: 1 };
  const good = await run(lib.createImage,
    { body: { name: 'Price list', imagekit_url: 'https://ik.imagekit.io/s/p.jpg' }, user: ADMIN });
  assert.strictEqual(good.status, 201, 'a valid https ImageKit URL was refused'); n++;

  // A PATCH that changes the URL must be validated too. The create-only check
  // is the version of this that ships: the form that adds an image is the one
  // people test.
  QUERIES.length = 0;
  const badPatch = await run(lib.updateImage,
    { params: { id: '3' }, body: { imagekit_url: '/local/x.jpg' }, user: ADMIN });
  assert.strictEqual(badPatch.status, 422,
    'updateImage accepts an unreachable URL that createImage refuses'); n++;
  assert.strictEqual(QUERIES.length, 0, 'updateImage wrote before validating'); n++;

  // ── Shortcut normalisation ──────────────────────────────────────────────
  //
  // The unique index is on LOWER(TRIM(shortcut)), so '/Location' and
  // '/location' already collide. Normalising on the way IN means the collision
  // is reported as "another entry already uses that shortcut" instead of being
  // accepted and discovered later.
  NEXT = { rows: [{ id: 1, title: 'T', shortcut: '/hours', message: 'm', is_active: true }], rowCount: 1 };
  for (const [input, expected] of [
    ['hours',     '/hours'],
    ['/hours',    '/hours'],
    ['  /Hours ', '/hours'],
    ['HOURS',     '/hours'],
    ['',          null],
    ['   ',       null],
    [null,        null],
    [undefined,   null],
  ]) {
    QUERIES.length = 0;
    await run(lib.createQuickReply,
      { body: { title: `T${n}`, message: 'x', ...(input === undefined ? {} : { shortcut: input }) }, user: ADMIN });
    assert.strictEqual(QUERIES[0].params[1], expected,
      `shortcut ${JSON.stringify(input)} stored as ${JSON.stringify(QUERIES[0].params[1])}, expected ${JSON.stringify(expected)}`); n++;
  }

  // ── A duplicate is a sentence, not a constraint name ────────────────────
  for (const [constraint, word] of [
    ['idx_wa_images_name', 'name'],
    ['idx_wa_quick_replies_title', 'title'],
    ['idx_wa_quick_replies_shortcut', 'shortcut'],
  ]) {
    fakePool.query = async () => { const e = new Error('dup'); e.code = '23505'; e.constraint = constraint; throw e; };
    const r = await run(lib.createImage,
      { body: { name: 'Dup', imagekit_url: 'https://ik.test/a.jpg' }, user: ADMIN });
    assert.strictEqual(r.status, 409, `a duplicate ${word} did not return 409`); n++;
    assert.match(r.body.error, new RegExp(word),
      `the duplicate message does not name the field: ${r.body.error}`); n++;
    assert.ok(!/constraint|idx_wa/i.test(r.body.error),
      'the duplicate message leaks the index name'); n++;
  }

  // Missing tables must say what to run. The alternative is a 500 during the
  // first deploy after this feature, with the answer sitting in a log.
  fakePool.query = async () => { const e = new Error('missing'); e.code = '42P01'; throw e; };
  const noTable = await run(lib.listImages, { query: {}, user: ADMIN });
  assert.strictEqual(noTable.status, 503, 'a missing table is not reported as a pending migration'); n++;
  assert.match(noTable.body.error, /db:migrate/, 'the migration error does not say what to run'); n++;

  fakePool.query = async (s, params) => { QUERIES.push({ sql: String(s), params }); return NEXT; };

  // ── The paperclip flag ──────────────────────────────────────────────────
  //
  // Absent must mean ON. An install that has never opened this screen has no
  // row, and if that read as OFF the feature would disappear on upgrade for
  // everybody who did nothing.
  assert.strictEqual(typeof lib.localUploadAllowed, 'function',
    'localUploadAllowed is not exported; the send endpoint cannot enforce the setting'); n++;

  /* ── The key must be on integrationSettings' allowlist ──────────────────
   *
   * putSetting throws 'Unknown integration setting' for anything not in
   * KNOWN_KEYS. Reading a missing key is fine — getSetting returns '' and the
   * paperclip stays ON — so this failure is invisible until somebody actually
   * moves the switch, and then it is a 500 with the toggle snapping back.
   *
   * Read from the FILE rather than required, because the module is stubbed a
   * few lines above for the handler tests: requiring it here would ask the
   * stub whether the real service knows the key, which is a question the stub
   * cannot get wrong. That is exactly how this shipped broken once. */
  // Comments stripped first. The array is heavily commented, and a check
  // against the raw text passes on a key that has been COMMENTED OUT — which
  // is the tidiest way for this to regress.
  const svcSrc = strip(read(path.join(ROOT, 'services/integrationSettings.service.js')));
  const iKnown = svcSrc.indexOf('const KNOWN_KEYS');
  assert.ok(iKnown > -1, 'KNOWN_KEYS is gone from integrationSettings.service'); n++;
  const knownArr = svcSrc.slice(iKnown, svcSrc.indexOf(']', iKnown));
  assert.ok(knownArr.includes(`'${lib.UPLOAD_KEY}'`),
    `'${lib.UPLOAD_KEY}' is not in KNOWN_KEYS — putSetting throws and the toggle 500s`); n++;

  // Storing '' would DELETE the row, and an absent row means ON. So the OFF
  // path must write a non-empty string or it means its own opposite.
  const saveFn = strip(read(path.join(ROOT, 'controllers/whatsapp.library.controller.js')));
  const iSave = saveFn.indexOf('function saveLibrarySettings');
  const saveBody = saveFn.slice(iSave, saveFn.indexOf('\n}', iSave));
  assert.match(saveBody, /\? 'true' : 'false'/,
    'the setting is not written as an explicit true/false string; an empty value deletes '
    + 'the row, and no row means ON'); n++;

  SETTINGS = {};
  assert.strictEqual(lib.localUploadAllowed(), true,
    'no stored value reads as OFF — upgrading would silently remove the paperclip'); n++;
  SETTINGS = { wa_allow_local_upload: 'true' };
  assert.strictEqual(lib.localUploadAllowed(), true); n++;
  SETTINGS = { wa_allow_local_upload: 'false' };
  assert.strictEqual(lib.localUploadAllowed(), false,
    "'false' does not switch it off"); n++;
  // Anything unrecognised means ON, for the same reason absence does.
  SETTINGS = { wa_allow_local_upload: 'yes' };
  assert.strictEqual(lib.localUploadAllowed(), true); n++;

  SETTINGS = {};
  const put = await run(lib.saveLibrarySettings, { body: { allow_local_upload: false }, user: ADMIN });
  assert.strictEqual(put.status, 200, 'the setting could not be saved'); n++;
  assert.strictEqual(lib.localUploadAllowed(), false,
    'saving OFF did not take effect on the next read — the value is cached somewhere it should not be'); n++;

  // A string 'false' from a careless client must be rejected, not coerced.
  // Boolean('false') is true, so a lenient parse here turns "switch it off"
  // into "switch it on".
  const bad = await run(lib.saveLibrarySettings, { body: { allow_local_upload: 'false' }, user: ADMIN });
  assert.strictEqual(bad.status, 422,
    "allow_local_upload accepts the STRING 'false', which coerces to true"); n++;

  // ═════════════════════════════════════════════════════════════════════════
  // PART 4 — sendReplyImage: the address comes from the database
  // ═════════════════════════════════════════════════════════════════════════

  const ctrl = read(path.join(ROOT, 'controllers/whatsapp.messages.controller.js'));
  const ctrlNC = strip(ctrl);

  const iImg = ctrlNC.search(/(async )?function sendReplyImage\(/);
  assert.ok(iImg > -1, 'sendReplyImage is missing'); n++;
  // Bounded at the next top-level function, so nothing below leaks into these
  // assertions — the loose version of this test passes on text that belongs to
  // a different handler.
  const after = ctrlNC.slice(iImg + 10);
  const iEnd  = after.search(/\n(async )?function \w+\(/);
  const imgFn = ctrlNC.slice(iImg, iEnd > -1 ? iImg + 10 + iEnd : ctrlNC.length);

  // The request shape is a zod schema, which makes it an ALLOWLIST: zod strips
  // keys the schema does not name, so what this declares is exactly what the
  // handler can see. Asserted against the schema rather than against reads of
  // req.body, because the schema is the thing that decides.
  const iSchema = ctrlNC.indexOf('const replyImageBody');
  assert.ok(iSchema > -1, 'sendReplyImage has no request schema; req.body reaches it unfiltered'); n++;
  const schema = ctrlNC.slice(iSchema, ctrlNC.indexOf('});', iSchema) + 3);

  assert.match(schema, /image_id/, 'the request schema has no image_id'); n++;
  assert.match(imgFn, /b\.image_id/, 'sendReplyImage never uses image_id'); n++;

  // THE assertion of this suite. Every name a browser could smuggle an address
  // in under — absent from the schema, so absent from the parsed body.
  for (const field of ['imagekit_url', 'image_url', 'mediaUrl', 'media_url', 'url']) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(schema),
      `the request schema accepts ${field} — the endpoint would relay any image on the `
      + `internet from the workshop's number`); n++;
    assert.ok(!new RegExp(`req\\.body[^;]{0,40}${field}\\b`).test(imgFn),
      `sendReplyImage reads ${field} straight off req.body, bypassing the schema`); n++;
  }

  // The address that goes on the wire must come from the row, not the request.
  assert.match(imgFn, /(img\.rows\[0\]|row)\.imagekit_url/,
    'the URL sent to Interakt does not come from the database row'); n++;

  assert.match(imgFn, /FROM wa_images/,
    'sendReplyImage does not look the image up; where does the URL come from?'); n++;

  // The lookup must re-check is_active. The list already filters, but the list
  // was fetched when the chat opened — possibly before an admin switched the
  // image off, and possibly hours ago.
  const lookup = imgFn.slice(imgFn.indexOf('FROM wa_images'), imgFn.indexOf('FROM wa_images') + 200);
  assert.match(lookup, /is_active/,
    'the image lookup does not require is_active — a picker loaded this morning could still '
    + 'send an image disabled at lunchtime'); n++;

  // ── The upload gate, and WHERE it sits ──────────────────────────────────
  const iMedia = ctrlNC.search(/(async )?function sendReplyMedia\(/);
  assert.ok(iMedia > -1, 'sendReplyMedia is missing'); n++;
  const afterM = ctrlNC.slice(iMedia + 10);
  const iEndM  = afterM.search(/\n(async )?function \w+\(/);
  const mediaFn = ctrlNC.slice(iMedia, iEndM > -1 ? iMedia + 10 + iEndM : ctrlNC.length);

  assert.match(mediaFn, /localUploadAllowed\(\)/,
    'sendReplyMedia does not check the upload setting — hiding the button is the whole enforcement'); n++;
  assert.match(mediaFn, /LOCAL_UPLOAD_DISABLED/,
    'the refusal carries no code the frontend can recognise'); n++;

  const iGate   = mediaFn.indexOf('localUploadAllowed()');
  const iInsert = mediaFn.indexOf('INSERT INTO wa_messages');
  const iUpload = mediaFn.search(/uploadToImageKit/);
  assert.ok(iInsert === -1 || iGate < iInsert,
    'the gate runs after the message row is written — a refused upload would leave a row behind'); n++;
  assert.ok(iUpload === -1 || iGate < iUpload,
    'the gate runs after the file is pushed to ImageKit — the refusal would still have cost an upload'); n++;

  // ═════════════════════════════════════════════════════════════════════════
  // PART 5 — The frontend
  // ═════════════════════════════════════════════════════════════════════════

  const thread = read(path.join(FE, 'src/components/WhatsAppThread.jsx'));
  const threadNC = strip(thread);

  // The composer must send the id. It HAS the URL — it drew the thumbnail from
  // it — which is exactly why this is worth asserting.
  assert.match(threadNC, /reply-image/, 'the composer never calls the library send endpoint'); n++;
  const iSend = threadNC.indexOf('reply-image');
  const sendBlock = threadNC.slice(iSend, iSend + 400);
  assert.match(sendBlock, /image_id/, 'the composer does not post image_id'); n++;
  assert.ok(!/imagekit_url|mediaUrl|image_url/.test(sendBlock),
    'the composer posts the image ADDRESS; the server must resolve it from the id'); n++;

  // The paperclip is gated on the setting.
  assert.match(threadNC, /library\.allowUpload\s*&&/,
    'the paperclip is not gated on allowUpload'); n++;

  // Nothing hard-coded. An image list or a reply list written into the
  // component is a list an admin cannot change, and the whole feature is the
  // ability to change it.
  assert.ok(!/ik\.imagekit\.io/.test(threadNC),
    'an ImageKit URL is hard-coded in the composer'); n++;
  assert.match(threadNC, /\/api\/whatsapp\/images/, 'the composer does not fetch the image library'); n++;
  assert.match(threadNC, /\/api\/whatsapp\/quick-replies/, 'the composer does not fetch the quick replies'); n++;

  // A quick reply is INSERTED. If this function ever calls the API, the
  // feature has become one-tap send.
  const iQr = threadNC.indexOf('function useQuickReply');
  assert.ok(iQr > -1, 'useQuickReply is missing'); n++;
  const qrFn = threadNC.slice(iQr, threadNC.indexOf('\n  }', iQr) + 4);
  assert.match(qrFn, /setDraft/, 'useQuickReply does not put the text in the composer'); n++;
  assert.ok(!/api\(|fetch\(|send\(/.test(qrFn),
    'useQuickReply SENDS the message — a stock answer must be confirmed by a person first'); n++;

  // ── The '/' shortcut, exercised for real ────────────────────────────────
  //
  // require(esm) — the frontend is "type": "module", and Node 22 loads it
  // directly. Driving the ACTUAL matcher rather than a copy of its regex: a
  // test that reimplements the rule it checks agrees with itself no matter
  // what the app does.
  const { matchShortcut, applyShortcut } = require(path.join(FE, 'src/utils/waShortcut.js'));

  const QRS = [
    { id: 1, title: 'Test',     shortcut: '/test',    message: 'This is a test reply.' },
    { id: 2, title: 'Timing',   shortcut: '/timing',  message: '9:30 am to 7 pm.' },
    { id: 3, title: 'Location', shortcut: '/loc',     message: 'Near the bus stand.' },
    { id: 4, title: 'Price list', shortcut: null,     message: 'Prices attached.' },
  ];
  const M = (v, c) => matchShortcut(QRS, v, c === undefined ? v.length : c);

  // The plain case, and the prefix narrowing as they type.
  assert.strictEqual(M('/t').items.length, 2, "'/t' should offer /test and /timing"); n++;
  assert.strictEqual(M('/te').items.length, 1, "'/te' should narrow to /test"); n++;
  assert.strictEqual(M('/te').items[0].id, 1); n++;
  // A bare slash lists everything that HAS a shortcut — how somebody who has
  // forgotten the names finds them.
  assert.strictEqual(M('/').items.length, 3, "'/' should list every shortcut"); n++;
  // Case folded, and a stray second slash tolerated, because the server
  // normalises both on the way in.
  assert.strictEqual(M('/TE').items[0].id, 1, 'the match is case sensitive'); n++;

  // A reply with NO shortcut is unreachable this way. There is nothing the
  // advisor could have typed to mean it, so offering it would be the picker
  // appearing out of the middle of a word.
  assert.ok(!M('/').items.some(q => q.id === 4),
    'a reply with no shortcut is offered inline; nothing types it deliberately'); n++;
  assert.strictEqual(M('/pri'), null,
    "'/pri' matched a TITLE — inline matching is shortcuts only"); n++;

  // PREFIX, not "contains". '/im' is inside '/timing' and is not the start of
  // it; offering it would mean a shortcut appears while somebody is typing a
  // different word entirely.
  assert.strictEqual(M('/im'), null,
    "'/im' matched '/timing' from the middle — the match must be a prefix"); n++;
  assert.strictEqual(M('/ti').items.length, 1, "'/ti' should offer /timing alone"); n++;

  // Mid-message: after a space and after a newline are both legitimate starts.
  assert.ok(M('hello /te'), 'a shortcut after a space does not trigger'); n++;
  assert.ok(M('line one\n/te'), 'a shortcut at the start of a new line does not trigger'); n++;
  assert.strictEqual(M('hello /te').start, 6, 'the replaced range does not begin at the slash'); n++;

  // ── The cases nobody types on purpose ───────────────────────────────────
  //
  // A pasted link is the one that matters: it contains '/t' twice and would
  // pop the picker open in the middle of every URL an advisor shares.
  for (const v of [
    'https://ik.imagekit.io/test',
    'http://a.test/timing',
    'see https://x.test/t',
    'and/or',            // a slash inside a word
    'a/test',
    '24/7',
  ]) {
    assert.strictEqual(M(v), null, `the picker opens on ${JSON.stringify(v)}`); n++;
  }
  assert.strictEqual(M('//test'), null, "'//' should not search for a shortcut"); n++;

  // A shortcut may itself contain a slash — nothing stops an admin naming one
  // '/car/service'. The token has to run past the inner slash, or the match
  // would work while they type it and vanish the moment they finish.
  const SLASHY = [{ id: 9, title: 'Car service', shortcut: '/car/service', message: 'Full service.' }];
  assert.ok(matchShortcut(SLASHY, '/car', 4), "'/car' does not match '/car/service'"); n++;
  assert.ok(matchShortcut(SLASHY, '/car/', 5),
    'the match dies at the inner slash — it would work half-typed and then close'); n++;
  assert.strictEqual(matchShortcut(SLASHY, '/car/serv', 9)?.items[0].id, 9,
    "'/car/serv' does not match '/car/service'"); n++;
  assert.strictEqual(M('/zzz'), null, 'a token matching nothing still returns a range'); n++;
  assert.strictEqual(M(''), null); n++;
  assert.strictEqual(matchShortcut([], '/te', 3), null, 'no replies configured still offers a list'); n++;

  // The caret, not the end of the box. Somebody who typed a shortcut, carried
  // on, and then clicked back into the middle is not asking for a picker.
  assert.strictEqual(M('/te and then more words', 23), null,
    'the match is taken from the whole value rather than the text before the caret'); n++;
  assert.ok(M('/te and then more', 3), 'a caret sitting at the end of the token does not match'); n++;

  // ── Accepting REPLACES the token ────────────────────────────────────────
  const r1 = applyShortcut('/te', M('/te'), 'This is a test reply.');
  assert.strictEqual(r1.value, 'This is a test reply.',
    `accepting left the token behind: ${JSON.stringify(r1.value)}`); n++;
  assert.strictEqual(r1.caret, r1.value.length); n++;

  // Text on both sides survives, and the caret lands after the insert rather
  // than at the end of the box.
  const mid = 'hello /te there';
  const r2 = applyShortcut(mid, matchShortcut(QRS, mid, 9), 'X');
  assert.strictEqual(r2.value, 'hello X there',
    `accepting mid-message mangled the draft: ${JSON.stringify(r2.value)}`); n++;
  assert.strictEqual(r2.caret, 7, 'the caret did not land straight after the inserted text'); n++;

  // ── And the wiring in the composer ──────────────────────────────────────
  // matchShortcut( with the paren — the import alone is not use, and an inline
  // re-implementation beside an unused import is exactly how the rule ends up
  // existing twice with only one of them tested.
  assert.match(threadNC, /matchShortcut\(/,
    'the composer does not CALL the shared matcher; the rule would exist twice'); n++;
  assert.match(threadNC, /applyShortcut\(/,
    'the composer splices the draft itself instead of using applyShortcut'); n++;
  // Enter must belong to the list while it is open, or a highlighted
  // suggestion plus Enter sends the literal "/test" to the customer.
  const iKey = threadNC.indexOf('if (sugg && !panel)');
  assert.ok(iKey > -1, 'the suggestion list does not intercept keys'); n++;
  const keyBlock = threadNC.slice(iKey, threadNC.indexOf('send();', iKey));
  assert.match(keyBlock, /acceptSuggest/, 'Enter does not accept the highlighted suggestion'); n++;
  assert.match(keyBlock, /Escape/, 'there is no way out of the suggestion list'); n++;

  // ═════════════════════════════════════════════════════════════════════════
  // PART 6 — Getting an image INTO the library
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Two ways in, and each has a failure the other does not.

  const libSrc = strip(read(path.join(ROOT, 'controllers/whatsapp.library.controller.js')));
  const imagesTab = strip(read(path.join(FE, 'src/components/settings/WhatsAppImagesTab.jsx')));

  // ── Uploading ───────────────────────────────────────────────────────────
  assert.strictEqual(typeof lib.uploadImage, 'function', 'uploadImage is not exported'); n++;

  const iUp = libSrc.indexOf('function uploadImage(');
  assert.ok(iUp > -1, 'uploadImage is gone'); n++;
  const upFn = libSrc.slice(iUp, libSrc.indexOf('\n}', iUp));

  assert.match(upFn, /uploadToImageKit/,
    'the upload does not go through the shared ImageKit uploader'); n++;

  /* The ORIGINAL filename must never reach ImageKit.
     It is user text that ends up in a public URL, and it is the source of the
     space-sanitising confusion this endpoint exists to end — a name like
     'CAR SERVICE PRICE-03 08-06-2026.png' comes back as an address nobody can
     reproduce by reading it. */
  assert.ok(!/originalname/i.test(upFn),
    "the uploaded file is named from the browser's filename, which is user-controlled "
    + 'and lands in a public URL'); n++;

  /* The duplicate name is checked BEFORE the bytes go up. Both orders end with
     the same message; only this one avoids leaving a file on ImageKit that no
     row points at and nothing will ever clean up. */
  const iClash = upFn.indexOf('FROM wa_images WHERE LOWER(TRIM(name))');
  const iToIk = upFn.indexOf('uploadToImageKit');
  assert.ok(iClash > -1, 'uploadImage does not check the name is free'); n++;
  assert.ok(iClash < iToIk,
    'the name clash is checked AFTER the upload — a rejected save orphans a file on ImageKit'); n++;

  // fileId is stored. It is the handle a pasted address can never have, and
  // the only thing that could ever let deleting a row delete the picture.
  // The COLUMN being named is not enough — it stays in the INSERT list while a
  // literal null is passed into it, which is the shape this first passed on.
  // What matters is that ImageKit's own id reaches the row.
  assert.match(upFn, /imagekit_file_id/,
    'the insert no longer has a column for the file id'); n++;
  assert.match(upFn, /up\.fileId/,
    "the upload discards ImageKit's file id — a row created here would be no better than a "
    + 'pasted address, and the picture could never be cleaned up with the row'); n++;

  // ── Pasting: the address is checked before it is saved ──────────────────
  assert.match(libSrc, /async function probeImageUrl\(/,
    'nothing checks that a pasted address actually serves an image'); n++;

  for (const fnName of ['function createImage(', 'function updateImage(']) {
    const i = libSrc.indexOf(fnName);
    assert.ok(i > -1, `${fnName} is gone`); n++;
    const body = libSrc.slice(i, libSrc.indexOf('\n}', i));
    assert.match(body, /await probeImageUrl\(/,
      `${fnName} saves an address without checking it — the broken card and the failed send `
      + 'both arrive later, and neither names the cause'); n++;
  }

  const iProbe = libSrc.indexOf('async function probeImageUrl(');
  const probeFn = libSrc.slice(iProbe, libSrc.indexOf('\n}', libSrc.indexOf('return null;', iProbe)));

  /* The four statuses that actually happened, each with its own sentence.
     400/401/403 is ImageKit refusing an unsigned request for a PRIVATE file —
     the one that cost the most time, because the address is right and reads
     right. 404 is the renamed-file case. Lumping them into "that URL doesn't
     work" would throw away the only useful half of the answer. */
  for (const code of ['400', '404']) {
    assert.ok(probeFn.includes(code),
      `probeImageUrl does not distinguish ${code}; a private file and a missing one would `
      + 'get the same unhelpful message'); n++;
  }
  assert.match(probeFn, /private/i,
    'the 400 case does not mention the private-file setting, which is what it means'); n++;

  // A non-image is refused. A PDF or an HTML error page at a 200 is exactly
  // what a misconfigured CDN serves, and WhatsApp will not send it.
  assert.match(probeFn, /content-type/i,
    'probeImageUrl does not check the content type — an HTML error page served with a 200 '
    + 'would be saved as an image'); n++;
  assert.match(probeFn, /startsWith\('image\//,
    'the content-type check does not require an image'); n++;

  /* A probe that could not RUN must not refuse the save.
     A timeout or a blocked egress is our network, not their URL, and refusing
     there means a firewall change locks an admin out of a screen that worked
     yesterday. The catch returns null — allow — and says so in the log. */
  const iCatch = probeFn.indexOf('catch (err)');
  assert.ok(iCatch > -1, 'probeImageUrl does not handle being unable to reach the address'); n++;
  const catchBody = probeFn.slice(iCatch, iCatch + 220);
  assert.match(catchBody, /return null/,
    'a probe that could not run REFUSES the save — a network blip on our side would block a '
    + 'perfectly good address'); n++;

  // And it must not hang. Six seconds of an admin waiting is already a lot;
  // an unbounded fetch would hold the request open until the proxy gave up.
  assert.match(probeFn, /signal/,
    'the probe has no timeout — an unresponsive host would hang the save'); n++;

  // ── The route ───────────────────────────────────────────────────────────
  const upMw = middlewareFor('post', '/images/upload');
  assert.ok(/\bcanManage\b/.test(upMw),
    'anyone who can send WhatsApp can upload into the library'); n++;
  assert.ok(/photoField/.test(upMw),
    'the upload route does not reuse the shared multipart middleware, so its size and type '
    + 'limits are a second copy to keep in step'); n++;

  // ── The screen offers both, and cannot mangle a pasted address ──────────
  assert.match(imagesTab, /images\/upload/,
    'the settings screen never calls the upload endpoint'); n++;
  assert.match(imagesTab, /FormData/,
    'the upload is not posted as multipart'); n++;
  assert.ok(!/\bapi\(['\`][^'\`]*images\/upload/.test(imagesTab),
    'the upload uses api(), which stringifies its body and cannot post a file'); n++;

  /* Both address boxes select their whole contents on focus.
     Without it the caret lands wherever the click did, and a paste is INSERTED
     into the old address rather than replacing it — which produced a
     300-character hybrid of two URLs that looked almost right. Two boxes, so
     two assertions: fixing one and not the other is the obvious slip. */
  assert.strictEqual((imagesTab.match(/onFocus=\{e => e\.target\.select\(\)\}/g) || []).length, 2,
    'one of the two address boxes does not select all on focus, so a paste can land inside '
    + 'the old URL instead of replacing it'); n++;

  // ── The settings screens ────────────────────────────────────────────────
  for (const f of ['WhatsAppImagesTab.jsx', 'WhatsAppQuickRepliesTab.jsx']) {
    assert.ok(fs.existsSync(path.join(FE, 'src/components/settings', f)), `${f} is missing`); n++;
  }

  const settings = strip(read(path.join(FE, 'src/components/settings/WhatsAppSettings.jsx')));
  for (const t of ['WhatsAppImagesTab', 'WhatsAppQuickRepliesTab']) {
    assert.ok(settings.includes(`<${t} />`), `${t} is imported but never rendered`); n++;
  }
  assert.match(settings, /tab === 'images'/, 'there is no Image Library tab'); n++;
  assert.match(settings, /tab === 'quick'/,  'there is no Quick Replies tab'); n++;

  // all=1 — without it the admin screen cannot see, and therefore cannot
  // re-enable, anything it has switched off.
  assert.match(imagesTab, /images\?all=1/,
    'the admin image screen does not ask for inactive rows; a disabled image would be invisible there'); n++;
  assert.match(imagesTab, /library-settings/,
    'the upload toggle is not on the images screen'); n++;
  assert.match(imagesTab, /allow_local_upload/,
    'the upload toggle does not save the setting'); n++;

  const qrTab = strip(read(path.join(FE, 'src/components/settings/WhatsAppQuickRepliesTab.jsx')));
  assert.match(qrTab, /quick-replies\?all=1/,
    'the admin quick-reply screen does not ask for inactive rows'); n++;
  // '' is not null. The column and the partial index both mean "no shortcut"
  // by NULL, and two rows saved with '' would collide under the index while
  // two NULLs do not.
  //
  // EVERY site is checked, not the first one found. The add form and the edit
  // form both build this field, and a match-anywhere assertion passes while
  // one of them is wrong — which is the shape this suite already let through
  // once.
  const sc = [...qrTab.matchAll(/\.shortcut\.trim\(\)\s*\|\|\s*([^,\n]+)/g)];
  assert.strictEqual(sc.length, 2,
    `expected the add form and the edit form to normalise the shortcut; found ${sc.length}`); n++;
  for (const m of sc) {
    assert.strictEqual(m[1].trim(), 'null',
      `a blank shortcut is sent as ${m[1].trim()} rather than null`); n++;
  }

  console.log(`walibrary: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
