'use strict';

/**
 * /api/whatsapp/messages — the per-record message history and manual send.
 *
 * This is the operational half of the module, as opposed to
 * whatsapp.controller.js which is the configuration half. Different permissions
 * on purpose: an advisor may need to send a customer an approved template
 * without being trusted to change what every future message says.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { notifyWhatsApp, previewWhatsApp } = require('../services/whatsapp.dispatcher');
const { drainOnce } = require('../services/whatsappOutbox.service');
const { toE164 } = require('../utils/phone');
const { sendText } = require('../utils/interakt');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch((err) => {
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error: 'WhatsApp is not set up yet — run npm run db:migrate.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: err.errors[0]?.message || 'Invalid input' });
    }
    next(err);
  });
}

// 'advance' was the missing one, and its absence was the whole of Gap 6.
//
// The dispatcher has supported it all along — ADVANCE_CONTEXT, a buildValues
// branch returning customer_name / voucher_no / amount / balance_due /
// receipt_link, and the advance_receipt template. Only this validator stood in
// the way, so when the automatic send failed (it swallows every error by
// design, because a WhatsApp outage must never roll back money already taken)
// there was no way to send it again from anywhere.
//
// Shared by listMessages, preview and sendManual — all three open at once.
const ENTITY_TYPES = ['appointment', 'invoice', 'estimate', 'lead', 'advance', 'payment'];

const listQuery = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.coerce.number().int().positive(),
});

/**
 * GET /api/whatsapp/messages?entity_type=appointment&entity_id=123
 *
 * `variables` is returned but `body_rendered` is what the UI shows — the
 * frozen record of what the customer actually received, rather than a re-render
 * from data that may since have been corrected.
 */
function listMessages(req, res, next) {
  handle(req, res, next, async () => {
    const q = listQuery.parse(req.query);

    const r = await pool.query(
      `SELECT m.id, m.template_key, m.direction, m.to_number, m.status,
              m.body_rendered, m.variables,
              m.error_code, m.error_message, m.attempts, m.next_retry_at,
              m.created_at, m.sent_at, m.delivered_at, m.read_at, m.failed_at,
              u.name AS sent_by_name
         FROM wa_messages m
         LEFT JOIN users u ON u.id = m.sent_by
        WHERE m.entity_type = $1 AND m.entity_id = $2
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 100`,
      [q.entity_type, q.entity_id]
    );

    // Which templates THIS RECORD could be sent. Two filters, and the second
    // one is new.
    //
    // Only enabled ones — a disabled template is not a choice an advisor should
    // be offered and then told they cannot use.
    //
    // And only ones mapped to this entity type. Without that clause every
    // enabled template was offered on every record: "Advance Receipt" appeared
    // on a lead, and picking it produced a 422 for a variable a lead has no way
    // to supply. The registry always knew what each template NEEDS; entity_types
    // (migration 147) is how it says what it BELONGS TO.
    const t = await pool.query(
      `SELECT template_key, provider_template_name, body_preview
         FROM wa_templates
        WHERE is_active AND is_enabled
          AND $1 = ANY(entity_types)
        ORDER BY id`,
      [q.entity_type]
    );

    res.json({ items: r.rows, available_templates: t.rows });
  });
}

/**
 * Is this template allowed to be sent from this kind of record?
 *
 * listMessages already filters the dropdown, but a filter in a list response is
 * a suggestion, not a rule — a stale browser tab, a replayed request or a
 * hand-rolled POST all bypass it. This is the rule.
 *
 * It matters more than a tidiness check. Sending 'advance_receipt' from a lead
 * does not merely fail: the dispatcher would resolve what it could, and a
 * template whose variables happen to be satisfiable from the wrong context
 * sends a real message describing a payment that does not exist.
 *
 * Returns null when allowed, or a sentence to hand back with a 422.
 */
async function templateNotAllowed(entityType, templateKey) {
  const r = await pool.query(
    `SELECT entity_types FROM wa_templates
      WHERE template_key = $1 AND is_active
      ORDER BY id DESC LIMIT 1`,
    [templateKey]
  );
  // No row at all is not this function's business — the dispatcher reports
  // template_missing, which is the more accurate answer.
  if (!r.rowCount) return null;
  const types = r.rows[0].entity_types || [];
  // An unmapped template is offered nowhere, which migration 147 warns about at
  // migrate time. Treat it as allowed rather than blocking a send that used to
  // work: this guard is here to stop a WRONG pairing, not to enforce a column
  // that may not have been filled in yet.
  if (!types.length) return null;
  if (types.includes(entityType)) return null;
  return `That template is not for a ${entityType} — it belongs to: ${types.join(', ')}.`;
}

const previewQuery = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.coerce.number().int().positive(),
  template_key: z.string().trim().min(1).max(40),
});

/** GET /api/whatsapp/messages/preview */
function preview(req, res, next) {
  handle(req, res, next, async () => {
    const q = previewQuery.parse(req.query);
    // Same shape the UI already renders for every other refusal, so a stale
    // dropdown reads as an explained "cannot send" rather than a broken screen.
    const notAllowed = await templateNotAllowed(q.entity_type, q.template_key);
    if (notAllowed) return res.json({ ok: false, reason: 'wrong_entity_type', error: notAllowed });
    const out = await previewWhatsApp(pool, {
      templateKey: q.template_key,
      entityType: q.entity_type,
      entityId: q.entity_id,
    });
    // 200 either way. "This cannot be sent because the hub has no map link" is
    // an answer to the advisor's question, not a fault in their request, and a
    // 4xx would surface as a generic toast instead of the reason.
    res.json(out);
  });
}

const sendBody = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.coerce.number().int().positive(),
  template_key: z.string().trim().min(1).max(40),
  to: z.string().trim().max(20).optional(),
});

/**
 * POST /api/whatsapp/messages/send — manual send.
 *
 * Queues through the same dispatcher as every automatic send. A separate path
 * that talked to Interakt directly would be a second definition of what a
 * message is, and the two would drift.
 */
function sendManual(req, res, next) {
  handle(req, res, next, async () => {
    const d = sendBody.parse(req.body);

    // Checked BEFORE the transaction opens. Nothing below this point is worth
    // doing for a pairing that must not send, and a rejection that has taken no
    // locks is a rejection that cannot have half-happened.
    const notAllowed = await templateNotAllowed(d.entity_type, d.template_key);
    if (notAllowed) return res.status(422).json({ error: notAllowed, reason: 'wrong_entity_type' });

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      out = await notifyWhatsApp(client, {
        templateKey: d.template_key,
        entityType: d.entity_type,
        entityId: d.entity_id,
        manual: true,
        sentBy: req.user?.id || null,
        overrideTo: d.to || null,
        // Undefined, so the dispatcher generates a timestamp bucket. A manual
        // resend is a deliberate act and must not collide with the automatic
        // send that already went out for the same record.
        dedupeKey: undefined,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (!out.queued) {
      return res.status(422).json({ error: reasonToMessage(out.reason), reason: out.reason });
    }

    // Nudge the worker rather than leaving the advisor watching a 'queued' chip
    // for up to a minute. Fire-and-forget: the poller is the guarantee, this is
    // only latency.
    drainOnce().catch(() => {});

    res.status(201).json({ id: out.id });
  });
}

/**
 * POST /api/whatsapp/messages/:id/retry
 *
 * Re-queues a failed message. Deliberately manual — most WhatsApp failures are
 * permanent, so the worker gives up rather than burning attempts, and a human
 * decides whether the cause has been fixed.
 */
function retryMessage(req, res, next) {
  handle(req, res, next, async () => {
    const id = z.coerce.number().int().positive().parse(req.params.id);

    const r = await pool.query(
      `UPDATE wa_messages
          SET status = 'queued', attempts = 0, next_retry_at = NULL,
              error_code = NULL, error_message = NULL, failed_at = NULL
        WHERE id = $1 AND direction = 'out' AND status = 'failed'
        RETURNING id`,
      [id]
    );
    if (!r.rowCount) {
      return res.status(409).json({ error: 'Only a failed message can be retried.' });
    }

    drainOnce().catch(() => {});
    res.json({ ok: true });
  });
}

/**
 * GET /api/whatsapp/stats — the "is it working?" numbers the Settings screen
 * opens with.
 *
 * "Today" is Asia/Kolkata, matching how the business reads a day, not the
 * server's timezone. `sent` counts rows whose sent_at lands today — delivered
 * and read rows keep their sent_at as the ladder advances, so the buckets
 * nest the way the cards read: read ⊆ delivered ⊆ sent. Rates are computed
 * here rather than in the UI so the two can never disagree about the
 * denominator.
 */
function getStats(req, res, next) {
  handle(req, res, next, async () => {
    const m = await pool.query(
      `WITH tz AS (SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today)
       SELECT
         COUNT(*) FILTER (WHERE (m.sent_at   AT TIME ZONE 'Asia/Kolkata')::date = t.today)     AS sent_today,
         COUNT(*) FILTER (WHERE (m.sent_at   AT TIME ZONE 'Asia/Kolkata')::date = t.today - 1) AS sent_yesterday,
         COUNT(*) FILTER (WHERE (m.sent_at   AT TIME ZONE 'Asia/Kolkata')::date = t.today
                            AND m.status IN ('delivered','read'))                              AS delivered_today,
         COUNT(*) FILTER (WHERE (m.sent_at   AT TIME ZONE 'Asia/Kolkata')::date = t.today
                            AND m.status = 'read')                                             AS read_today,
         COUNT(*) FILTER (WHERE (m.failed_at AT TIME ZONE 'Asia/Kolkata')::date = t.today)     AS failed_today,
         COUNT(*) FILTER (WHERE m.status = 'queued')                                           AS queued_now
         FROM wa_messages m CROSS JOIN tz t
        WHERE m.direction = 'out'`
    );
    const s = m.rows[0];
    const sent = Number(s.sent_today);
    const failed = Number(s.failed_today);

    // Missing table (migration 151 behind the code) degrades to zeros rather
    // than failing the whole stats row — the screen still renders.
    let automations = { active: 0, total: 0 };
    try {
      const a = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_active) AS active, COUNT(*) AS total FROM wa_automations`
      );
      automations = { active: Number(a.rows[0].active), total: Number(a.rows[0].total) };
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }

    res.json({
      sent_today: sent,
      sent_yesterday: Number(s.sent_yesterday),
      delivered_today: Number(s.delivered_today),
      read_today: Number(s.read_today),
      failed_today: failed,
      queued_now: Number(s.queued_now),
      // Denominators chosen once, here. Delivery/read rate over what was
      // SENT; failure rate over what was ATTEMPTED (sent + failed), because a
      // failed message was never sent and must not deflate the other two.
      delivery_rate: sent ? Math.round((Number(s.delivered_today) / sent) * 100) : null,
      read_rate:     sent ? Math.round((Number(s.read_today) / sent) * 100) : null,
      failure_rate:  (sent + failed) ? Math.round((failed / (sent + failed)) * 100) : null,
      automations_active: automations.active,
      automations_total: automations.total,
    });
  });
}

/**
 * GET /api/whatsapp/messages/recent — the latest outbound messages across ALL
 * records, for the log panel on the Settings screen. listMessages answers
 * "what did we send THIS customer"; this answers "what has the system been
 * doing lately", which is where a burst of failures becomes visible.
 *
 * The name join is best-effort: wa_messages stores only the E.164 number, so
 * the profile is matched on the 10-digit national part. A miss shows the
 * number, which is still an answer.
 */
function listRecent(req, res, next) {
  handle(req, res, next, async () => {
    // 10 to match the shared PaginationBar's smallest option, which is what the
    // screen shows by default. 100 ceiling because the bar offers 100 — a cap
    // below the selector's own choices would make a legitimate pick silently
    // return fewer rows than asked for.
    //
    // Validated rather than clamped. `Number('-5') || 10` keeps -5, because -5
    // is truthy, and Math.max(-5, 1) then quietly turns it into a ONE-row page
    // — a nonsense parameter producing a plausible-looking result instead of
    // the default. Anything not a usable number falls back.
    const rawLimit  = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const limit  = Number.isFinite(rawLimit)  && rawLimit  >= 1 ? Math.min(Math.floor(rawLimit), 100) : 10;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

    const r = await pool.query(
      `SELECT m.id, m.template_key, m.to_number, m.status, m.entity_type, m.entity_id,
              m.error_code, m.error_message, m.created_at, m.sent_at,
              NULLIF(TRIM(cp.display_name), '') AS customer_name
         FROM wa_messages m
         LEFT JOIN customer_profiles cp ON cp.mobile = RIGHT(m.to_number, 10)
        WHERE m.direction = 'out'
        ORDER BY m.id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // total drives the pager. newest_id is what Clear passes back as `upto`.
    //
    // Why newest_id and not "the largest id on this page": on page 3 the
    // largest id on screen is an OLD one, so clearing bounded by it would wipe
    // page 3 and everything older while leaving pages 1-2 — which is not what
    // anyone means by Clear. Bounding by the newest row that existed when this
    // page loaded makes Clear mean the same thing on every page, and still
    // protects a message that sends between the load and the click.
    const agg = await pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(id), 0)::int AS newest_id
         FROM wa_messages WHERE direction = 'out'`
    );

    // The refused sends beside the delivered ones — the answer to "why didn't
    // the customer get a message?" surfaced where the automations live,
    // instead of only in a server terminal. Translated to a sentence HERE so
    // the screen and the manual-send flow can never word the same reason two
    // different ways. Missing table (migration 154 behind the code) degrades
    // to an empty list.
    //
    // Fixed cap, deliberately NOT the caller's `limit`. The skipped list is a
    // separate concern with its own Clear; paging the sent log down to 10 must
    // not also hide refusals the user has not dealt with yet.
    let skips = [];
    try {
      const s = await pool.query(
        `SELECT id, event, template_key, entity_type, entity_id, reason, created_at
           FROM wa_send_skips
          ORDER BY id DESC
          LIMIT 20`
      );
      skips = s.rows.map(row => ({ ...row, message: reasonToMessage(row.reason) }));
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }

    res.json({
      items: r.rows,
      skips,
      total: agg.rows[0].total,
      newest_id: agg.rows[0].newest_id,
    });
  });
}

/**
 * DELETE /api/whatsapp/messages/skips        — clear the skipped list
 * DELETE /api/whatsapp/messages/skips/:id    — clear one row
 *
 * These rows are diagnostic notes, not records of anything that happened to a
 * customer — nothing was sent, nothing was charged. Once the reason has been
 * read and acted on, the line is noise, and a panel that only ever grows stops
 * being read at all. So this deletes rather than hides.
 *
 * ── Why `upto` and not "delete everything" ──────────────────────────────────
 *
 * The panel shows a page of rows. Between it rendering and the click landing,
 * an automation can refuse a send and append a new row. An unbounded DELETE
 * would destroy that one too — a refusal nobody ever saw, which is exactly the
 * failure this table was built to end.
 *
 * So the client sends the newest id it is actually displaying, and only rows at
 * or below it are removed. Anything newer survives and is on screen after the
 * refresh. Omitting `upto` clears everything, which is the honest behaviour for
 * a caller that did not tell us what it could see.
 *
 * Guarded by MANAGE_WHATSAPP_TEMPLATES, not by the read permission the panel
 * itself uses: being able to READ the diagnostic trail should not carry the
 * ability to erase it.
 */
function clearSkips(req, res, next) {
  handle(req, res, next, async () => {
    const upto = req.query.upto === undefined ? null : Number(req.query.upto);
    if (upto !== null && (!Number.isInteger(upto) || upto < 1)) {
      return res.status(400).json({ error: 'upto must be a positive integer' });
    }

    try {
      const r = upto === null
        ? await pool.query(`DELETE FROM wa_send_skips`)
        : await pool.query(`DELETE FROM wa_send_skips WHERE id <= $1`, [upto]);
      res.json({ cleared: r.rowCount });
    } catch (err) {
      // Migration 154 not run yet — the panel is empty anyway, so "cleared
      // nothing" is the truthful answer rather than a 500.
      if (err.code === '42P01') return res.json({ cleared: 0 });
      throw err;
    }
  });
}

function clearSkip(req, res, next) {
  handle(req, res, next, async () => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    try {
      const r = await pool.query(`DELETE FROM wa_send_skips WHERE id = $1`, [id]);
      // 404 rather than a silent 200: two people clearing the same row should
      // not both be told they did it.
      if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ cleared: 1 });
    } catch (err) {
      if (err.code === '42P01') return res.status(404).json({ error: 'Not found' });
      throw err;
    }
  });
}

/**
 * DELETE /api/whatsapp/messages/log       — clear the recent-messages log
 * DELETE /api/whatsapp/messages/log/:id   — clear one line
 *
 * ⚠️ THIS DELETES THE AUDIT RECORD OF A REAL, BILLED MESSAGE. Requested
 * deliberately by the owner, who was shown the consequences first. They are
 * repeated here because the next person to read this will not have been in
 * that conversation:
 *
 *   1. THE DOUBLE-SEND GUARD GOES WITH THE ROW. idx_wa_messages_dedupe is a
 *      unique index over (template_key, entity_type, entity_id, dedupe_key) and
 *      notifyWhatsApp inserts ON CONFLICT DO NOTHING. The row IS the guard.
 *      Delete "Service Completed / appointment 86" and the next time that event
 *      fires, the customer receives it a second time. Nothing else prevents it.
 *   2. Delivery webhooks arriving later (Sent → Delivered → Read, matched on
 *      provider_message_id) will find nothing to update.
 *   3. /stats counts these rows, so the cards on the same screen will drop.
 *   4. The customer's own WhatsApp tab reads the same table.
 *
 * If this ever needs revisiting, the safe shape is a hidden_at column and a
 * filter in listRecent — same button, none of the above.
 *
 * ── The one line this DOES hold ─────────────────────────────────────────────
 *
 * status='queued' rows are never cleared. A queued row is not a log entry, it
 * is pending work owned by the outbox worker: deleting it would silently CANCEL
 * a send that has not happened yet. "Tidy my log" and "cancel that message" are
 * different intents and a button labelled Clear must only do the first. The
 * response reports how many were kept so the screen can say so.
 *
 * `upto` bounds the delete to the ids actually on screen — see clearSkips for
 * why an unbounded DELETE is wrong here too.
 */
function clearLog(req, res, next) {
  handle(req, res, next, async () => {
    const upto = req.query.upto === undefined ? null : Number(req.query.upto);
    if (upto !== null && (!Number.isInteger(upto) || upto < 1)) {
      return res.status(400).json({ error: 'upto must be a positive integer' });
    }

    const params = [];
    let where = `direction = 'out' AND status <> 'queued'`;
    if (upto !== null) { params.push(upto); where += ` AND id <= $${params.length}`; }

    const del = await pool.query(`DELETE FROM wa_messages WHERE ${where}`, params);

    // What survived, and why — so the UI can explain a list that did not empty
    // rather than looking broken.
    const keptParams = [];
    let keptWhere = `direction = 'out' AND status = 'queued'`;
    if (upto !== null) { keptParams.push(upto); keptWhere += ` AND id <= $${keptParams.length}`; }
    const kept = await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE ${keptWhere}`, keptParams);

    res.json({ cleared: del.rowCount, kept: kept.rows[0].n });
  });
}

function clearLogEntry(req, res, next) {
  handle(req, res, next, async () => {
    const id = z.coerce.number().int().positive().parse(req.params.id);

    const r = await pool.query(
      `DELETE FROM wa_messages
        WHERE id = $1 AND direction = 'out' AND status <> 'queued'
        RETURNING id`,
      [id]
    );

    if (r.rowCount === 0) {
      // Separate the two reasons. "Still queued" is a refusal the user can act
      // on (wait for it to send); "gone" is just a stale screen.
      const still = await pool.query(
        `SELECT status FROM wa_messages WHERE id = $1`, [id]
      );
      if (still.rowCount > 0 && still.rows[0].status === 'queued') {
        return res.status(409).json({ error: 'That message has not been sent yet — it cannot be cleared from the log while it is still queued.' });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ cleared: 1 });
  });
}

/**
 * GET /api/whatsapp/messages/thread?mobile=... — the whole conversation with
 * one phone number, inbound and outbound together, oldest first.
 *
 * ── Why by NUMBER and not by (entity_type, entity_id) ───────────────────────
 *
 * listMessages answers "what did we send about THIS invoice". That is the right
 * question for a document. It is the wrong question for a conversation: a
 * customer's thread is one continuous exchange that happens to touch a lead,
 * then an estimate, then an invoice. Keyed by entity it would arrive as three
 * unrelated fragments, none of which is the conversation.
 *
 * It also solves the customer case with no extra machinery. customer_profiles
 * has no integer id — it is keyed by mobile — so ('customer', id) was never
 * expressible in wa_messages' polymorphic columns. A number IS the key.
 *
 * Oldest first, unlike every other list here, because this renders as a chat.
 */
function listThread(req, res, next) {
  handle(req, res, next, async () => {
    const e164 = toE164(req.query.mobile);
    if (!e164) return res.status(400).json({ error: 'A valid Indian mobile number is required.' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

    const r = await pool.query(
      `SELECT m.id, m.direction, m.template_key, m.to_number, m.status,
              m.body_rendered, m.error_code, m.error_message,
              -- crm | bot. The panel renders a workflow message differently, so
              -- nobody reads "Hi 👋 What do you need help with?" as something a
              -- colleague typed.
              m.origin,
              m.entity_type, m.entity_id,
              m.created_at, m.sent_at, m.delivered_at, m.read_at, m.failed_at,
              u.name AS sent_by_name
         FROM wa_messages m
         LEFT JOIN users u ON u.id = m.sent_by
        WHERE m.to_number = $1
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $2`,
      [e164, limit]
    );

    // The 24-hour window decides whether the reply box is usable or whether the
    // advisor must pick a template. The UI cannot work that out on its own, and
    // guessing from the last inbound message's timestamp would be a second
    // implementation of a rule that already has one.
    const conv = await pool.query(
      `SELECT c.mobile, c.customer_name, c.lead_id, c.last_inbound_at, c.window_expires_at,
              (c.window_expires_at IS NOT NULL AND c.window_expires_at > NOW()) AS window_open,
              -- Who owns this customer. The panel names them, because two
              -- advisors answering the same person is the failure the whole
              -- assignment feature exists to prevent — and it can only be
              -- prevented by the second one being able to see the first.
              c.assigned_user_id,
              au.name AS assigned_user_name
         FROM wa_conversations c
         LEFT JOIN users au ON au.id = c.assigned_user_id
        WHERE c.mobile = $1`,
      [e164]
    );

    res.json({
      mobile: e164,
      conversation: conv.rows[0] || null,
      window_open: conv.rows[0]?.window_open === true,
      items: r.rows,
    });
  });
}

const replyBody = z.object({
  mobile: z.string().trim().min(1),
  message: z.string().trim().min(1).max(4096),
});

/**
 * Give an unowned WhatsApp conversation to the person who just answered it.
 *
 * Both writes are guarded on being empty:
 *
 *   wa_conversations.assigned_user_id IS NULL   — do not steal the customer
 *   leads.assigned_to IS NULL                   — do not steal the lead
 *
 * so a reply typed by a colleague helping out cannot quietly take a lead off
 * the advisor the rota gave it to. Taking over is a separate, deliberate act
 * that gets logged; this is only ever filling a hole.
 */
async function claimIfUnassigned(e164, userId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const conv = await c.query(
      `UPDATE wa_conversations
          SET assigned_user_id = $2
        WHERE mobile = $1 AND assigned_user_id IS NULL
        RETURNING lead_id`,
      [e164, userId]
    );

    // No row means it already had an owner. Nothing else to do — and in
    // particular do NOT go on to touch the lead.
    if (conv.rowCount && conv.rows[0].lead_id) {
      await c.query(
        `UPDATE leads
            SET assigned_to = $2, assignment_source = 'reply'
          WHERE id = $1 AND assigned_to IS NULL`,
        [conv.rows[0].lead_id, userId]
      );
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * POST /api/whatsapp/messages/reply — an advisor's free-form reply.
 *
 * ── The window check is the whole point ─────────────────────────────────────
 *
 * Meta allows free-form text only within 24 hours of the customer's last
 * message. Outside it the send is rejected by Interakt, and an advisor who
 * typed a careful reply is told "failed" with no explanation. Refusing here,
 * with the reason, is the difference between a rule and a mystery.
 *
 * The row is written BEFORE the send and updated after, deliberately: a reply
 * that reached the customer but crashed before being recorded is worse than one
 * recorded as failed that actually went — the first is invisible, the second is
 * visible and wrong, and only the second can be noticed and corrected.
 *
 * dedupe_key is a per-minute bucket, matching the manual-send convention: an
 * advisor may legitimately send the same words twice, but not twice from one
 * double-clicked button.
 */
function sendReply(req, res, next) {
  handle(req, res, next, async () => {
    const b = replyBody.parse(req.body);
    const e164 = toE164(b.mobile);
    if (!e164) return res.status(400).json({ error: 'A valid Indian mobile number is required.' });

    const conv = await pool.query(
      `SELECT window_expires_at,
              (window_expires_at IS NOT NULL AND window_expires_at > NOW()) AS open
         FROM wa_conversations WHERE mobile = $1`,
      [e164]
    );
    if (!conv.rows[0]?.open) {
      return res.status(409).json({
        error:
          'The 24-hour reply window has closed. WhatsApp only allows a free-typed message within 24 hours of the ' +
          'customer’s last message — send an approved template instead.',
        code: 'WINDOW_CLOSED',
      });
    }

    // Attach the reply to whatever the inbound messages from this number are
    // attached to, so it appears on the same lead rather than floating.
    const anchor = await pool.query(
      `SELECT entity_type, entity_id FROM wa_messages
        WHERE to_number = $1 AND entity_type IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [e164]
    );

    const ins = await pool.query(
      `INSERT INTO wa_messages
         (direction, to_number, body_rendered, status, sent_by,
          entity_type, entity_id, dedupe_key, created_at, queued_at)
       VALUES ('out', $1, $2, 'queued', $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        e164, b.message, req.user.id,
        anchor.rows[0]?.entity_type || null,
        anchor.rows[0]?.entity_id || null,
        `reply:${new Date().toISOString().slice(0, 16)}`,
      ]
    );
    if (ins.rowCount === 0) {
      return res.status(409).json({ error: 'That reply was already sent moments ago.' });
    }
    const rowId = ins.rows[0].id;

    const out = await sendText({ to: e164, message: b.message, callbackData: String(rowId) });

    if (!out.ok) {
      await pool.query(
        `UPDATE wa_messages
            SET status = 'failed', failed_at = NOW(), error_code = $2, error_message = $3
          WHERE id = $1`,
        [rowId, out.errorCode || 'ERROR', out.errorMessage || 'Send failed.']
      );
      return res.status(502).json({ error: out.errorMessage || 'Interakt rejected the reply.', code: out.errorCode });
    }

    await pool.query(
      `UPDATE wa_messages
          SET status = 'sent', sent_at = NOW(), provider_message_id = COALESCE($2, provider_message_id)
        WHERE id = $1`,
      [rowId, out.providerMessageId || null]
    );

    // Not window_expires_at — a message WE send does not reopen the window;
    // only the customer replying does. last_message_at is the thread's activity
    // clock and is the one that should move.
    await pool.query(
      `UPDATE wa_conversations SET last_message_at = NOW() WHERE mobile = $1`,
      [e164]
    );

    // ── Answering an unowned conversation claims it ──────────────────────────
    //
    // The safety net under the rota. Routing can only assign a lead whose
    // category somebody has ticked and who is on duty; when it cannot, the lead
    // sits in the shared unassigned queue. Whoever picks it up out of that queue
    // and actually replies is its owner from that moment.
    //
    // Captured by the act of replying rather than a button, because a button to
    // claim a lead is a button somebody forgets, and then two advisors answer
    // the same customer — the single failure this whole feature exists to stop.
    //
    // Only ever fills a hole: COALESCE-guarded on both sides, so it can never
    // take a conversation off the person the rota gave it to.
    try {
      await claimIfUnassigned(e164, req.user.id);
    } catch (err) {
      // The message is sent. Failing the request now would tell the advisor
      // their reply did not go out, which is false and would make them send it
      // twice.
      console.error('[whatsapp:reply] could not claim conversation:', err.message);
    }

    res.json({ id: rowId, status: 'sent' });
  });
}

/** Dispatcher reasons are terse and internal; advisors get a sentence. */
function reasonToMessage(reason) {
  if (!reason) return 'Could not send.';
  if (reason.startsWith('missing_variable:')) {
    const key = reason.split(':')[1];
    if (key === 'workshop_link') {
      return 'This hub has no map link set. Add one in Master Data → HUBs before sending this template.';
    }
    if (key === 'invoice_link') {
      return 'No invoice link could be resolved — the record has no APPROVED invoice yet, or PUBLIC_APP_URL is not configured.';
    }
    if (key === 'estimate_link' || key === 'estimate_amount') {
      return 'No estimate could be resolved — the record has no estimate that was sent to the customer yet, or PUBLIC_APP_URL is not configured.';
    }
    return `Cannot send: "${key}" is empty for this record. A message with a blank line is worse than none.`;
  }
  return {
    auto_send_off:          'The template is not set to Auto-send — switch it on in the Templates tab.',
    template_disabled:      'That template is switched off in Settings → WhatsApp.',
    no_such_template:       'That template is not set up.',
    no_messageable_number:  'This record has no valid WhatsApp number.',
    entity_not_found:       'Record not found.',
    unsupported_entity:     'Messages are not supported for this record type yet.',
    duplicate:              'That message was already sent moments ago.',
    error:                  'Something went wrong queueing the message — check the server log.',
  }[reason] || `Could not send (${reason}).`;
}

module.exports = {
  listMessages, preview, sendManual, retryMessage, getStats, listRecent,
  clearSkips, clearSkip, clearLog, clearLogEntry,
  listThread, sendReply,
};
