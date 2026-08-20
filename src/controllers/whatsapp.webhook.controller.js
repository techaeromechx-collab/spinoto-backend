'use strict';

/**
 * POST /api/whatsapp/webhook — Interakt's delivery-status and inbound feed.
 *
 * ── The operational constraint that shapes this whole file ───────────────────
 *
 * Interakt's documented rules:
 *
 *   • Respond 200 within 3 SECONDS.
 *   • There are NO RETRIES for failed webhooks.
 *   • 5 failures within 10 minutes DISABLES the webhook, permanently, until a
 *     human re-enables it in the dashboard — and events that fired while it was
 *     disabled are never re-sent.
 *
 * So a slow database does not merely delay a status update: five slow requests
 * in ten minutes silently switch off delivery tracking for the whole business,
 * with an email nobody reads as the only signal.
 *
 * That inverts the usual instinct. **This handler acknowledges FIRST and does
 * every database write afterwards, outside the request.** Losing an event to a
 * process crash costs one stale status. Getting the webhook disabled costs all
 * of them, silently, until someone notices.
 *
 * ── Correlation ──────────────────────────────────────────────────────────────
 *
 * Matched on `callback_data`, which the outbox worker sets to the wa_messages
 * row id — NOT on the provider's message id.
 *
 * Interakt's documentation never actually states that the id in the webhook
 * equals the id returned by the send API. It probably does. But
 * provider_message_id is also written AFTER the send returns, so an early
 * 'Sent' webhook can arrive before that write lands and find nothing.
 * callback_data is in our control, present from the first event, and cannot
 * race.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const { toE164 } = require('../utils/phone');
const { getSetting } = require('../services/integrationSettings.service');
const {
  resolveOrCreateLead, nameFromBody, bodyFor,
} = require('../services/waInboundLead.service');
const { routeInbound } = require('../services/waRouting.service');
const { getIO }   = require('../socket');
const { sendPush } = require('../utils/sendPush');

/** Interakt's status strings are title-case. Ours are lowercase. */
const STATUS_MAP = Object.freeze({
  Sent: 'sent',
  Delivered: 'delivered',
  Read: 'read',
  Failed: 'failed',
});

/**
 * The ladder. A higher rank may overwrite a lower one; never the reverse.
 *
 * Interakt makes no ordering guarantee, and 'Read' before 'Delivered' is
 * routine. Without this, a message the customer has already read would display
 * as merely delivered because the later-arriving-but-earlier-in-life event won.
 *
 * `failed` sits at 1, BELOW delivered — deliberately, and this is the
 * interesting one.
 *
 * A send that times out is recorded 'failed' by the worker, because we cannot
 * know whether it arrived (see interakt.js). If it DID arrive, Interakt sends
 * Delivered and Read for it. Ranking failed alongside read would drop both, the
 * row would stay failed forever, and staff would resend a message the customer
 * already has — the exact duplicate the timeout handling refuses to risk.
 * Ranking it below delivered lets the webhook resolve that ambiguity by itself,
 * which is the only thing that can.
 */
// Spaced by tens so a state can be inserted between two without renumbering.
//
// failed sits ABOVE sent and BELOW delivered, and both halves matter:
//
//   sent → failed     MUST be allowed. Interakt accepts a send (2xx) and only
//                     then discovers the number is not on WhatsApp. It reports
//                     the failure by webhook. With failed tied to sent — as it
//                     was — that update was dropped: the row kept status 'sent'
//                     while error_code and failed_at filled in, so the screen
//                     showed a green tick on a message nobody received. Worse,
//                     retryMessage requires status 'failed', so the advisor was
//                     told "only a failed message can be retried" about a
//                     message that had failed.
//
//   failed → delivered MUST also be allowed. A send that times out is recorded
//                     failed because we cannot know whether it arrived. If it
//                     DID, Interakt sends Delivered and Read for it, and those
//                     resolve the ambiguity. Ranking failed above delivered
//                     would freeze the row and staff would resend a message the
//                     customer already has.
//
//   delivered → failed is correctly blocked by the same ordering.
const RANK = Object.freeze({ queued: 0, sent: 10, failed: 15, delivered: 20, read: 30 });

const TIMESTAMP_COL = Object.freeze({
  sent: 'sent_at',
  delivered: 'delivered_at',
  read: 'read_at',
  failed: 'failed_at',
});

/**
 * Constant-time signature check.
 *
 * `Interakt-Signature: sha256=<hex>`, HMAC-SHA256 of the raw body with the
 * secret configured beside the webhook URL in their dashboard.
 */
function verifySignature(req) {
  // DB-stored secret (Settings → WhatsApp → Connection) wins; the env var is
  // the fallback. Synchronous read from the in-process cache — this check runs
  // inside Interakt's 3-second ack budget, where a DB round trip is exactly
  // what the ack-first design exists to avoid.
  const secret = getSetting('interakt_webhook_secret');
  if (!secret) return { ok: false, reason: 'no_secret_configured' };

  const header = (req.get('Interakt-Signature') || '').toLowerCase();
  if (!header.startsWith('sha256=')) return { ok: false, reason: 'malformed_header' };

  // The bytes as received. See the express.json verify hook in server.js —
  // re-serialising the parsed object produces different bytes and fails.
  const raw = req.rawBody;
  if (!raw) return { ok: false, reason: 'no_raw_body' };

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

  // Lengths first: timingSafeEqual throws on a mismatch, and a plain === would
  // leak the signature a byte at a time to anyone patient.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok && process.env.NODE_ENV !== 'production') {
    // Development only. A signature mismatch is otherwise indistinguishable
    // from "the webhook silently stopped working", and the two most common
    // causes — the secret differing between here and the Interakt dashboard,
    // and the body being altered in transit — look identical from the outside.
    //
    // Never logs the secret. The signature is a hash and safe to print; if the
    // received and expected values differ, the secret is wrong. If they match
    // but this still fails, the raw body is being modified somewhere.
    console.warn('[whatsapp:webhook] signature mismatch');
    console.warn('  received:', header);
    console.warn('  expected:', expected);
    console.warn('  secret length:', secret.length, '(not the value)');
    console.warn('  raw body bytes:', raw.length);
    console.warn('  raw body starts:', raw.toString('utf8').slice(0, 80));
  }

  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Advance an OUTBOUND message's status, never backwards.
 *
 * Two writes, not one. The timestamps and the provider id are recorded
 * unconditionally; only `status` is gated by the ladder.
 *
 * A single gated statement loses data: on the routine Read-then-Delivered
 * ordering the whole UPDATE is skipped, so `delivered_at` stays NULL forever
 * even though Interakt told us exactly when delivery happened. The status must
 * not move backwards; the facts should still be kept.
 */
async function applyStatus(messageId, nextStatus, msg) {
  const col = TIMESTAMP_COL[nextStatus];
  const rank = RANK[nextStatus];
  // Belt and braces: col is derived from a frozen map keyed by a value that has
  // already passed a hasOwnProperty check, so it cannot be attacker-chosen —
  // but it IS interpolated into SQL, so it is asserted rather than assumed.
  if (typeof col !== 'string' || !Object.values(TIMESTAMP_COL).includes(col)) {
    return false;
  }

  const r = await pool.query(
    `UPDATE wa_messages
        SET ${col} = COALESCE(${col}, NOW()),
            provider_message_id = COALESCE(provider_message_id, $3),
            error_code    = COALESCE($4, error_code),
            error_message = COALESCE($5, error_message),
            status = CASE
              -- Must stay in step with RANK above. Written out rather than
              -- passed as a parameter because the comparison happens inside a
              -- CASE the planner can use, and a mismatch between the two is
              -- the kind of bug that shows up as a green tick on an
              -- undelivered message.
              WHEN CASE status
                     WHEN 'queued'    THEN 0
                     WHEN 'sent'      THEN 10
                     WHEN 'failed'    THEN 15
                     WHEN 'delivered' THEN 20
                     WHEN 'read'      THEN 30
                     ELSE 99
                   END < $6
              THEN $2
              ELSE status
            END,
            next_retry_at = NULL
      WHERE id = $1
        -- Outbound only. callback_data is attacker-influenceable in principle,
        -- and without this an event could rewrite a CUSTOMER'S OWN inbound
        -- message — flipping its status and stamping our error codes onto it.
        -- 'received' also has no arm in the ladder above, so it would fall to
        -- the ELSE and be treated as the most overwritable state of all.
        AND direction = 'out'
      RETURNING id, status`,
    [
      messageId,
      nextStatus,
      msg.id || null,
      msg.channel_error_code || null,
      msg.channel_failure_reason || null,
      rank,
    ]
  );
  return r.rowCount > 0;
}

/**
 * Record an inbound customer reply.
 *
 * v1 stores it and refreshes the 24-hour window. Routing a notification to the
 * right staff member is stage 8 — but the row and the window have to exist
 * before that can be built, and given there are no retries, an inbound message
 * that was not stored is gone for good.
  *
 * @returns {Promise<string|null>} null when the reply was stored; a short
 *   reason when it was dropped, which the caller writes to
 *   wa_events.process_error so a dropped reply is discoverable.
 */
async function applyInbound(payload) {
  const cust = payload?.data?.customer || {};
  const msg = payload?.data?.message || {};

  // toE164, not a hand-rolled '+' + digits.
  //
  // Interakt may send the number in national form. Prefixing that with '+'
  // yields '+9876543210', which matches no wa_messages.to_number and creates a
  // wa_conversations row nothing will ever look up — the 24-hour window
  // recorded against a key that joins to nothing, failing completely silently.
  // Both migrations say in as many words that this must be the same
  // normalisation as everywhere else.
  const e164 = toE164(cust.channel_phone_number);
  if (!e164) {
    // Was a bare `return`: no row, no log, and markProcessed(null) below
    // recording the event as processed with no error — indistinguishable from
    // success. This file's own header says an inbound message that was not
    // stored is gone for good, because there are no retries.
    //
    // toE164 is India-only by design (utils/phone.js). So an NRI customer
    // replying from a +971 number produced no wa_messages row, no
    // wa_conversations 24-hour window, and no trace that they had replied at
    // all. Naming it is the whole fix — the number still cannot be stored, but
    // now somebody can find out why.
    console.warn(
      `[whatsapp:inbound] dropped a reply from an unparseable number: ` +
      `${String(cust.channel_phone_number || '').slice(0, 4)}…  ` +
      `(toE164 accepts Indian mobiles only)`
    );
    return 'unparseable_sender_number';
  }

  // A photo or voice note has no `message` at all. bodyFor turns that into
  // "📷 Photo" rather than NULL, so the conversation shows that the customer
  // sent something instead of an unexplained gap.
  const body = bodyFor(msg);

  // traits.name is the WhatsApp profile name — often absent, sometimes an
  // emoji. A form-fill message carries the real one in its body ("Full name:
  // Rajeev Mundra"), which is exactly the case that would otherwise produce a
  // lead named after a phone number.
  const name = (typeof cust.traits?.name === 'string' && cust.traits.name.trim())
    ? cust.traits.name.trim()
    : nameFromBody(body);

  // Filled in below, used AFTER the connection is handed back. Routing opens a
  // second connection of its own, and doing that while still holding this one
  // would let a burst of inbound messages take every connection in the pool and
  // then each wait for another — a deadlock that only appears under load.
  let routeAfter = null;
  let result = null;

  const client = await pool.connect();
  try {
    // One transaction. A stored reply with no window recorded is precisely the
    // state this function exists to prevent — and now also: a lead created
    // without its first message, or a message attached to a lead that rolled
    // back.
    await client.query('BEGIN');

    // ── The conversation row FIRST, and this order is load-bearing ──────────
    //
    // mobile is UNIQUE (migration 113). Two messages from the same NEW number
    // arriving together both reach this statement; the second one blocks on
    // that unique index until the first commits, and then reads the lead_id the
    // first wrote. Without this ordering both would look up "is there a lead?",
    // both would see no, and both would create one.
    await client.query(
      `INSERT INTO wa_conversations
         (mobile, last_inbound_at, window_expires_at, last_message_at, customer_name)
       VALUES ($1, NOW(), NOW() + INTERVAL '24 hours', NOW(), $2)
       ON CONFLICT (mobile) DO UPDATE
          SET last_inbound_at   = NOW(),
              window_expires_at = NOW() + INTERVAL '24 hours',
              last_message_at   = NOW(),
              customer_name     = COALESCE(wa_conversations.customer_name, EXCLUDED.customer_name)`,
      [e164, name || null]
    );

    // Who this belongs to: an existing lead, an existing customer, or a new
    // lead. See services/waInboundLead.service.js — the rule lives there
    // because the reply endpoint and the next automation stage need the same
    // answer, and a rule with two copies becomes two rules.
    const target = await resolveOrCreateLead(client, {
      e164,
      name,
      firstMessage: body,
    });

    // Bot messages that landed before this number had a lead.
    //
    // workflow_response_update can arrive before the customer's own message —
    // the flow greets them first, and the greeting is what they are replying
    // TO. Those rows were stored with no entity because there was nothing to
    // point at yet. There is now.
    //
    // The thread reads by number so they were always visible; this is so that
    // anything asking "what is on lead #203" gets the same answer as the panel.
    if (target.leadId) {
      await client.query(
        `UPDATE wa_messages
            SET entity_type = 'lead', entity_id = $2
          WHERE to_number = $1 AND origin = 'bot' AND entity_id IS NULL`,
        [e164, target.leadId]
      );
    }

    const ins = await client.query(
      `INSERT INTO wa_messages
         (direction, to_number, body_rendered, status, provider_message_id,
          entity_type, entity_id, created_at)
       VALUES ('in', $1, $2, 'received', $3, $4, $5, NOW())
       -- Idempotency. The signature covers the body but carries no timestamp or
       -- nonce, so a captured webhook can be replayed indefinitely; without
       -- this that is an unbounded insert primitive, and every replay would
       -- also re-extend the free-form window by another 24 hours.
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [e164, body, msg.id || null, target.entityType, target.entityId]
    );

    await client.query('COMMIT');

    // Worth a line in the log. "Where did this lead come from?" and "why didn't
    // that message show up on the lead?" are both answered here, and neither is
    // answerable from the wa_messages row alone.
    if (target.createdLead) {
      // The classification is on the line because it is the thing worth
      // noticing. "created lead #204" reads as routine; "created lead #204
      // (repeat customer → Repeat Customer)" is somebody who has already paid
      // you getting back in touch, and it should be legible without opening
      // the CRM.
      const kind = target.returning
        ? ` [${target.returning}${target.status ? ` → ${target.status}` : ' → New Lead'}]`
        : '';
      console.log(`[whatsapp:inbound] created lead #${target.leadId} from ${e164}${name ? ` (${name})` : ' (no name)'}${kind}`);
    }

    // ── Who owns it ──────────────────────────────────────────────────────
    //
    // Deferred to after this connection is released, but decided here.
    //
    // This is the fix for the bug that made every free-text lead an orphan.
    // Routing used to live ONLY in applyWorkflow, so a lead was only ever given
    // an owner if the Interakt flow ran. A customer who typed "Interested" and
    // tapped nothing produced no workflow event at all, so nothing ever looked
    // at their lead — not the rota, not continuity, not even the "one person
    // handles every WhatsApp lead" switch, which lives inside the function that
    // was never called.
    //
    // No answers to pass: there are none yet, and there may never be. What that
    // leaves is rules 0, 1 and 3 — the all-leads owner, the advisor this
    // customer already has, and the fallback owner. All three work without the
    // customer tapping anything, and all three were unreachable from here.
    //
    // Set for a replayed message too. routeInbound is idempotent, and a webhook
    // whose first delivery crashed after COMMIT is exactly the case where the
    // retry needs to finish the job.
    if (target.leadId) routeAfter = { leadId: target.leadId, e164, answers: [] };

    // Not an error — the replay guard did its job. Explicit either way, so the
    // contract is one line rather than an absence: null means stored, a string
    // means dropped and says why.
    result = ins.rowCount === 0 ? 'duplicate_inbound' : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (routeAfter) await routeConversation(routeAfter);

  // ── Tell somebody ────────────────────────────────────────────────────────
  //
  // AFTER routing, deliberately: routing is what decides who this belongs to,
  // and a notification sent a moment earlier would go to whoever owned it
  // before — often nobody.
  //
  // Skipped for a replay. The message was already announced the first time, and
  // a webhook Interakt retries four times should not buzz somebody's phone four
  // times.
  if (result !== 'duplicate_inbound') {
    await announceInbound({ e164, body, name });
  }

  return result;
}

/**
 * The WhatsApp badge lighting up, and the phone buzzing.
 *
 * ── Two channels, because they cover different moments ──────────────────────
 *
 *   socket   the app is open. A contentless nudge; the client refetches its own
 *            count over its own authenticated connection, and if the number
 *            went UP it plays the sound and raises a toast.
 *   push     the app is not open. Web push reaches a closed browser; the
 *            desktop build cannot receive it (WebView2 has no PushManager), so
 *            there the socket path is the only one — which is fine, because a
 *            closed .exe has nothing listening either way.
 *
 * ── Why the socket carries no message text ──────────────────────────────────
 *
 * socket.js says it plainly: the connection is NOT authenticated, because
 * everything it has ever carried is an "invalidate, go refetch" nudge. Putting
 * a customer's words on it would quietly turn a broadcast channel into a data
 * channel, and every browser pointed at the server would receive every
 * customer's messages.
 *
 * So the event says only that the inbox changed. Who it was for is worked out
 * client-side, by each client asking its own authenticated endpoint whether ITS
 * count went up. A client the message was not for sees no change and does
 * nothing.
 *
 * Nothing in here is allowed to throw. A notification that fails is a nuisance;
 * a webhook that 500s because a notification failed loses the message.
 */
async function announceInbound({ e164, body, name }) {
  try {
    // Contentless. Every open client refetches its own count; the ones it was
    // not for see the same number and stay quiet.
    getIO().emit('invalidate', { topic: 'wa_inbox' });
  } catch (err) {
    console.error('[whatsapp:notify] socket nudge failed:', err.message);
  }

  try {
    // COALESCE, and it is not cosmetic. WhatsApp routing writes both columns;
    // assigning a lead BY HAND writes only leads.assigned_to and never touches
    // the conversation. Reading assigned_user_id alone meant every manually
    // assigned lead notified NOBODY — the advisor whose name was on the lead
    // got no push at all, and the only symptom was a customer waiting.
    const owner = await pool.query(
      `SELECT COALESCE(c.assigned_user_id, l.assigned_to) AS user_id, c.lead_id,
              COALESCE(NULLIF(TRIM(l.name), ''), NULLIF(TRIM(c.customer_name), ''), c.mobile) AS who
         FROM wa_conversations c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.mobile = $1`,
      [e164]
    );
    const userId = owner.rows[0]?.user_id || null;

    // Nobody assigned means the unassigned queue. The BADGE still shows it to
    // everyone — the queue is in scope for every user — but a push goes to one
    // person by definition, and picking one at random to buzz would be handing
    // out an assignment through a notification.
    if (!userId) return;

    const who = owner.rows[0].who || name || e164;
    const preview = (body || '').replace(/\s+/g, ' ').trim().slice(0, 120);

    await sendPush(
      userId,
      'lead_assigned',
      `WhatsApp from ${who}`,
      preview || 'Sent a message',
      owner.rows[0].lead_id ? '/leads' : '/'
    );
  } catch (err) {
    console.error('[whatsapp:notify] push failed:', err.message);
  }
}

/**
 * The workflow's own messages — the third voice in the conversation.
 *
 * Interakt's Advanced Workflow greets the customer, asks questions and offers
 * buttons. None of that used to reach the CRM, so an advisor opening the lead
 * saw only the answers:
 *
 *     Support/Help
 *     Other
 *     Hi
 *
 * which reads as a customer typing nonsense rather than someone answering
 * precisely what they were asked.
 *
 * ── Only the QUESTION side is stored ────────────────────────────────────────
 *
 * Each entry is a { question, answer } pair. The answer already arrives on its
 * own as message_received — it is where the raw list_reply JSON came from — so
 * inserting it here too would double every customer message in the thread.
 *
 * ── This event is CUMULATIVE ────────────────────────────────────────────────
 *
 * Every tap re-sends the whole conversation from step one; one observed event
 * carried three exchanges spanning six hours. The unique index from migration
 * 157 on question.id is what stops that becoming fifteen copies of the
 * greeting, and ON CONFLICT DO NOTHING below is the other half of it.
 *
 * ── It must not touch the 24-hour window ────────────────────────────────────
 *
 * No wa_conversations upsert here. The window opens when the CUSTOMER writes,
 * and a bot greeting extending it would have the CRM offering a free-text reply
 * box for a conversation WhatsApp will refuse to deliver into.
 */
function botBody(q) {
  const parts = [];

  if (typeof q.message === 'string' && q.message.trim()) parts.push(q.message.trim());

  // The choices the customer was given. Without them, an answer of "Other" in
  // the thread is unreadable — other than what? Buttons and list rows are the
  // same idea wearing two different field names.
  const options = [
    ...(Array.isArray(q.buttons) ? q.buttons.map(b => (b && b.reply ? b.reply.title : b && b.title)) : []),
    ...(Array.isArray(q.list_message_buttons) ? q.list_message_buttons.map(b => b && b.title) : []),
  ].map(t => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);

  if (options.length) parts.push(`[ ${options.join(' · ')} ]`);

  // Media is not stored, but a step that was an image and nothing else would
  // otherwise vanish from the thread entirely.
  if (Array.isArray(q.media_urls) && q.media_urls.length) parts.push('📷 (image)');

  return parts.length ? parts.join('\n\n') : null;
}

async function applyWorkflow(payload) {
  const d = payload && payload.data ? payload.data : {};
  const steps = Array.isArray(d.data) ? d.data : [];
  if (!steps.length) return 'workflow_no_steps';

  const e164 = toE164(d.customer_number);
  if (!e164) return 'workflow_bad_number';

  // Whatever lead the conversation already resolved to. Deliberately NOT
  // resolveOrCreateLead: a bot greeting is not an enquiry, and creating a lead
  // from one would put every passer-by who opened the chat and left straight
  // into the pipeline. The customer's own message creates the lead; this files
  // alongside it. Null until then, which the thread handles — it reads by
  // number, not by entity.
  const conv = await pool.query(
    `SELECT lead_id FROM wa_conversations WHERE mobile = $1`, [e164]);
  const leadId = (conv.rows[0] && conv.rows[0].lead_id) || null;

  let stored = 0;
  for (const step of steps) {
    const q = step && step.question;
    if (!q || !q.id) continue;

    const body = botBody(q);
    if (!body) continue;

    // created_at drives the thread's ordering, so it must be the moment the bot
    // actually spoke. Using NOW() would pile the whole flow at the bottom of the
    // conversation in whatever order the re-send happened to arrive.
    //
    // The 'Z' is load-bearing: Interakt sends '2026-08-19T04:13:47.226000' with
    // no zone, and new Date() on that reads it as LOCAL time — which in IST
    // would file every bot message five and a half hours early, before the
    // customer message it was answering.
    const at = q.created_at_utc ? new Date(`${q.created_at_utc}Z`) : new Date();

    const r = await pool.query(
      `INSERT INTO wa_messages
         (direction, origin, to_number, body_rendered, status, provider_message_id,
          entity_type, entity_id, created_at, sent_at)
       VALUES ('out', 'bot', $1, $2, 'sent', $3, $4, $5, $6, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [e164, body, String(q.id), leadId ? 'lead' : null, leadId, at]
    );
    stored += r.rowCount;
  }

  if (stored) {
    console.log(`[whatsapp:workflow] stored ${stored} bot message(s) for ${e164}` +
                `${leadId ? ` on lead #${leadId}` : ' (no lead yet)'}`);
  }

  // ── Who owns this customer ───────────────────────────────────────────────
  //
  // Done HERE and not in applyInbound because this is the event that carries
  // the answer routing needs. The customer's first message creates the lead;
  // their first ANSWER — Bike/Scooter, Car, Support/Help — is what says who
  // should get it, and that arrives a step later.
  //
  // So a lead is briefly unassigned by design, not by accident. It sits in the
  // shared queue for those seconds, which is the correct place for a lead
  // nobody has been given yet.
  //
  // Its own transaction: routing must not be able to roll back the messages
  // above. A conversation stored with nobody assigned is a queue item. A
  // conversation not stored at all is a lost customer.
  if (leadId) {
    const answers = steps
      .map(s2 => (s2 && s2.answer && typeof s2.answer.message === 'string' ? s2.answer.message : null))
      .filter(Boolean);

    await routeConversation({ leadId, e164, answers });
  }

  return null;
}

/**
 * Run the routing rules for one conversation, on its own transaction.
 *
 * Called from BOTH ingest paths, which is the whole point of it being a
 * function:
 *
 *   applyInbound   the customer's own message, with no answers — this is where
 *                  the lead is created, and where a lead that never touches the
 *                  flow gets its only chance at an owner
 *   applyWorkflow  the flow's side, carrying the answers — this is where a
 *                  category can be worked out, and where a provisional owner is
 *                  either confirmed or handed on
 *
 * ── Its own transaction, and never rethrown ──────────────────────────────────
 *
 * Routing must not be able to roll back the message that triggered it. The
 * caller has already committed; this opens its own connection so a failure here
 * cannot reach back into that. And a thrown error is swallowed on purpose: the
 * messages are stored, the lead exists, and it stays in the unassigned queue
 * where a human can see it. Losing the routing is a nuisance. Losing the
 * message is a lost customer.
 */
async function routeConversation({ leadId, e164, answers }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await routeInbound(c, { leadId, e164, answers });
    await c.query('COMMIT');

    if (r.reason === 'recategorised') {
      // Logged differently from a plain assignment because it is the one
      // outcome that takes a lead OFF somebody, and "why did that leave my
      // list?" needs an answer that is not a database query.
      console.log(`[whatsapp:routing] lead #${leadId} moved user #${r.movedFrom} → user #${r.userId} (answer arrived)`);
    } else if (r.assigned) {
      console.log(`[whatsapp:routing] lead #${leadId} → user #${r.userId} (${r.reason})`);
    } else if (r.reason && r.reason !== 'already_assigned' && r.reason !== 'fallback_confirmed') {
      console.log(`[whatsapp:routing] lead #${leadId} left unassigned: ${r.reason}`);
    }
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[whatsapp:routing] could not assign:', err.message);
    return { assigned: false, userId: null, reason: 'error' };
  } finally {
    c.release();
  }
}

/** PostgreSQL rejects \u0000 in jsonb, and the raw log must survive anything. */
function safeJson(payload) {
  return JSON.stringify(payload).replace(/\\u0000/g, '');
}

/**
 * Everything after the 200. Runs detached; nothing here can affect the
 * response, which has already gone.
 */
async function processEvent(payload) {
  const type = payload?.type || null;
  const msg = payload?.data?.message || {};

  let eventId = null;
  try {
    // Raw first, before interpretation, and for EVERY event — including
    // unrecognised ones. When Interakt changes a payload shape this is the only
    // thing that can answer "what did they actually send us?"
    const ev = await pool.query(
      `INSERT INTO wa_events (provider_message_id, event_type, payload)
       VALUES ($1, $2, $3) RETURNING id`,
      [msg.id || null, type, safeJson(payload)]
    );
    eventId = ev.rows[0].id;
  } catch (err) {
    // The append-only log is the one thing designed to survive a payload
    // surprise, so a failure here is worth its own line rather than being
    // folded into the general handler below.
    console.error('[whatsapp:webhook] could not store raw event:', err.message);
    return;
  }

  const markProcessed = (err) => pool.query(
    `UPDATE wa_events SET processed_at = NOW(), process_error = $2 WHERE id = $1`,
    [eventId, err ? String(err).slice(0, 500) : null]
  ).catch(() => {});

  try {
    if (type === 'message_received') {
      // applyInbound returns null on success, or a short reason when it could
      // not store the reply. Recording that reason is the point: an inbound
      // message that was silently dropped and logged as processed is a
      // customer reply nobody will ever discover.
      const inboundReason = await applyInbound(payload);
      return markProcessed(inboundReason || null);
    }

    // The workflow's side of the conversation. Kept next to message_received
    // rather than lumped in with the delivery-status events below, because it
    // WRITES messages — it is an ingest path, not a status update.
    if (type === 'workflow_response_update') {
      const workflowReason = await applyWorkflow(payload);
      return markProcessed(workflowReason || null);
    }

    // Campaign sends (message_campaign_*) come from Interakt's own dashboard,
    // not from us. Stored above, deliberately not applied — there is no
    // wa_messages row to advance, and inventing one would put messages nobody
    // sent from this CRM onto a customer's record.
    if (!type || !type.startsWith('message_api_')) {
      return markProcessed('unhandled_event_type');
    }

    // hasOwnProperty, not a bare lookup. message_status is attacker-controlled
    // JSON, and STATUS_MAP['constructor'] is truthy — which would sail past a
    // falsy check and put the string "undefined" into the SQL below.
    const raw = msg.message_status;
    const next = (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(STATUS_MAP, raw))
      ? STATUS_MAP[raw]
      : null;
    if (!next) return markProcessed('unknown_message_status');

    const cb = msg.meta_data?.source_data?.callback_data;
    const rowId = Number(cb);
    if (!cb || !Number.isSafeInteger(rowId) || rowId < 1 || rowId > 2147483647) {
      return markProcessed('no_callback_data');
    }

    const applied = await applyStatus(rowId, next, msg);
    // Not applied is a normal outcome, not an error: the row has already passed
    // this rung, or the id names nothing outbound.
    return markProcessed(applied ? null : 'superseded_or_missing');
  } catch (err) {
    console.error('[whatsapp:webhook] processing failed:', err?.message || err);
    return markProcessed(err?.message || 'error');
  }
}

/** POST /api/whatsapp/webhook */
function receiveWebhook(req, res) {
  const sig = verifySignature(req);

  if (!sig.ok) {
    // Misconfiguration is answered with 200; forgery with 401.
    //
    // Not a nicety. Any non-200 counts toward Interakt's five-failures-in-ten-
    // minutes rule, which disables the webhook until a human re-enables it in
    // their dashboard. INTERAKT_WEBHOOK_SECRET ships blank, so a deploy that
    // forgets it would burn the webhook within the first five status events —
    // turning a five-second fix into an outage someone has to notice first.
    //
    // The event is dropped either way. This only decides whether the endpoint
    // is still alive once the secret is set.
    if (sig.reason === 'no_secret_configured') {
      console.error(
        '[whatsapp:webhook] no webhook secret configured (Settings → WhatsApp → Connection, ' +
        'or INTERAKT_WEBHOOK_SECRET) — webhook events are being ACKNOWLEDGED AND DISCARDED. ' +
        'Delivery status will not update until it is set.'
      );
      return res.status(200).json({ ok: true, ignored: true });
    }

    // A drifted secret looks identical to "tracking stopped working" from the
    // outside, so this line is the only breadcrumb.
    console.warn('[whatsapp:webhook] rejected:', sig.reason);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ACK NOW. Everything below this line is detached.
  //
  // Doing the inserts first would be more robust against a crash, but it puts
  // Postgres — which may be a suspended instance needing a cold wake — inside a
  // 3-second budget whose penalty for being exceeded five times is the webhook
  // being switched off entirely.
  res.status(200).json({ ok: true });

  setImmediate(() => {
    processEvent(req.body).catch(err =>
      console.error('[whatsapp:webhook] unhandled:', err?.message || err));
  });
}

module.exports = { receiveWebhook, verifySignature, _RANK: RANK };
