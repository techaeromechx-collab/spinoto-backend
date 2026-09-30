'use strict';

/**
 * chat.controller.js — internal staff messaging.
 *
 * ══ THE ACCESS MODEL, IN ONE SENTENCE ══════════════════════════════════════
 *
 * A conversation id arriving from the URL means nothing until
 * chat_participants says this user is in it. Every read and every write in this
 * file starts there, via readMembership() or the shared FROM_SQL, and there is
 * no branch that skips it — not for a super admin, not for MANAGE_CHAT.
 *
 * ── 404, NOT 403 ─────────────────────────────────────────────────────────
 *
 * A non-participant gets "not found". 403 would confirm the conversation
 * exists, and in a private-messaging feature the existence of a thread between
 * two named people is itself the thing worth hiding. Somebody probing ids
 * should learn nothing from the difference between a real conversation they
 * cannot see and an id that was never issued.
 *
 * ══ WHAT IS NOT HERE ═══════════════════════════════════════════════════════
 *
 * No upload, no file field, no media. Sharing a record is a POINTER —
 * (ref_type, ref_id) and nothing else. Resolving that pointer into something
 * readable is phase 2 and lives in its own controller, because it is a fresh
 * authorization surface and it deserves to be reviewed as one rather than
 * smuggled in beside the send path.
 *
 * ══ POOL DISCIPLINE ════════════════════════════════════════════════════════
 *
 * config/db.js is max: 10, Neon pooled. The house rule: nothing that needs a
 * second connection runs between connect() and release(). sendMessage is the
 * only transaction here and it is written in the Shape B form with a `released`
 * flag — the push fan-out, which opens its own connections, happens strictly
 * after release(). See the comment there.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { emitInvalidateTo } = require('../socket');
const {
  FROM_SQL, UNREAD_SQL, HIDDEN_SQL, ROW_SQL, ORDER_SQL,
  REACTIONS_SQL, PEER_CURSORS_SQL, REPLY_SQL, readPendingReaders,
  MAX_PINS, PINNED_ONLY_SQL, UNPINNED_ONLY_SQL, PINNED_ORDER_SQL, LIVE_ONLY_SQL,
  readMembership, readParticipantIds,
  isModerator, canManage, assertWritable, writeSystemLine,
  dmKey,
} = require('../services/chatUnread.service');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

/** The single spelling of "you are not in this conversation". */
function notFound(res) {
  return res.status(404).json({ error: 'Conversation not found' });
}

const idParam = z.coerce.number().int().positive();

/* 4000 characters. Long enough for anything somebody types into a chat box,
   short enough that a paste of a whole invoice PDF's text does not become a
   message. Enforced here rather than only in the browser, because the browser
   is not where the guarantee lives. */
const MAX_BODY = 4000;

const REF_TYPES = [
  'lead', 'appointment', 'job_card', 'estimate',
  'customer_invoice', 'purchase_invoice', 'customer', 'vehicle',
];

const sendSchema = z.object({
  body: z.string().max(MAX_BODY, `A message cannot be longer than ${MAX_BODY} characters`)
         .optional(),
  ref_type: z.enum(REF_TYPES).optional(),
  ref_id: z.coerce.number().int().positive().optional(),
  reply_to_id: z.coerce.number().int().positive().optional(),
}).refine((d) => (d.body && d.body.trim()) || d.ref_type, {
  message: 'A message needs some text, or a record to point at',
}).refine((d) => (d.ref_type == null) === (d.ref_id == null), {
  message: 'A shared record needs both a type and an id',
});

const createSchema = z.object({
  user_ids: z.array(z.coerce.number().int().positive()).min(1, 'Pick at least one person').max(50),
  title: z.string().trim().max(120).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Reads
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/chat/unread-count
 *
 * Polled every 120s per tab plus on every socket nudge, so it is deliberately
 * one statement with no join to users or messages beyond the EXISTS. Same
 * discipline as the WhatsApp badge, for the same serverless-Postgres reason
 * spelled out in frontend/src/config/polling.js.
 */
function unreadCount(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS count
         ${FROM_SQL}
        WHERE ${UNREAD_SQL}`,
      [req.user.id]
    );
    res.json({ count: r.rows[0].count });
  });
}

/**
 * GET /api/chat/conversations?limit=&before=&include_dismissed=
 *
 * Read conversations are included, below the unread ones by time rather than by
 * rank — see ORDER_SQL for why the list does not reorder itself the moment
 * something is read.
 */
function listConversations(req, res, next) {
  handle(req, res, next, async () => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 60);
    const includeDismissed = req.query.include_dismissed === '1';
    /* Archived groups are off the list by default. `?archived=1` is how the
       "Archived" view asks for exactly them, rather than for everything with a
       flag the client then has to filter — a client-side filter would mean the
       page size counted rows the user never sees. */
    const archivedOnly = req.query.archived === '1';

    /* Keyset, not OFFSET. `before` is the previous page's last sort_at, and the
       tiebreak on id is what stops two conversations sharing a timestamp from
       being skipped or repeated across the boundary. */
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && Number.isNaN(before.getTime())) {
      return res.status(400).json({ error: 'before must be a timestamp' });
    }

    const params = [req.user.id];
    let cursor = '';
    if (before) { params.push(before); cursor = `AND COALESCE(c.last_message_at, c.created_at) < $${params.length}`; }

    /* The archived view is its own list: archived threads only, no pins, and it
       is not where somebody is looking for today's messages. */
    const scope = archivedOnly ? 'AND c.archived_at IS NOT NULL' : LIVE_ONLY_SQL;

    const r = await pool.query(
      `SELECT ${ROW_SQL}
         ${FROM_SQL}
        WHERE TRUE
          ${scope}
          ${archivedOnly ? '' : UNPINNED_ONLY_SQL}
          ${includeDismissed ? '' : `AND NOT (${HIDDEN_SQL})`}
          ${cursor}
        ${ORDER_SQL}
        LIMIT ${limit + 1}`,
      params
    );

    const hasMore = r.rows.length > limit;
    const items = hasMore ? r.rows.slice(0, limit) : r.rows;

    /* ── Pins are prepended, not paged ────────────────────────────────────
       Only on the first page, and never in the archived view. The long version
       of why is on PINNED_ONLY_SQL in the service: `before` is a cursor into one
       ordering, and pinned-first is a second one, so a pinned thread with an old
       last message would repeat on every page or fall out of all of them.
       A pinned thread that has been dismissed is STILL shown. Pinning it is the
       more recent and more deliberate statement of the two, and a pin that
       silently does nothing because the row was cleared weeks ago is worse than
       a row somebody has to unpin. */
    let pinned = [];
    if (!before && !archivedOnly) {
      const pr = await pool.query(
        `SELECT ${ROW_SQL}
           ${FROM_SQL}
          WHERE TRUE ${LIVE_ONLY_SQL} ${PINNED_ONLY_SQL}
          ${PINNED_ORDER_SQL}
          LIMIT ${MAX_PINS}`,
        [req.user.id]
      );
      pinned = pr.rows;
    }

    res.json({
      items: [...pinned, ...items],
      pinned_count: pinned.length,
      has_more: hasMore,
      next_before: items.length ? items[items.length - 1].sort_at : null,
    });
  });
}

/** GET /api/chat/conversations/:id — the header, for a deep link. */
function getConversation(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query(
      `SELECT ${ROW_SQL} ${FROM_SQL} WHERE c.id = $2`,
      [req.user.id, id]
    );
    if (!r.rowCount) return notFound(res);
    /* can_manage is computed here and not in SQL, because it needs the caller's
       permission set. Sent with the header so the UI can decide what to offer
       rather than showing a Rename button that 403s — and the routes check it
       again anyway, because a client deciding what it may do is not a rule. */
    res.json({ item: { ...r.rows[0], can_manage: canManage(req.user, r.rows[0]) } });
  });
}

/**
 * GET /api/chat/conversations/:id/participants — for the group info panel.
 *
 * Its own route rather than more columns on getConversation: the header is
 * fetched on every deep link and every socket nudge, and the member list with
 * who-added-whom is looked at when somebody opens the panel. Loading it on every
 * nudge would be most of the response for something nobody is looking at.
 *
 * Includes people who have LEFT, flagged. A group that six people were in and
 * two left is not a group of four as far as its history goes, and the panel is
 * the only place that can say so.
 */
function listParticipants(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);

    const r = await pool.query(
      `SELECT u.id, u.name, p.joined_at, p.left_at,
              (p.left_at IS NOT NULL) AS has_left,
              p.added_by, ab.name AS added_by_name,
              (u.id = $2) AS is_me,
              (u.id = c.created_by) AS is_creator
         FROM chat_participants p
         JOIN chat_conversations c ON c.id = p.conversation_id
         JOIN users u  ON u.id = p.user_id
         LEFT JOIN users ab ON ab.id = p.added_by
        WHERE p.conversation_id = $1
        ORDER BY (p.left_at IS NOT NULL), u.name`,
      [id, req.user.id]
    );
    res.json({
      items: r.rows,
      can_manage: canManage(req.user, member),
      /* Separate from can_manage on purpose. Managing a group is the creator's
         right; DESTROYING one is MANAGE_CHAT's alone, and on a DM there is no
         creator's right at all. Without this the panel offered a Delete button
         to a group's creator and let the server's 403 explain it afterwards,
         which is a button that exists to disappoint. */
      can_destroy: isModerator(req.user),
      archived: !!member.archived_at,
      kind: member.kind,
    });
  });
}

/**
 * GET /api/chat/conversations/:id/messages?limit=50&before=<id>
 *
 * ══ WHY THIS PAGINATES WHEN THE WHATSAPP THREAD DOES NOT ═══════════════════
 *
 * WhatsAppThread.jsx fetches every message in one request, and for a
 * conversation with a customer about one car that is fine — it ends when the
 * car is collected. Two colleagues never stop talking. Left unpaginated this
 * endpoint would, in a year, return tens of thousands of rows on every mount
 * of the chat page, over a pooled connection, to render fifty of them.
 *
 * Keyset on id, descending, then reversed by the client. `before` is an id and
 * not an offset: with OFFSET, a message arriving while somebody is reading
 * shifts every later page by one, so "load older" silently skips a message.
 * The index ix_chat_messages_thread matches this ORDER BY exactly.
 */
function listMessages(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before ? idParam.parse(req.query.before) : null;
    /* Search within the conversation. Same 2-character minimum as every other
       search in the app, and it searches BODIES ONLY — a deleted message's body
       is NULL so it cannot be found, which is the point of deleting it. */
    const q = String(req.query.q || '').trim();

    // Membership first, and it is the only thing standing between a URL and
    // somebody else's messages.
    if (!(await readMembership(pool, id, req.user.id))) return notFound(res);

    /* $1 conversation, $2 the acting user — fixed, because REACTIONS_SQL reads
       $2 for its `mine` flag. The cursor is appended AFTER those two and numbered
       from the array it is pushed onto, so adding another optional filter later
       cannot silently renumber somebody else's placeholder. */
    const qp = [id, req.user.id];
    let cursorSql = '';
    if (before) {
      qp.push(before);
      /* ── A KEYSET MUST COMPARE WHAT IT ORDERS BY ────────────────────────
         This was `AND m.id < $n`, which is wrong whenever id order and
         created_at order disagree — and they can: a backfilled or imported
         thread has high ids with old timestamps. The ORDER BY is
         (created_at DESC, id DESC), so the cursor has to be the same pair, or
         the page boundary lands in a different place from the sort and rows are
         repeated and skipped. A 120-message fixture inserted with descending
         timestamps produced 100 rows across two pages of 50 with 98 distinct.
         Row-wise comparison, which Postgres evaluates left to right exactly as
         the ORDER BY does, and which uses ix_chat_messages_thread. The client
         still sends one opaque id; the pair is looked up here, one indexed hit
         on the primary key. */
      cursorSql = `AND (m.created_at, m.id) <
                     (SELECT b.created_at, b.id FROM chat_messages b
                       WHERE b.id = $${qp.length} AND b.conversation_id = $1)`;
    }

    let searchSql = '';
    /* Search finds MESSAGES. A `renamed` system line keeps the new title in
       `body`, so without the second condition searching a group for its own name
       returns the line announcing it — a result that is not a message and cannot
       be replied to, reacted to or quoted. */
    if (q.length >= 2) {
      qp.push(`%${q}%`);
      searchSql = `AND m.system_event IS NULL AND m.body ILIKE $${qp.length}`;
    }

    const r = await pool.query(
      `SELECT m.id, m.sender_id, u.name AS sender_name,
              CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.body END AS body,
              m.ref_type, m.ref_id,
              m.created_at, m.edited_at,
              (m.deleted_at IS NOT NULL) AS deleted,
              (m.sender_id = $2) AS mine,
              m.reply_to_id,
              /* The system line, as its parts. The sentence is assembled by the
                 client from system_event, sender_name and system_target — never
                 stored — so somebody who changes their name does not leave a
                 thread quoting the old one. A rename is the exception and its new
                 title rides in the body, because the title on the day it changed
                 is history: looking it up live would print today's name onto that
                 day. */
              m.system_event,
              m.system_target_id,
              ut.name AS system_target,
              ${REPLY_SQL} AS reply_to,
              ${REACTIONS_SQL} AS reactions
         FROM chat_messages m
         JOIN users u ON u.id = m.sender_id
         LEFT JOIN users ut ON ut.id = m.system_target_id
        WHERE m.conversation_id = $1 ${cursorSql} ${searchSql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit + 1}`,
      qp
    );

    /* How far everybody else has got — ONE row for the page, not per message.
       The client turns these two timestamps into a tick per bubble. */
    const peers = await pool.query(PEER_CURSORS_SQL, [id, req.user.id]);

    const hasMore = r.rows.length > limit;
    const rows = hasMore ? r.rows.slice(0, limit) : r.rows;

    /* ── The delivery cursor ─────────────────────────────────────────────
       Written on EVERY fetch, visible tab or not: "their app has it". read_at
       below is written only when somebody is actually looking. That one
       condition is the whole difference between two grey ticks and two teal
       ones, and it already existed for a different reason. */
    /* A SEARCH is not a read of the thread — it is a filtered view of part of
       it — so neither cursor moves. Marking a search result delivered would tell
       the sender their message arrived because somebody searched for a word in
       it. */
    if (!searchSql) pool.query(
      `INSERT INTO chat_reads (user_id, conversation_id, delivered_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id)
       DO UPDATE SET delivered_at = NOW()`,
      [req.user.id, id]
    ).catch((e) => console.error('[chat] delivery cursor:', e.message));

    // Oldest-first is what a thread renders; the query is newest-first because
    // that is the only direction a keyset page can be taken from.
    res.json({
      items: rows.reverse(),
      has_more: hasMore,
      searched: !!searchSql,
      peer_read_at: peers.rows[0]?.peer_read_at || null,
      peer_delivered_at: peers.rows[0]?.peer_delivered_at || null,
      peer_count: peers.rows[0]?.peer_count ?? 0,
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Writes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/chat/conversations
 *
 * One person → a direct conversation. Two or more → a group, which needs a
 * title.
 *
 * ── The double-click ─────────────────────────────────────────────────────
 * Two requests for the same pair arriving together must not produce two
 * threads, and the window for that is not theoretical: it is one impatient
 * click on "Message Aman". ON CONFLICT DO NOTHING then re-select, so the loser
 * of the race gets the winner's row instead of an error or a duplicate. The
 * unique index does the actual work; this just makes losing graceful.
 */
function createConversation(req, res, next) {
  handle(req, res, next, async () => {
    const d = createSchema.parse(req.body);

    const others = [...new Set(d.user_ids.filter((u) => u !== req.user.id))];
    if (!others.length) {
      return res.status(400).json({ error: 'Pick somebody other than yourself' });
    }
    const isDirect = others.length === 1;
    if (!isDirect && !d.title) {
      return res.status(400).json({ error: 'A group conversation needs a name' });
    }
    /* One other person AND a title is refused rather than quietly resolved.
       It used to drop the title and hand back the existing direct thread, which
       is the worst of both: the caller asked for a new named conversation and
       got an old unnamed one, with a 200 and no hint that anything was ignored.
       chat_conversations_title_shape says a direct conversation has no name; the
       API should say the same thing rather than paper over it. */
    if (isDirect && d.title) {
      return res.status(400).json({
        error: 'A conversation with one person is a direct message and cannot be named. '
             + 'Add somebody else to make it a group.',
      });
    }

    /* Everybody named must be a real, active staff account. Checked here and
       not left to the foreign key, because an FK violation surfaces as a 500
       and because hub accounts and deactivated logins are not FK failures at
       all — they are perfectly valid users who must not be added. */
    const ck = await pool.query(
      `SELECT id FROM users
        WHERE id = ANY($1::int[]) AND is_active = TRUE AND hub_id IS NULL`,
      [others]
    );
    if (ck.rowCount !== others.length) {
      return res.status(400).json({ error: 'One or more of those people cannot be messaged' });
    }

    const members = [req.user.id, ...others];
    const key = isDirect ? dmKey(req.user.id, others[0]) : null;

    const client = await pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');

      let convId;
      if (isDirect) {
        const ins = await client.query(
          `INSERT INTO chat_conversations (kind, dm_key, created_by)
           VALUES ('direct', $1, $2)
           ON CONFLICT (dm_key) WHERE kind = 'direct' DO NOTHING
           RETURNING id`,
          [key, req.user.id]
        );
        if (ins.rowCount) {
          convId = ins.rows[0].id;
        } else {
          // Lost the race, or it already existed. Either way this is the
          // conversation they asked for.
          const ex = await client.query(
            `SELECT id FROM chat_conversations WHERE dm_key = $1 AND kind = 'direct'`,
            [key]
          );
          convId = ex.rows[0].id;
          await client.query('COMMIT');
          client.release(); released = true;
          return res.status(200).json({ id: convId, existing: true });
        }
      } else {
        const ins = await client.query(
          `INSERT INTO chat_conversations (kind, title, created_by)
           VALUES ('group', $1, $2) RETURNING id`,
          [d.title, req.user.id]
        );
        convId = ins.rows[0].id;
      }

      // $1 = conversation, $2 = who added them, $3.. = the members themselves.
      const values = members.map((_, i) => `($1, $${i + 3}, $2)`).join(', ');
      await client.query(
        `INSERT INTO chat_participants (conversation_id, user_id, added_by)
         VALUES ${values}
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [convId, req.user.id, ...members]
      );

      await client.query('COMMIT');
      client.release(); released = true;

      emitInvalidateTo(members, 'chat', req);
      res.status(201).json({ id: convId, existing: false });
    } catch (err) {
      if (!released) { try { await client.query('ROLLBACK'); } catch { /* already gone */ } }
      throw err;
    } finally {
      if (!released) client.release();
    }
  });
}

/**
 * POST /api/chat/conversations/:id/messages
 *
 * ══ THE POOL SHAPE, AND WHY THE ORDER OF THE LAST FOUR LINES MATTERS ═══════
 *
 * Inside the transaction: insert the message, move last_message_at, and READ
 * THE PARTICIPANT IDS.
 *
 * Outside it, after release(): emit, then push.
 *
 * The participant ids are read inside and used outside because the push fan-out
 * opens its own connections — sendPush queries `users` for
 * notification_settings and then `push_subscriptions` — and doing that while
 * still holding this one is the exact pool-exhaustion shape test_pool exists to
 * catch. On max: 10, ten people sending at once while each holds a connection
 * and waits for a second is a deadlock, not a slowdown.
 */
function sendMessage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = sendSchema.parse(req.body);
    const body = d.body?.trim() || null;

    const client = await pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');

      const member = await readMembership(client, id, req.user.id);
      if (!member) {
        await client.query('ROLLBACK');
        client.release(); released = true;
        return notFound(res);
      }
      /* Archived is read-only, and this is the route where that has to be true
         first. Thrown rather than returned so the rollback in catch runs — a
         bare `return res.status(409)` here would leave an open transaction
         holding a pooled connection until the idle timeout, which on max: 10 is
         nine more of those away from the whole app stalling. */
      if (member.archived_at) {
        const e = new Error('This conversation is archived. Restore it to write in it.');
        e.status = 409;
        throw e;
      }

      /* The quoted message must be in THIS conversation. Without the second
         condition somebody could quote a message from a thread they are in into
         a thread they are also in — carrying a preview of it across, which is a
         leak with extra steps. Silently dropped rather than refused: the reply
         itself is still what they meant to send. */
      let replyTo = null;
      if (d.reply_to_id) {
        const rt = await client.query(
          `SELECT id FROM chat_messages WHERE id = $1 AND conversation_id = $2`,
          [d.reply_to_id, id]
        );
        replyTo = rt.rows[0]?.id || null;
      }

      const ins = await client.query(
        `INSERT INTO chat_messages (conversation_id, sender_id, body, ref_type, ref_id, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [id, req.user.id, body, d.ref_type || null, d.ref_id || null, replyTo]
      );

      await client.query(
        `UPDATE chat_conversations SET last_message_at = $2 WHERE id = $1`,
        [id, ins.rows[0].created_at]
      );

      /* Sending is reading: the sender has by definition seen their own
         message, and without this their own send would leave their own
         conversation looking unread until they clicked it. */
      await client.query(
        `INSERT INTO chat_reads (user_id, conversation_id, read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET read_at = NOW()`,
        [req.user.id, id]
      );

      const participants = await readParticipantIds(client, id);

      await client.query('COMMIT');
      client.release(); released = true;

      // ── Nothing below this line holds a connection from the pool. ──
      emitInvalidateTo(participants, 'chat', req);

      res.status(201).json({
        item: {
          id: ins.rows[0].id,
          sender_id: req.user.id,
          sender_name: req.user.name,
          body,
          ref_type: d.ref_type || null,
          ref_id: d.ref_id || null,
          reply_to_id: replyTo,
          created_at: ins.rows[0].created_at,
          edited_at: null,
          deleted: false,
          mine: true,
        },
      });
    } catch (err) {
      if (!released) { try { await client.query('ROLLBACK'); } catch { /* already gone */ } }
      throw err;
    } finally {
      if (!released) client.release();
    }
  });
}

/**
 * PATCH /api/chat/messages/:id — fix a typo, not rewrite history.
 *
 * Author only, and only within EDIT_WINDOW_MIN. An unlimited edit means the
 * message somebody replied to can be changed into something else afterwards,
 * which makes the reply look like an answer to a question nobody asked. The
 * window is short enough that nothing has been acted on yet.
 *
 * MANAGE_CHAT does not grant this. Moderating means removing something, never
 * altering what somebody is recorded as having said.
 */
const EDIT_WINDOW_MIN = 15;

function editMessage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const body = z.string().trim().min(1, 'A message cannot be empty')
                  .max(MAX_BODY).parse(req.body?.body);

    const m = await pool.query(
      `SELECT m.id, m.sender_id, m.deleted_at, m.created_at, m.ref_type,
              m.system_event, c.archived_at
         FROM chat_messages m
         JOIN chat_participants p
           ON p.conversation_id = m.conversation_id
          AND p.user_id = $2 AND p.left_at IS NULL
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1`,
      [id, req.user.id]
    );
    if (!m.rowCount) return res.status(404).json({ error: 'Message not found' });
    const row = m.rows[0];

    if (row.archived_at) {
      return res.status(409).json({
        error: 'This conversation is archived. Restore it to write in it.',
      });
    }
    /* A system line has a sender_id — the person who did the thing — so without
       this the actor passes the author check below and can rewrite "Ana added
       Ben" into anything at all. The line is a record of an event, not something
       anybody typed, and nothing in the thread should be editable into a
       different kind of thing than it started as. */
    if (row.system_event) {
      return res.status(409).json({ error: 'That is a system message and cannot be edited' });
    }
    if (row.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }
    if (row.deleted_at) {
      return res.status(409).json({ error: 'That message was deleted' });
    }
    const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
    if (ageMin > EDIT_WINDOW_MIN) {
      return res.status(409).json({
        error: `A message can only be edited within ${EDIT_WINDOW_MIN} minutes of sending it`,
      });
    }

    const up = await pool.query(
      `UPDATE chat_messages SET body = $2, edited_at = NOW()
        WHERE id = $1 RETURNING conversation_id, edited_at`,
      [id, body]
    );
    const participants = await readParticipantIds(pool, up.rows[0].conversation_id);
    emitInvalidateTo(participants, 'chat', req);
    res.json({ ok: true, edited_at: up.rows[0].edited_at });
  });
}

/**
 * DELETE /api/chat/messages/:id — soft.
 *
 * The author always may. A MANAGE_CHAT holder may too, and that is the only
 * thing that permission does here: it must still be a live participant of the
 * conversation, so it is a moderator's power over a room they are in, not a
 * way into a room they are not.
 */
function deleteMessage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const m = await pool.query(
      `SELECT m.id, m.sender_id, m.conversation_id, m.deleted_at,
              m.system_event, c.archived_at
         FROM chat_messages m
         JOIN chat_participants p
           ON p.conversation_id = m.conversation_id
          AND p.user_id = $2 AND p.left_at IS NULL
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1`,
      [id, req.user.id]
    );
    if (!m.rowCount) return res.status(404).json({ error: 'Message not found' });
    const row = m.rows[0];

    if (row.archived_at) {
      return res.status(409).json({
        error: 'This conversation is archived. Restore it to change anything in it.',
      });
    }
    /* Not even MANAGE_CHAT. Deleting "Ben was removed" leaves a thread where
       somebody's messages stop for no stated reason, which is the exact
       confusion the system line exists to prevent — and a moderator able to
       erase the record of their own moderation is not a moderator, it is an
       unlogged one. */
    if (row.system_event) {
      return res.status(409).json({ error: 'That is a system message and cannot be deleted' });
    }
    if (row.sender_id !== req.user.id && !isModerator(req.user)) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }
    if (row.deleted_at) return res.json({ ok: true });   // idempotent

    /* The body is NULLED, not kept alongside a flag. A deleted message that
       still holds its text is a deleted message in name only — one query away
       from being read, and the person who deleted it believes it is gone.
       The POINTER goes too. A share-only message whose ref survived the delete
       would keep rendering its chip, so the record stays named in the thread
       after the message naming it was withdrawn — which is most of what was
       being withdrawn.
       Both nulls are why chat_messages_has_content exempts deleted rows. */
    await pool.query(
      `UPDATE chat_messages
          SET deleted_at = NOW(), body = NULL, ref_type = NULL, ref_id = NULL
        WHERE id = $1`,
      [id]
    );
    const participants = await readParticipantIds(pool, row.conversation_id);
    emitInvalidateTo(participants, 'chat', req);
    res.json({ ok: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Cursors and membership
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/chat/conversations/:id/read */
function markRead(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    if (!(await readMembership(pool, id, req.user.id))) return notFound(res);
    await pool.query(
      `INSERT INTO chat_reads (user_id, conversation_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET read_at = NOW()`,
      [req.user.id, id]
    );
    /* No socket emit. Reading is a private act with no consequence for anybody
       else's screen, and nudging the other participants would have every tab in
       the conversation re-fetch every time somebody glanced at it. */
    res.json({ ok: true });
  });
}

/**
 * POST /api/chat/conversations/:id/dismiss — clear it from my list.
 *
 * Sets BOTH cursors. Dismissing without also marking read would leave a
 * conversation hidden from the list while still counted in the badge, which is
 * a number pointing at something the person cannot see.
 */
function dismiss(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    if (!(await readMembership(pool, id, req.user.id))) return notFound(res);
    await pool.query(
      `INSERT INTO chat_reads (user_id, conversation_id, read_at, dismissed_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, conversation_id)
       DO UPDATE SET read_at = NOW(), dismissed_at = NOW()`,
      [req.user.id, id]
    );
    res.json({ ok: true });
  });
}

/** PATCH /api/chat/conversations/:id/mute — stop buzzing my phone. */
function setMuted(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const muted = z.boolean().parse(req.body?.muted);
    if (!(await readMembership(pool, id, req.user.id))) return notFound(res);
    await pool.query(
      `UPDATE chat_participants SET muted = $3
        WHERE conversation_id = $1 AND user_id = $2`,
      [id, req.user.id, muted]
    );
    res.json({ muted });
  });
}

/**
 * POST /api/chat/conversations/:id/participants — groups only.
 *
 * A direct conversation cannot gain a third person. Its identity IS the pair,
 * enforced by dm_key, and adding somebody would leave a two-person key on a
 * three-person thread — after which the next attempt to open that pair's DM
 * would return this group instead.
 */
function addParticipants(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const ids = z.array(z.coerce.number().int().positive()).min(1).max(50)
                 .parse(req.body?.user_ids);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);
    if (member.kind === 'direct') {
      return res.status(409).json({
        error: 'A direct conversation is between two people. Start a group instead.',
      });
    }
    assertWritable(member);
    /* ── THIS CHECK IS NEW, AND IT CLOSES AN INCONSISTENCY ────────────────
       Before, ANY member could add anybody, while removing required
       MANAGE_CHAT. So a member could add a colleague to a group and then be
       unable to undo it — and could not be stopped from adding the whole company
       one at a time. Adding somebody to a private conversation is exactly as
       consequential as removing them: it decides who can read what was already
       said in there. Same rule for both, and the rule lives in canManage(). */
    if (!canManage(req.user, member)) {
      return res.status(403).json({
        error: 'Only the person who created this group, or a chat manager, can change who is in it',
      });
    }

    const ck = await pool.query(
      `SELECT id, name FROM users
        WHERE id = ANY($1::int[]) AND is_active = TRUE AND hub_id IS NULL`,
      [ids]
    );
    if (ck.rowCount !== new Set(ids).size) {
      return res.status(400).json({ error: 'One or more of those people cannot be added' });
    }

    const fresh = [...new Set(ids)];

    /* ── Who was ACTUALLY added ───────────────────────────────────────────
       Adding somebody already in the group is a no-op, and a no-op must not
       write "Ana added Ben" into the thread for the second time. So the upsert
       reports which rows it really changed — `xmax = 0` is the standard way to
       tell an INSERT from an ON CONFLICT UPDATE in the same RETURNING — and only
       those get a line. Re-adding somebody who LEFT does count as a change, and
       should say so.
       Re-adding clears left_at rather than inserting, because the primary key is
       (conversation_id, user_id) and their old row is still there holding the
       history of their first stint. */
    const values = fresh.map((_, i) => `($1, $${i + 3}, $2)`).join(', ');
    const up = await pool.query(
      `INSERT INTO chat_participants (conversation_id, user_id, added_by)
       VALUES ${values}
       ON CONFLICT (conversation_id, user_id)
       DO UPDATE SET left_at = NULL, added_by = $2, joined_at = NOW()
         WHERE chat_participants.left_at IS NOT NULL
       RETURNING user_id`,
      [id, req.user.id, ...fresh]
    );

    for (const r of up.rows) {
      await writeSystemLine(pool, id, req.user.id, 'added', { targetId: r.user_id });
    }

    const participants = await readParticipantIds(pool, id);
    emitInvalidateTo(participants, 'chat', req);
    res.json({ ok: true, added: up.rows.map((r) => r.user_id) });
  });
}

/**
 * DELETE /api/chat/conversations/:id/participants/:userId
 *
 * Yourself always. Somebody else only with MANAGE_CHAT. Sets left_at — see the
 * COMMENT in migration 197 for why the row is kept.
 */
function removeParticipant(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const target = idParam.parse(req.params.userId);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);
    if (member.kind === 'direct') {
      return res.status(409).json({
        error: 'A direct conversation cannot be left. Clear it from your list instead.',
      });
    }

    /* Leaving is always yours to do — including when the group is archived, and
       including when you cannot manage it. Removing SOMEBODY ELSE is management,
       and now matches adding them: the creator, or MANAGE_CHAT. */
    const leaving = target === req.user.id;
    if (!leaving) {
      assertWritable(member);
      if (!canManage(req.user, member)) {
        return res.status(403).json({
          error: 'Only the person who created this group, or a chat manager, can remove somebody else',
        });
      }
    }

    // Read the recipients BEFORE the removal: the person being removed should
    // be told they were, and after the UPDATE they are no longer in the list.
    const participants = await readParticipantIds(pool, id);

    const up = await pool.query(
      `UPDATE chat_participants SET left_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [id, target]
    );
    if (!up.rowCount) return res.status(404).json({ error: 'That person is not in this conversation' });

    /* Two different events, and the difference matters to whoever reads it
       later: "Ben left" and "Ana removed Ben" are not the same fact about Ben.
       Skipped entirely on an archived thread, which somebody may still leave —
       writing into it would break the read-only promise for the one case where
       it is least important. */
    if (!member.archived_at) {
      await writeSystemLine(pool, id, req.user.id,
        leaving ? 'left' : 'removed', { targetId: target });
    }

    emitInvalidateTo(participants, 'chat', req);
    res.json({ ok: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Managing the conversation itself
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PATCH /api/chat/conversations/:id   body: { title }
 *
 * Groups only — chat_conversations_title_shape says a direct thread has no
 * title, and "two people who have renamed each other" is a different feature.
 *
 * The rename is announced in the thread, with the NEW title in the line's body.
 * A rename nobody can see is how a group everybody knows as "Bay 3" quietly
 * becomes something else in one person's list.
 */
function renameConversation(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const title = z.string().trim().min(1, 'A group needs a name').max(120)
                   .parse(req.body?.title);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);
    if (member.kind !== 'group') {
      return res.status(409).json({ error: 'A direct conversation cannot be renamed' });
    }
    assertWritable(member);
    if (!canManage(req.user, member)) {
      return res.status(403).json({
        error: 'Only the person who created this group, or a chat manager, can rename it',
      });
    }
    /* Renaming to the same name writes nothing and announces nothing. Somebody
       fixing a stray space and saving twice should not leave two lines in the
       thread saying the name changed when it did not. */
    if (member.title === title) return res.json({ ok: true, title, unchanged: true });

    await pool.query(`UPDATE chat_conversations SET title = $2 WHERE id = $1`, [id, title]);
    await writeSystemLine(pool, id, req.user.id, 'renamed', { body: title });

    emitInvalidateTo(await readParticipantIds(pool, id), 'chat', req);
    res.json({ ok: true, title });
  });
}

/**
 * PATCH /api/chat/conversations/:id/archive   body: { archived: true|false }
 *
 * The normal way a group ends. It leaves everybody's list, goes read-only for
 * everybody — see assertWritable, which does not exempt MANAGE_CHAT — and can be
 * restored, at which point the thread says who did each.
 *
 * Not for direct threads. Two people own a DM equally and neither gets to put
 * the other's messages beyond reach; clearing it from your own list is the whole
 * of what one person decides. chat_conversations_archive_shape enforces the same
 * thing one layer down, so this is not the only thing preventing it.
 */
function setArchived(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const archived = z.boolean().parse(req.body?.archived);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);
    if (member.kind !== 'group') {
      return res.status(409).json({
        error: 'A direct conversation cannot be archived. Clear it from your list instead.',
      });
    }
    /* Deliberately NOT assertWritable: un-archiving is the one write an archived
       conversation must accept, or it is a one-way door. */
    if (!canManage(req.user, member)) {
      return res.status(403).json({
        error: 'Only the person who created this group, or a chat manager, can archive it',
      });
    }
    if (!!member.archived_at === archived) {
      return res.json({ ok: true, archived, unchanged: true });
    }

    /* The line is written BEFORE archiving and AFTER restoring, so in both cases
       it lands in a thread that is writable at the moment it is written. Writing
       "archived" into an already-archived thread would be the one write that
       breaks its own rule. */
    if (!archived) {
      await pool.query(
        `UPDATE chat_conversations SET archived_at = NULL WHERE id = $1`, [id]);
      await writeSystemLine(pool, id, req.user.id, 'restored');
    } else {
      await writeSystemLine(pool, id, req.user.id, 'archived');
      await pool.query(
        `UPDATE chat_conversations SET archived_at = NOW(), archived_by = $2 WHERE id = $1`,
        [id, req.user.id]);
    }

    emitInvalidateTo(await readParticipantIds(pool, id), 'chat', req);
    res.json({ ok: true, archived });
  });
}

/**
 * DELETE /api/chat/conversations/:id?confirm=<the group's exact name>
 *
 * ══ THE MOST DESTRUCTIVE ROUTE IN THIS FEATURE ═════════════════════════════
 *
 * chat_participants, chat_messages, chat_reads and chat_message_reactions all
 * reference their parent ON DELETE CASCADE, so this is one statement that
 * removes a group and everything anybody ever said in it. There is no undo, no
 * recycle bin, and nothing anywhere else that holds a copy.
 *
 * Three things stand in front of it, and each is there for a different reason:
 *
 *   MANAGE_CHAT, not the creator. Archiving is the creator's call because it is
 *   reversible. Destroying other people's writing is not something you get for
 *   having started the thread.
 *
 *   `confirm` must equal the group's exact title. A typed name is the difference
 *   between meaning to delete THIS group and having a delete request arrive with
 *   the wrong id in it.
 *
 *   Groups only. A direct thread's messages belong to two people and neither can
 *   destroy the other's.
 */
function destroyConversation(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const confirm = String(req.query.confirm ?? req.body?.confirm ?? '');

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);

    if (!isModerator(req.user)) {
      return res.status(403).json({
        error: 'Deleting a conversation permanently needs the MANAGE_CHAT permission',
      });
    }

    /* ── WHAT HAS TO BE TYPED ────────────────────────────────────────────
       A group is confirmed by its own name. A direct conversation has none —
       chat_conversations_title_shape forbids it — so the confirmation is the
       OTHER PERSON'S name, which is what the row is called on screen anyway.
       Still a typed string rather than a checkbox, and for the same reason: it
       is the difference between meaning to delete THIS conversation and a
       delete arriving with the wrong id in it. */
    let expect = member.title;
    let label = 'group';
    if (member.kind === 'direct') {
      const o = await pool.query(
        `SELECT u.name FROM chat_participants p
           JOIN users u ON u.id = p.user_id
          WHERE p.conversation_id = $1 AND p.user_id <> $2
          ORDER BY p.user_id LIMIT 1`,
        [id, req.user.id]
      );
      /* A direct thread whose other side was deleted from `users` should not
         become undeletable — and it should not become deletable by typing
         nothing either. */
      expect = o.rows[0]?.name || null;
      label = 'conversation';
      if (!expect) {
        return res.status(409).json({
          error: 'This conversation has no second participant to confirm against',
        });
      }
    }

    if (confirm.trim() !== String(expect)) {
      return res.status(400).json({
        error: member.kind === 'direct'
          ? 'Type the other person\'s exact name to confirm deleting this conversation permanently'
          : 'Type the group\'s exact name to confirm deleting it permanently',
      });
    }

    /* The recipients are read BEFORE the delete: after it there is no
       chat_participants row left to read them from, and the people whose list
       this conversation is about to vanish from are exactly the ones who need
       telling. */
    const participants = await readParticipantIds(pool, id);
    await pool.query(`DELETE FROM chat_conversations WHERE id = $1`, [id]);

    console.warn(`[chat] ${label} ${id} ("${expect}") permanently deleted `
      + `by user ${req.user.id}`);
    emitInvalidateTo(participants, 'chat', req);
    res.json({ ok: true, deleted: true });
  });
}

/**
 * DELETE /api/chat/conversations/:id/my-messages
 *
 * ══ WITHDRAW EVERYTHING I SAID IN HERE ═════════════════════════════════════
 *
 * Exactly the message-level delete, applied to every message the caller sent in
 * one conversation. The same UPDATE, the same nulls: the text and the record
 * pointer are gone immediately and the rows stay as "Message deleted", so the
 * thread does not renumber and replies still have something to sit under.
 *
 * ── Why this needs no new permission ──
 * The author may already delete each of their own messages, one at a time. This
 * changes the EFFORT, not the authority — and a rule that depends on somebody
 * being willing to click two hundred times is not a rule, it is a speed bump.
 *
 * ── Why it does not touch anybody else's messages ──
 * `sender_id = $2` is the whole of it. The other person's words are theirs; a
 * participant who wants the entire thread gone is asking for something only
 * MANAGE_CHAT can do, and that is destroyConversation.
 *
 * Allowed in a group as well as a DM. The capability is identical either way,
 * and refusing it in a group would mean the same person could still do it one
 * message at a time — an arbitrary line that only punishes long threads.
 */
function deleteMyMessages(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);
    assertWritable(member);

    /* Same nulls as deleteMessage, and for the same reasons written out there:
       a deleted message that keeps its text is deleted in name only, and a
       pointer that survives keeps naming the record in a thread the message
       naming it was withdrawn from.
       System lines are excluded — they are not anybody's messages to withdraw,
       and "Ana added Ben" disappearing when Ana tidies up her own words would
       leave a group with a member nobody can explain. */
    const r = await pool.query(
      `UPDATE chat_messages
          SET deleted_at = NOW(), body = NULL, ref_type = NULL, ref_id = NULL
        WHERE conversation_id = $1
          AND sender_id = $2
          AND deleted_at IS NULL
          AND system_event IS NULL`,
      [id, req.user.id]
    );

    if (r.rowCount) {
      emitInvalidateTo(await readParticipantIds(pool, id), 'chat', req);
    }
    res.json({ ok: true, deleted: r.rowCount });
  });
}

/**
 * PATCH /api/chat/conversations/:id/pin   body: { pinned: true|false }
 *
 * Per user, on the participant row. Nobody else sees it, and pinning an archived
 * group is allowed and harmless — the archived view does not sort by pins and the
 * live list does not contain it, so the pin simply waits for it to be restored.
 */
function setPinned(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const pinned = z.boolean().parse(req.body?.pinned);

    const member = await readMembership(pool, id, req.user.id);
    if (!member) return notFound(res);

    /* The cap is what makes prepending pins to the first page safe — see
       PINNED_ONLY_SQL. Enforced on the way in, so the list never has to decide
       what to do with an eleventh one. Counted only when turning a pin ON, and
       an already-pinned conversation is not a new pin. */
    if (pinned && !member.pinned_at) {
      const n = await pool.query(
        `SELECT COUNT(*)::int AS n FROM chat_participants
          WHERE user_id = $1 AND left_at IS NULL AND pinned_at IS NOT NULL`,
        [req.user.id]
      );
      if (n.rows[0].n >= MAX_PINS) {
        return res.status(409).json({
          error: `You can pin up to ${MAX_PINS} conversations. Unpin one first.`,
        });
      }
    }

    await pool.query(
      `UPDATE chat_participants SET pinned_at = ${pinned ? 'NOW()' : 'NULL'}
        WHERE conversation_id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    /* No emit. A pin changes one person's own ordering and nobody else's screen. */
    res.json({ pinned });
  });
}

/**
 * POST /api/chat/messages/:id/forward   body: { conversation_id }
 *
 * ══ FORWARDING IS A NEW SEND, NOT A COPY ═══════════════════════════════════
 *
 * The row that lands in the destination has the FORWARDER as its sender, its own
 * timestamp, and no reply_to. It is not a duplicate of somebody else's message
 * wearing their name in a room they are not in — which is what "forward" means
 * in a feature where membership is the whole access model.
 *
 * ── Both ends are checked, separately ──
 * Membership of the SOURCE, because you cannot forward what you cannot read.
 * Membership of the DESTINATION, because you cannot write where you are not. A
 * route that checked only one of those is a way to move a private message into a
 * room of your choosing, or out of one.
 *
 * ── What travels ──
 * The text and the record pointer. The pointer is safe to carry precisely
 * because it is only a pointer: chatRefs.service.js resolves it per viewer
 * against that record's own permission, so forwarding an estimate into a group
 * does not show it to anybody who could not already open it. A deleted message
 * has nothing to carry and a system line was never anybody's to forward.
 */
function forwardMessage(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const to = idParam.parse(req.body?.conversation_id);

    const m = await pool.query(
      `SELECT m.id, m.body, m.ref_type, m.ref_id, m.deleted_at, m.system_event
         FROM chat_messages m
         JOIN chat_participants p
           ON p.conversation_id = m.conversation_id
          AND p.user_id = $2 AND p.left_at IS NULL
        WHERE m.id = $1`,
      [id, req.user.id]
    );
    if (!m.rowCount) return res.status(404).json({ error: 'Message not found' });
    const src = m.rows[0];
    if (src.deleted_at) {
      return res.status(409).json({ error: 'That message was deleted' });
    }
    if (src.system_event) {
      return res.status(409).json({ error: 'A system message cannot be forwarded' });
    }

    const dest = await readMembership(pool, to, req.user.id);
    if (!dest) return notFound(res);
    assertWritable(dest);

    const ins = await pool.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, body, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [to, req.user.id, src.body, src.ref_type, src.ref_id]
    );
    await pool.query(
      `UPDATE chat_conversations SET last_message_at = $2 WHERE id = $1`,
      [to, ins.rows[0].created_at]
    );
    /* Forwarding is reading, same as sending: the forwarder has seen what they
       just put there, and without this their own forward leaves the destination
       looking unread to them. */
    await pool.query(
      `INSERT INTO chat_reads (user_id, conversation_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET read_at = NOW()`,
      [req.user.id, to]
    );

    emitInvalidateTo(await readParticipantIds(pool, to), 'chat', req);
    res.status(201).json({ id: ins.rows[0].id, conversation_id: to });
  });
}

/* ── Reactions ───────────────────────────────────────────────────────────── */

/* Six, and the list is here as well as in the CHECK constraint on purpose: the
   API should refuse a seventh with a 400 that names the six, rather than letting
   Postgres raise a constraint violation that surfaces as a 500. Two lists that
   must agree, and test19 asserts they do. */
const REACTIONS = ['up', 'heart', 'haha', 'wow', 'sad', 'thanks'];

/**
 * POST /api/chat/messages/:id/reactions   body: { reaction }
 *
 * TOGGLES. One call, and the same call again takes it off — which is what every
 * reaction UI does, and it means a double-tap cannot leave two.
 *
 * Deliberately not two endpoints. An explicit add/remove pair needs the client to
 * know the current state to choose between them, and on a thread being updated by
 * a socket nudge that state is a guess: two people reacting at once would have one
 * of them "adding" something already there.
 */
function toggleReaction(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const reaction = z.enum(REACTIONS, {
      errorMap: () => ({ message: `reaction must be one of: ${REACTIONS.join(', ')}` }),
    }).parse(req.body?.reaction);

    /* Membership is checked through the MESSAGE, so a caller cannot pair a
       message id with a conversation they happen to be in. Same shape as
       editMessage and deleteMessage. */
    const m = await pool.query(
      `SELECT m.id, m.conversation_id, m.deleted_at, m.system_event, c.archived_at
         FROM chat_messages m
         JOIN chat_participants p
           ON p.conversation_id = m.conversation_id
          AND p.user_id = $2 AND p.left_at IS NULL
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1`,
      [id, req.user.id]
    );
    if (!m.rowCount) return res.status(404).json({ error: 'Message not found' });
    if (m.rows[0].deleted_at) {
      return res.status(409).json({ error: 'That message was deleted' });
    }
    if (m.rows[0].archived_at) {
      return res.status(409).json({
        error: 'This conversation is archived. Restore it to react in it.',
      });
    }
    /* Reacting to "Ben was removed" is not a thing the UI offers, and the
       constraint is here rather than only there because a reaction row on a
       system line renders a pill under a line that has no author to react to. */
    if (m.rows[0].system_event) {
      return res.status(409).json({ error: 'You cannot react to a system message' });
    }

    /* DELETE first, then INSERT if nothing went. One round trip either way and
       no read-then-write race: two tabs toggling together end up with the pair
       either present or absent, never duplicated — the primary key guarantees
       that much whatever order they arrive in. */
    const gone = await pool.query(
      `DELETE FROM chat_message_reactions
        WHERE message_id = $1 AND user_id = $2 AND reaction = $3`,
      [id, req.user.id, reaction]
    );
    let on = false;
    if (!gone.rowCount) {
      await pool.query(
        `INSERT INTO chat_message_reactions (message_id, user_id, reaction)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, req.user.id, reaction]
      );
      on = true;
    }

    const now = await pool.query(
      `SELECT reaction, COUNT(*)::int AS count,
              BOOL_OR(user_id = $2) AS mine
         FROM chat_message_reactions
        WHERE message_id = $1
        GROUP BY reaction ORDER BY reaction`,
      [id, req.user.id]
    );

    const participants = await readParticipantIds(pool, m.rows[0].conversation_id);
    emitInvalidateTo(participants, 'chat', req);
    res.json({ on, reactions: now.rows });
  });
}

/**
 * GET /api/chat/messages/:id/reactions — who, by name.
 *
 * Asked for on hover, never shipped with the page: fifty messages times six
 * reactions times every name is most of the payload and nobody reads it until
 * they point at one.
 */
function listReactors(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const m = await pool.query(
      `SELECT 1 FROM chat_messages m
         JOIN chat_participants p
           ON p.conversation_id = m.conversation_id
          AND p.user_id = $2 AND p.left_at IS NULL
        WHERE m.id = $1`,
      [id, req.user.id]
    );
    if (!m.rowCount) return res.status(404).json({ error: 'Message not found' });

    const r = await pool.query(
      `SELECT cr.reaction, u.id, u.name
         FROM chat_message_reactions cr
         JOIN users u ON u.id = cr.user_id
        WHERE cr.message_id = $1
        ORDER BY cr.reaction, u.name`,
      [id]
    );
    res.json({ items: r.rows });
  });
}

/**
 * GET /api/chat/conversations/:id/pending-readers?up_to=<iso>
 *
 * Who has not read up to that moment. Powers the hover on a group's ticks —
 * "waiting on Ravi" is worth more than two grey ticks and no idea who.
 */
function pendingReaders(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const upTo = new Date(req.query.up_to || Date.now());
    if (Number.isNaN(upTo.getTime())) {
      return res.status(400).json({ error: 'up_to must be a timestamp' });
    }
    if (!(await readMembership(pool, id, req.user.id))) return notFound(res);
    res.json({ items: await readPendingReaders(pool, id, req.user.id, upTo) });
  });
}

module.exports = {
  unreadCount,
  toggleReaction,
  listReactors,
  pendingReaders,
  REACTIONS,
  listConversations,
  getConversation,
  listMessages,
  createConversation,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  dismiss,
  setMuted,
  addParticipants,
  removeParticipant,
  listParticipants,
  deleteMyMessages,
  renameConversation,
  setArchived,
  destroyConversation,
  setPinned,
  forwardMessage,
  MAX_BODY,
  EDIT_WINDOW_MIN,
};
