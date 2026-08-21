#!/usr/bin/env node
'use strict';

/**
 * Does Interakt let us send a free-form IMAGE inside the 24-hour window?
 *
 * Interakt documents only `type: "Template"`. But this CRM already sends
 * `type: "Text"` free-form every day and that is not documented either — so an
 * image equivalent probably exists under a name nobody wrote down. This script
 * tries the plausible shapes and reports which one the API accepts.
 *
 * ── RUN IT LIKE THIS ────────────────────────────────────────────────────────
 *
 *   cd backend
 *   node interakt-image-probe.js 9876543210
 *
 * where 9876543210 is a 10-digit Indian mobile that has messaged your WhatsApp
 * number **within the last 24 hours**. That part is not optional: outside the
 * window WhatsApp refuses every free-form message regardless of type, and the
 * probe would report failure for the wrong reason.
 *
 * Use your own phone. Each accepted variant sends a real WhatsApp message.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 *   · Reads the API key from backend/.env. Never prints it, not even masked.
 *   · Sends AT MOST one message per variant, and stops at the first success.
 *   · Sends nothing until you confirm at the prompt.
 *   · Read-only against this codebase — it changes no files and touches no
 *     database.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API_URL = 'https://api.interakt.ai/v1/public/message/';

// A small public image with a stable URL. Deliberately not one of ours: if this
// fails, the question is whether Interakt ACCEPTS the payload, and a URL of our
// own that turns out to be unreachable would confuse "payload rejected" with
// "image could not be fetched" — the two failures that look alike here.
const TEST_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

// ── The API key, from backend/.env ──────────────────────────────────────────
function apiKey() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    die(`No .env found at ${envPath}. Run this from inside the backend/ folder.`);
  }
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .find(l => /^\s*INTERAKT_API_KEY\s*=/.test(l));
  if (!line) {
    die('INTERAKT_API_KEY is not in backend/.env.\n'
      + 'If you set the key from the CRM instead (Settings → WhatsApp → Connection),\n'
      + 'copy it into .env temporarily just for this test, then remove it.');
  }
  const key = line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  if (!key) die('INTERAKT_API_KEY is present but empty.');
  return key;
}

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

// ── The candidate payloads ──────────────────────────────────────────────────
//
// Ordered most-likely first. The first three mirror the shape of the `sendText`
// payload this codebase already uses successfully (utils/interakt.js:332) —
// `type` plus a `data` object — varying only the field names, because that is
// where an undocumented API is most likely to differ from a guess.
function variants(countryCode, phoneNumber) {
  const caption = 'Spinoto test — please ignore';
  const base = { countryCode, phoneNumber };
  return [
    { name: 'type:Image + data.mediaUrl',
      body: { ...base, type: 'Image', data: { mediaUrl: TEST_IMAGE, caption } } },

    { name: 'type:Image + data.url',
      body: { ...base, type: 'Image', data: { url: TEST_IMAGE, caption } } },

    { name: 'type:Media + data.mediaUrl + mediaType',
      body: { ...base, type: 'Media', data: { mediaUrl: TEST_IMAGE, mediaType: 'image', caption } } },

    { name: 'type:Image + top-level mediaUrl',
      body: { ...base, type: 'Image', mediaUrl: TEST_IMAGE, caption } },

    { name: 'type:Text + data.mediaUrl (media rides the known-good text shape)',
      body: { ...base, type: 'Text', data: { message: caption, mediaUrl: TEST_IMAGE } } },
  ];
}

async function attempt(key, variant) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(variant.body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — keep the raw text */ }

    // Interakt can answer HTTP 200 with result:false. This codebase already
    // treats that as a rejection (utils/interakt.js:278) and so does this.
    const ok = res.ok && json?.result !== false;
    return { ok, status: res.status, body: json ?? text.slice(0, 400) };
  } catch (err) {
    return { ok: false, status: 0, body: err.name === 'AbortError' ? 'timeout after 20s' : err.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const raw = (process.argv[2] || '').replace(/\D/g, '');
  const national = raw.length === 12 && raw.startsWith('91') ? raw.slice(2) : raw;
  if (national.length !== 10) {
    die('Pass a 10-digit Indian mobile:  node interakt-image-probe.js 9876543210');
  }

  const key = apiKey();
  const list = variants('+91', national);

  console.log(`\n  Sending to  +91 ${national}`);
  console.log(`  Variants    ${list.length} (stops at the first success)`);
  console.log(`\n  That number must have messaged your WhatsApp number in the last 24 hours,`);
  console.log(`  or every variant fails for the wrong reason.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const go = await new Promise(r => rl.question('  Send real WhatsApp messages now? (yes/no) ', a => { rl.close(); r(a); }));
  if (String(go).trim().toLowerCase() !== 'yes') { console.log('\n  Cancelled. Nothing sent.\n'); process.exit(0); }

  console.log('');
  for (const v of list) {
    process.stdout.write(`  → ${v.name}\n`);
    const r = await attempt(key, v);
    if (r.ok) {
      console.log(`\n  ✓ ACCEPTED — HTTP ${r.status}`);
      console.log(`    ${JSON.stringify(r.body)}\n`);
      console.log('  Check the phone. If the image actually arrived, free-form image');
      console.log('  sending works and NO template approval is needed.\n');
      console.log('  Working payload:\n');
      console.log(JSON.stringify(v.body, null, 2).split('\n').map(l => '    ' + l).join('\n'));
      console.log('');
      process.exit(0);
    }
    console.log(`    rejected — HTTP ${r.status} · ${JSON.stringify(r.body).slice(0, 200)}\n`);
  }

  console.log('  ✗ Every variant was rejected.\n');
  console.log('  That does not prove it is impossible — only that these five shapes are');
  console.log('  wrong. Ask Interakt support this exact question:\n');
  console.log('    "Can I send an image as a free-form (non-template) message inside the');
  console.log('     24-hour customer service window through the public message API? If');
  console.log('     yes, what is the exact JSON payload?"\n');
  console.log('  If they say no, the fallback is one image-header template, approved once');
  console.log('  and reused for every image.\n');
})();
