'use strict';

/**
 * interakt.js — the ONLY place this application talks to Interakt.
 *
 * Everything above it (the dispatcher, the outbox worker, the test-send button)
 * deals in "send this template to this number". This file is the one that knows
 * about `bodyValues` arrays, Basic auth and their error shapes — so swapping
 * Interakt for Meta Cloud API later is a rewrite of this file and nothing else.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 * sendTemplate() NEVER THROWS. It resolves a plain result object:
 *
 *   { ok: true,  providerMessageId }
 *   { ok: false, retryable, errorCode, errorMessage }
 *
 * Callers are the outbox worker and the test-send endpoint. Both need to record
 * a failure, not catch one — a throw here would either abort a queue run
 * partway through or surface a stack trace on an admin screen. Same discipline
 * as utils/sendPush.js, and for the same reason.
 *
 * `retryable` is the field that matters most. Most WhatsApp failures are
 * PERMANENT — the number is not on WhatsApp, the template was rejected, the
 * customer blocked the business — and retrying those burns attempts and money
 * to arrive at the same answer. Only transport-level problems are worth a
 * second go.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 *
 * With no INTERAKT_API_KEY set, every send returns ok:false rather than
 * pretending to succeed. A missing key must look like a queue full of visible
 * failures, not like a quiet system where nobody is receiving anything.
 */

const { CircuitBreaker } = require('./circuitBreaker');
const { toInteraktParts } = require('./phone');
const { getSetting } = require('../services/integrationSettings.service');

const API_URL = 'https://api.interakt.ai/v1/public/message/';

/**
 * The breaker exists because a slow Interakt must not become a slow Spinoto.
 *
 * Sends already happen off the request path in the outbox worker, so nothing
 * user-facing is waiting — but without a cap, a provider timing out at 30s
 * would let a queue run open unbounded parallel sockets and sit there. The
 * queue is not urgent; failing fast and retrying on the next tick is strictly
 * better than holding connections open.
 *
 * requestTimeoutMs is deliberately generous at 15s: a WhatsApp send is a real
 * network round trip to Meta via a BSP, not a local call, and timing out a send
 * that actually succeeded is the one failure mode that produces DUPLICATE
 * customer messages.
 */
const breaker = new CircuitBreaker('interakt', {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  resetTimeoutMs: 30_000,
  requestTimeoutMs: 15_000,
  maxConcurrent: 4,
});

function apiKey() {
  // DB-stored key (Settings → WhatsApp → Connection, migration 152) wins;
  // INTERAKT_API_KEY stays as the fallback so a deployment configured the old
  // way keeps working. getSetting is synchronous against an in-process cache —
  // see integrationSettings.service.js for why that matters here.
  return getSetting('interakt_api_key');
}

/** True when sends are possible at all. The registry UI uses this to explain itself. */
function isConfigured() {
  return apiKey().length > 0;
}

/**
 * Classify a failure into "try again later" vs "this will never work".
 *
 * The default is FALSE — an unrecognised failure is treated as permanent.
 * That is the safe default here: a wrongly-permanent message sits visible in
 * the log as a failure someone can retry by hand, whereas a wrongly-retryable
 * one quietly consumes attempts and may deliver the same message twice.
 */
function isRetryableStatus(status) {
  // No response at all — DNS, socket, timeout, breaker open.
  if (status === null || status === undefined) return true;
  // Their side.
  if (status >= 500) return true;
  // Rate limited: the request was fine, we just asked too fast.
  if (status === 429) return true;
  // Everything else in 4xx is us: bad key, unknown template, invalid number.
  return false;
}

/**
 * Send one approved template.
 *
 * @param {object}   p
 * @param {string}   p.to             Any format; normalised here, once.
 * @param {string}   p.templateName   Interakt CODE NAME, e.g. 'appointment_booked_'
 *                                    (trailing underscores are part of the name).
 * @param {string}   [p.languageCode] 'en' by default. 'en' and 'en_US' are
 *                                    different templates to Meta.
 * @param {string[]} [p.bodyValues]   POSITIONAL. Index maps to {{1}}, {{2}}, …
 * @param {string[]} [p.headerValues]
 * @param {object}   [p.buttonValues] { "0": ["suffix"] } for dynamic URL buttons.
 * @param {string}   [p.callbackData] Echoed back on the status webhook. We put
 *                                    the wa_messages id here so a callback can
 *                                    be matched even if the provider id write
 *                                    lost a race with the webhook.
 */
async function sendTemplate({
  to,
  templateName,
  languageCode = 'en',
  bodyValues = [],
  headerValues = [],
  buttonValues = null,
  callbackData = null,
}) {
  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      retryable: true, // a key can be added; the message is still worth keeping
      errorCode: 'NO_API_KEY',
      errorMessage: 'INTERAKT_API_KEY is not set — no messages can be sent.',
    };
  }

  if (!templateName) {
    return {
      ok: false, retryable: false, errorCode: 'NO_TEMPLATE',
      errorMessage: 'Template has no provider_template_name configured.',
    };
  }

  // One normalisation, here. Interakt upserts its contacts by phone number, so
  // '+919876543210' and '9876543210' would become two contacts each holding
  // half of one customer's conversation.
  const parts = toInteraktParts(to);
  if (!parts) {
    return {
      ok: false, retryable: false, errorCode: 'INVALID_NUMBER',
      errorMessage: `"${to}" is not a valid Indian mobile number.`,
    };
  }

  // Interakt rejects a null inside bodyValues, and an empty string renders as a
  // gap in the customer's message ("Date: " with nothing after it). Neither is
  // acceptable silently — the dispatcher is responsible for not queueing a
  // message whose variables could not all be resolved, and this is the
  // backstop that makes a slip loud rather than embarrassing.
  const missing = bodyValues.findIndex((v) => v === null || v === undefined || v === '');
  if (missing !== -1) {
    return {
      ok: false, retryable: false, errorCode: 'MISSING_VARIABLE',
      errorMessage: `Body variable at position ${missing + 1} is empty — refusing to send a message with a blank line.`,
    };
  }

  const payload = {
    countryCode: parts.countryCode,
    phoneNumber: parts.phoneNumber,
    type: 'Template',
    template: {
      name: templateName,
      languageCode,
      bodyValues: bodyValues.map(String),
      ...(headerValues.length ? { headerValues: headerValues.map(String) } : {}),
      ...(buttonValues ? { buttonValues } : {}),
    },
    ...(callbackData ? { callbackData: String(callbackData).slice(0, 512) } : {}),
  };

  let status = null;
  let body = null;

  // The breaker races a timer against the promise but does not cancel the
  // underlying work, so without this the socket would stay open after a
  // timeout while the concurrency counter had already been decremented — the
  // cap would then under-count real in-flight sockets.
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 20_000);

  try {
    await breaker.fire(async () => {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          // ALREADY base64 — Interakt hands out the encoded value. Encoding it
          // again here is the classic way this fails with a 401 that looks
          // exactly like a wrong key.
          Authorization: `Basic ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      status = res.status;
      body = await res.json().catch(() => null);

      // ONLY retryable statuses are thrown.
      //
      // The breaker counts every throw as a failure, and it is a module
      // singleton shared with the outbox worker. A 404 "template not found" is
      // the single most likely error here — the provider names and variable
      // orders are transcribed by hand and unverified until someone tests
      // them — so throwing on 4xx would mean an admin clicking "Send test"
      // five times on a typo'd template name trips the breaker and disables
      // ALL WhatsApp sending, process-wide, for 30 seconds.
      //
      // The breaker exists to stop a slow Interakt becoming a slow Spinoto.
      // Our own bad request is not that, and must not be counted as it.
      if (!res.ok && isRetryableStatus(res.status)) {
        const e = new Error(`Interakt responded ${res.status}`);
        e.status = res.status;
        throw e;
      }
    });
  } catch (err) {
    const s = err.status ?? status;

    // A timeout is NOT retried, despite looking like a transport failure.
    //
    // We do not know whether the send succeeded — the request may have reached
    // Meta and been delivered while we gave up waiting for the acknowledgement.
    // Retrying is the one path that sends a customer the same message twice,
    // and a duplicate "your service is complete" is worse than a message
    // sitting visibly failed for someone to resend by hand.
    const timedOut =
      err.name === 'CircuitBreakerTimeoutError' || err.name === 'AbortError';

    let errorCode;
    if (err.name === 'CircuitBreakerOpenError')      errorCode = 'BREAKER_OPEN';
    else if (err.name === 'CircuitBreakerBusyError') errorCode = 'BREAKER_BUSY';
    else if (timedOut)                               errorCode = 'TIMEOUT';
    else                                             errorCode = `HTTP_${s ?? 'NETWORK'}`;

    return {
      ok: false,
      retryable: timedOut ? false : isRetryableStatus(s),
      errorCode,
      // Their message when they gave one, ours otherwise. Stored on
      // wa_messages.error_message and shown to staff, so it needs to be
      // readable rather than a stringified object.
      errorMessage: timedOut
        ? 'Timed out waiting for Interakt. The message may or may not have been delivered — check before resending.'
        : (body?.message ||
           (typeof body?.error === 'string' ? body.error : null) ||
           err.message ||
           'Send failed.'),
    };
  } finally {
    clearTimeout(abortTimer);
  }

  // Reached with a non-ok status only when it was a PERMANENT one — those are
  // no longer thrown above, so that they never reach the breaker.
  if (status && (status < 200 || status >= 300)) {
    return {
      ok: false,
      retryable: false,
      errorCode: `HTTP_${status}`,
      errorMessage:
        body?.message ||
        (typeof body?.error === 'string' ? body.error : null) ||
        `Interakt rejected the request (${status}).`,
    };
  }

  // Interakt answers 200 with { result: true, id: "..." } on success — but has
  // also been seen returning 200 with result:false and a message. Treating a
  // 200 as success without checking would mark a message 'sent' that was never
  // accepted, and no status webhook would ever arrive to correct it.
  if (body && body.result === false) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'REJECTED',
      errorMessage: body.message || 'Interakt rejected the message.',
    };
  }

  return {
    ok: true,
    providerMessageId: body?.id || body?.messageId || null,
  };
}

/**
 * Send a FREE-FORM text message — a reply typed by an advisor in the CRM.
 *
 * ⚠️ THE ONLY UNVERIFIED PAYLOAD IN THIS FILE. Interakt's public resource
 * centre documents `type: "Template"` and nothing else; the text shape below is
 * the one their API consistently accepts in practice, but it is not something I
 * could confirm from their documentation the way every other field here was.
 * If replies come back rejected, the error from Interakt is returned verbatim
 * and logged — that message is the fastest route to the right shape.
 *
 * ── This is legal only inside the 24-hour window ─────────────────────────────
 *
 * Meta permits free-form text only within 24 hours of the customer's last
 * inbound message. Outside it, only approved templates may be sent. THIS
 * FUNCTION DOES NOT CHECK THAT — wa_conversations.window_expires_at is the
 * record and the caller owns the decision, because the caller is also the one
 * that can offer the advisor a template instead.
 *
 * Everything else is deliberately identical to sendTemplate: the same breaker,
 * the same 20-second abort, the same retryable/permanent split, the same
 * result:false trap. A second sending path with its own error handling is how
 * the two drift.
 */
async function sendText({ to, message, callbackData = null }) {
  const key = apiKey();
  if (!key) {
    return { ok: false, retryable: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Interakt API key is not configured.' };
  }

  const parts = toInteraktParts(to);
  if (!parts) {
    return { ok: false, retryable: false, errorCode: 'BAD_NUMBER', errorMessage: `Not a messageable number: ${to}` };
  }

  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return { ok: false, retryable: false, errorCode: 'EMPTY_MESSAGE', errorMessage: 'Refusing to send an empty message.' };
  }

  return postFreeForm({
    key,
    label: 'text',
    payload: {
      countryCode: parts.countryCode,
      phoneNumber: parts.phoneNumber,
      type: 'Text',
      data: { message: text },
      ...(callbackData ? { callbackData: String(callbackData).slice(0, 512) } : {}),
    },
  });
}

/**
 * Send a PHOTO free-form — an advisor attaching an image to a reply.
 *
 * ⚠️ UNVERIFIED, for the same reason sendText is: Interakt documents only
 * `type: "Template"`. sendText proves an undocumented free-form shape exists
 * and works, so a media equivalent is very likely; MEDIA_PAYLOAD below is the
 * best candidate. `backend/interakt-image-probe.js` settles which shape the API
 * actually accepts, and swapping to the answer is a change to ONE function.
 *
 * ── The URL must be reachable from the public internet ──────────────────────
 *
 * We do not upload bytes to Interakt. We hand them a URL and WhatsApp fetches
 * it. That has one consequence worth stating plainly, because it is the thing
 * that will break in staging: a relative path such as `/uploads/wa/x.jpg` —
 * what this codebase's disk-storage fallback produces — is not fetchable by
 * anybody but us, and the send fails with an error that blames the image
 * rather than the configuration. ImageKit's CDN URL is the supported input;
 * the caller is responsible for producing one.
 *
 * ── Legal only inside the 24-hour window ────────────────────────────────────
 *
 * Same rule as text, and same division of responsibility: this function does
 * NOT check the window. wa_conversations.window_expires_at is the record and
 * the caller owns the decision, because the caller is the one that can offer a
 * template instead.
 */
async function sendMedia({ to, mediaUrl, caption = null, callbackData = null }) {
  const key = apiKey();
  if (!key) {
    return { ok: false, retryable: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Interakt API key is not configured.' };
  }

  const parts = toInteraktParts(to);
  if (!parts) {
    return { ok: false, retryable: false, errorCode: 'BAD_NUMBER', errorMessage: `Not a messageable number: ${to}` };
  }

  // Checked here as well as at the endpoint. WhatsApp fetches this URL from
  // its own servers, so anything that is not an absolute http(s) address is a
  // guaranteed failure — and catching it before the call turns a confusing
  // provider rejection into a sentence naming the real problem.
  const url = typeof mediaUrl === 'string' ? mediaUrl.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return {
      ok: false, retryable: false, errorCode: 'BAD_MEDIA_URL',
      errorMessage: 'The image must be at a public https:// address before it can be sent.',
    };
  }

  const text = typeof caption === 'string' ? caption.trim() : '';

  return postFreeForm({
    key,
    label: 'media',
    payload: {
      countryCode: parts.countryCode,
      phoneNumber: parts.phoneNumber,
      type: 'Image',
      data: {
        mediaUrl: url,
        // Omitted rather than sent empty. An empty caption key is the kind of
        // field a strict validator rejects outright, and there is no reason to
        // find out the hard way.
        ...(text ? { caption: text } : {}),
      },
      ...(callbackData ? { callbackData: String(callbackData).slice(0, 512) } : {}),
    },
  });
}

/**
 * POST a free-form payload and turn the answer into this module's result shape.
 *
 * Extracted so sendText and sendMedia cannot drift. That is not tidiness for
 * its own sake — sendText's own header already warns that "a second sending
 * path with its own error handling is how the two drift", and adding a second
 * free-form sender is exactly the moment that would have happened. The breaker,
 * the 20-second abort, the retryable/permanent split and the
 * HTTP-200-with-result:false trap now have one implementation.
 *
 * `label` appears in the two console.error lines and nowhere else. It is what
 * makes a rejection say which shape was refused, which is the whole diagnostic
 * value of an unverified payload.
 */
async function postFreeForm({ key, payload, label }) {
  let status = null;
  let body = null;
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 20_000);

  try {
    await breaker.fire(async () => {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
      if (!res.ok && isRetryableStatus(res.status)) {
        const e = new Error(`Interakt responded ${res.status}`);
        e.status = res.status;
        throw e;
      }
    });
  } catch (err) {
    const s = err.status ?? status;
    const timedOut = err.name === 'CircuitBreakerTimeoutError' || err.name === 'AbortError';
    let errorCode;
    if (err.name === 'CircuitBreakerOpenError')      errorCode = 'BREAKER_OPEN';
    else if (err.name === 'CircuitBreakerBusyError') errorCode = 'BREAKER_BUSY';
    else if (timedOut)                               errorCode = 'TIMEOUT';
    else                                             errorCode = `HTTP_${s ?? 'NETWORK'}`;
    return {
      ok: false,
      retryable: timedOut ? false : isRetryableStatus(s),
      errorCode,
      errorMessage: timedOut
        ? 'Timed out waiting for Interakt. The reply may or may not have been delivered — check before resending.'
        : (body?.message || (typeof body?.error === 'string' ? body.error : null) || err.message || 'Send failed.'),
    };
  } finally {
    clearTimeout(abortTimer);
  }

  if (status && (status < 200 || status >= 300)) {
    // Printed in full because these are the unverified paths: if Interakt wants
    // a different body shape, THIS line is where it says so.
    console.error(`[interakt:${label}] rejected`, status, JSON.stringify(body || {}).slice(0, 500));
    return {
      ok: false,
      retryable: false,
      errorCode: `HTTP_${status}`,
      errorMessage: body?.message || (typeof body?.error === 'string' ? body.error : null) || `Interakt rejected the reply (${status}).`,
    };
  }

  if (body && body.result === false) {
    console.error(`[interakt:${label}] result:false`, JSON.stringify(body).slice(0, 500));
    return { ok: false, retryable: false, errorCode: 'REJECTED', errorMessage: body.message || 'Interakt rejected the reply.' };
  }

  return { ok: true, providerMessageId: body?.id || body?.messageId || null };
}

module.exports = { sendTemplate, sendText, sendMedia, isConfigured, _breaker: breaker };
