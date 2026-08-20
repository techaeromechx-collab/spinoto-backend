#!/usr/bin/env node
'use strict';

/**
 * Pretend a customer just sent you a WhatsApp message.
 *
 * Posts a correctly-signed `message_received` webhook at your LOCAL backend, in
 * exactly the shape Interakt sends. Everything downstream is the real code:
 * signature check, lead matching, lead creation, the conversation row, the
 * 24-hour window.
 *
 * The only thing this does NOT test is Interakt actually reaching your machine
 * — for that you need the tunnel (Option B).
 *
 *   node fake-inbound.js 9724190308 "Hi, what is the price for a service?"
 *   node fake-inbound.js 9724190308 "Hello" --name "Rajeev Mundra"
 *   node fake-inbound.js 9724190308 --photo
 *
 * The secret must match Settings → WhatsApp → Connection (or
 * INTERAKT_WEBHOOK_SECRET in the backend .env). Pass it with --secret, or set
 * it in your shell as INTERAKT_WEBHOOK_SECRET.
 */

const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};

const positional = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--photo'));

const number = positional[0];
const text   = positional[1] || 'Hi, I want to know the price of your service.';
const name   = flag('name', null);
const photo  = args.includes('--photo');
const secret = flag('secret', process.env.INTERAKT_WEBHOOK_SECRET);
const url    = flag('url', 'http://localhost:4000/api/whatsapp/webhook');

if (!number) {
  console.error('Usage: node fake-inbound.js <mobile> "<message>" [--name "Full Name"] [--photo]');
  console.error('                            [--secret <webhook secret>] [--url <webhook url>]');
  process.exit(1);
}
if (!secret) {
  console.error('No webhook secret. Pass --secret "<value>" or set INTERAKT_WEBHOOK_SECRET.');
  console.error('It must match Settings → WhatsApp → Connection in the CRM.');
  process.exit(1);
}

// Interakt sends the number WITHOUT a leading '+', country code included.
const digits = String(number).replace(/\D/g, '');
const channelPhone = digits.length === 10 ? `91${digits}` : digits;

// A different id every run, so the replay guard does not swallow your test.
const messageId = `wamid.test.${Date.now()}`;

const payload = {
  version: '1.0',
  timestamp: new Date().toISOString(),
  type: 'message_received',
  data: {
    customer: {
      id: 'test-customer-uuid',
      channel_phone_number: channelPhone,
      traits: name ? { name } : {},
    },
    message: {
      id: messageId,
      chat_message_type: 'CustomerMessage',
      message_content_type: photo ? 'Image' : 'Text',
      message: photo ? null : text,
      media_url: photo ? 'https://example.test/photo.jpg' : null,
      received_at_utc: new Date().toISOString(),
      message_status: 'Sent',
      is_template_message: false,
      meta_data: {},
    },
  },
};

// Signed over the EXACT bytes sent — the backend verifies against req.rawBody,
// so re-serialising anywhere in between would fail the check.
const raw = Buffer.from(JSON.stringify(payload));
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

(async () => {
  console.log(`→ ${url}`);
  console.log(`  from  ${channelPhone}${name ? `  (${name})` : ''}`);
  console.log(`  says  ${photo ? '[a photo]' : JSON.stringify(text)}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Interakt-Signature': signature },
      body: raw,
    });
  } catch (e) {
    console.error(`\n✗ Could not reach the backend: ${e.message}`);
    console.error('  Is it running on port 4000?');
    process.exit(1);
  }

  const body = await res.text();
  console.log(`\n← ${res.status} ${body}`);

  if (res.status === 401) {
    console.error('\n✗ Signature rejected — the secret here does not match the one the backend has.');
    console.error('  Check Settings → WhatsApp → Connection, or INTERAKT_WEBHOOK_SECRET in backend/.env');
  } else if (res.status === 200 && body.includes('ignored')) {
    console.error('\n✗ The backend has NO webhook secret configured, so it accepted and DISCARDED this.');
    console.error('  Set it in Settings → WhatsApp → Connection first.');
  } else if (res.status === 200) {
    console.log('\n✓ Accepted. The backend processes it right after replying, so give it a second,');
    console.log('  then watch the backend log for:  [whatsapp:inbound] created lead #N …');
    console.log('  and refresh Leads → the WhatsApp chip.');
  }
})();
