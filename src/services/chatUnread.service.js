'use strict';

/**
 * chatUnread.service.js — the SQL the badge and the list both use.
 *
 * ══ WHY THIS IS A FILE AND NOT TWO QUERIES ═════════════════════════════════
 *
 * whatsapp.inbox.controller.js says it in one line and it is worth repeating:
 * a count and a list built from two different FROM clauses is how a badge
 * saying 3 ends up over a dropdown with 2 rows in it. Nobody can debug that,
 * because each query is correct on its own.
 *
 * So: one FROM, one unread predicate, one definition of "mine", exported as
 * strings and composed by the controller. $1 is ALWAYS the acting user's id.
 *
 * ══ WHAT IT COUNTS ═════════════════════════════════════════════════════════
 *
 * CONVERSATIONS with something unread, not unread messages. Borrowed from the
 * WhatsApp badge, whose reasoning transfers exactly: a message count says "17"
 * when one colleague sent seventeen lines about one gearbox, which is one
 * thing to deal with, and it reads as a backlog that does not exist.
 *
 * ══ WHOSE ══════════════════════════════════════════════════════════════════
 *
 * Yours. Only yours. There is no supervisor scope here and that is deliberate.
 *
 * The WhatsApp badge has one — VIEW_LEAD sees every conversation — because
 * those are conversations with CUSTOMERS, an unassigned one is nobody's, and a
 * customer reaching nobody is a business failure the owner has to be able to
 * see. None of that is true of two advisors talking to each other. A private
 * message has exactly one audience and "senior enough to read it" is not a
 * scope, it is a different feature with a different name and its own logging.
 *
 * Every query in this file starts from chat_participants.user_id = $1. A
 * MANAGE_CHAT holder gets the same rows as everybody else.
 */

/* Membership is the whole access model. Not a WHERE clause bolted on — the
   INNER JOIN, so there is no shape of this query that returns a conversation
   the caller is not in. A conversation id from the URL is never trusted on its
   own anywhere in chat.controller.js. */
const FROM_SQL = `
  FROM chat_conversations c
  JOIN chat_participants  p
    ON p.conversation_id = c.id
   AND p.user_id         = $1
   AND p.left_at IS NULL`;

/**
 * Is there anything in this conversation this user has not seen?
 *
 * ── COALESCE to epoch, not a NULL test ───────────────────────────────────
 * A user who has never opened a conversation has no chat_reads row, and that
 * must mean everything in it is unread — not nothing. The missing-row case is
 * the common one: it is every conversation nobody has opened yet.
 *
 * ── sender_id <> $1 ──────────────────────────────────────────────────────
 * The analogue of the WhatsApp badge's `direction = 'in'`, and for the same
 * reason. Without it your own reply lights up your own badge, and since
 * replying is the last thing you do before looking at the badge, it would be
 * wrong almost every time.
 *
 * ── deleted_at IS NULL ───────────────────────────────────────────────────
 * A message somebody sent and then withdrew must not leave a badge lit with
 * nothing behind it to read.
 *
 * ── system_event IS NULL ─────────────────────────────────────────────────
 * The one existing query migration 201 changes, and it is a judgement rather
 * than a technicality. "Ana renamed this to Bay 3" belongs in the thread and
 * does not belong in a badge: nobody has to go back and read it and nothing is
 * waiting on them. A badge that lights for it teaches people the badge does not
 * mean anything, which costs more than the line is worth. System lines still
 * move last_message_at, so the conversation surfaces in the LIST — it just does
 * not claim to be owed a reply.
 */
const UNREAD_SQL = `
  EXISTS (
    SELECT 1
      FROM chat_messages m
     WHERE m.conversation_id = c.id
       AND m.sender_id      <> $1
       AND m.deleted_at IS NULL
       AND m.system_event IS NULL
       AND m.created_at > COALESCE(
             (SELECT r.read_at FROM chat_reads r
               WHERE r.user_id = $1 AND r.conversation_id = c.id),
             TIMESTAMPTZ 'epoch')
  )`;

/**
 * Has this user cleared this conversation from their list?
 *
 * A cursor, not a flag — so a cleared conversation comes BACK the moment
 * somebody writes in it, by arithmetic, with nothing written anywhere and no
 * cleanup for the write path to forget.
 *
 * Compared against the conversation's newest message, not NOW(). The count
 * does not need this at all: clearing sets read_at too, so a cleared
 * conversation has already left the badge by way of UNREAD_SQL.
 */
const HIDDEN_SQL = `
  COALESCE(c.last_message_at, c.created_at) <= COALESCE(
    (SELECT r2.dismissed_at FROM chat_reads r2
      WHERE r2.user_id = $1 AND r2.conversation_id = c.id),
    TIMESTAMPTZ '-infinity')`;

/**
 * The other people in a conversation, as json.
 *
 * Excludes the caller, because "Direct message with Aman and me" is not how
 * anybody refers to it. Includes people who have LEFT a group, flagged, so a
 * thread whose author walked out does not render as a message from nobody.
 */
const PARTICIPANTS_SQL = `
  (SELECT COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
            'id', u2.id, 'name', u2.name, 'left', (p2.left_at IS NOT NULL)
          ) ORDER BY u2.name), '[]'::json)
     FROM chat_participants p2
     JOIN users u2 ON u2.id = p2.user_id
    WHERE p2.conversation_id = c.id
      AND p2.user_id <> $1)`;

/**
 * The newest message, for the list row's preview line.
 *
 * ── The preview is TRUNCATED IN SQL, not in the browser ──────────────────
 * 120 characters. Sending the whole body of every conversation's last message
 * so the CSS can hide most of it puts the full text of a private message into
 * a response the reader is not looking at, and into whatever logs sit between.
 * It is also, on a list of fifty threads, most of the payload.
 *
 * A message that is only a shared record has no body at all, so `has_ref` is
 * how the row knows to say "shared a job card" instead of rendering blank.
 */
const LAST_MESSAGE_SQL = `
  (SELECT JSON_BUILD_OBJECT(
            'id',         m2.id,
            'preview',    CASE WHEN m2.deleted_at IS NOT NULL THEN NULL
                               ELSE LEFT(m2.body, 120) END,
            'truncated',  (m2.deleted_at IS NULL AND LENGTH(COALESCE(m2.body,'')) > 120),
            'deleted',    (m2.deleted_at IS NOT NULL),
            'has_ref',    (m2.ref_type IS NOT NULL),
            'sender_id',  m2.sender_id,
            'sender_name', us.name,
            'mine',       (m2.sender_id = $1),
            /* A system line is the last thing in the thread often enough —
               somebody is added and nobody has written since — that the row has
               to be able to render it. The EVENT and the two names, never a
               sentence: the list builds the same words the thread does, from the
               same pieces, so they cannot drift into saying different things
               about one row. */
            'system_event',     m2.system_event,
            'system_target',    ut.name,
            /* The id as well as the name, so a row can say "Ana added you"
               exactly as the thread does. Without it the list would have to tell
               Cai that "Ana added Cai Mehta" — a small inconsistency, but between
               two views of one row, which is the kind people notice. */
            'system_target_id', m2.system_target_id,
            'created_at', m2.created_at)
     FROM chat_messages m2
     JOIN users us ON us.id = m2.sender_id
     LEFT JOIN users ut ON ut.id = m2.system_target_id
    WHERE m2.conversation_id = c.id
    ORDER BY m2.created_at DESC, m2.id DESC
    LIMIT 1)`;

/**
 * One conversation row, exactly as both the page and the dropdown want it.
 * Composed from the pieces above so there is one answer to "what is a
 * conversation row", not one per caller.
 */
const ROW_SQL = `
  c.id,
  c.kind,
  c.title,
  c.created_at,
  /* Who made it. The row does not decide who may manage it — that needs the
     caller's permissions, which SQL does not have — so the id is shipped and the
     controller turns it into can_manage. One rule, in one place, in JS. */
  c.created_by,
  c.archived_at,
  (c.archived_at IS NOT NULL) AS archived,
  COALESCE(c.last_message_at, c.created_at) AS sort_at,
  p.muted,
  p.pinned_at,
  (p.pinned_at IS NOT NULL) AS pinned,
  ${UNREAD_SQL}      AS is_unread,
  ${PARTICIPANTS_SQL} AS others,
  ${LAST_MESSAGE_SQL} AS last_message`;

/**
 * Ordering. Unread first would reorder the list under somebody's cursor the
 * instant they read something, so: strictly newest-first, and unread is shown
 * by weight instead of by position. The same choice the WhatsApp dropdown made,
 * and for the same reason — "a list that empties itself the moment you look at
 * it is a list you cannot use to find the message you just read".
 */
const ORDER_SQL = `ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`;

/* ── PINNING AND THE KEYSET CANNOT SHARE ONE QUERY ──────────────────────────
 *
 * The obvious change is to put `(p.pinned_at IS NOT NULL) DESC` on the front of
 * ORDER_SQL. It is wrong, and quietly: `before` is a single timestamp compared
 * with `COALESCE(c.last_message_at, c.created_at) < $n`, which is a cursor into
 * ONE ordering. Pinned-first is a second ordering, so a pinned conversation with
 * an old last message sorts above rows the cursor has already passed — it either
 * repeats on every page or vanishes from all of them, depending on where the
 * boundary falls. The same class of bug as the `m.id < $n` keyset in
 * listMessages, which took a 120-row fixture to notice.
 *
 * So pins are not paged. They are fetched once, for the first page only, and
 * excluded from the paged query on every page. Two statements on page one, one
 * on every page after it, and `before` keeps meaning exactly what it meant.
 *
 * MAX_PINS is what makes that safe: an unbounded prepended list is an unbounded
 * response. Ten is more than anybody pins and small enough that "the pinned
 * ones" is never a page of its own.
 */
const MAX_PINS = 10;
const PINNED_ONLY_SQL = `AND p.pinned_at IS NOT NULL`;
const UNPINNED_ONLY_SQL = `AND p.pinned_at IS NULL`;
const PINNED_ORDER_SQL = `ORDER BY p.pinned_at DESC, c.id DESC`;

/* Archived groups are gone from every list unless one is asked for by name. A
   filter rather than part of FROM_SQL, because getConversation must still be
   able to fetch an archived thread — you can open and read one, you just cannot
   write in it or find it by scrolling. */
const LIVE_ONLY_SQL = `AND c.archived_at IS NULL`;

/**
 * Is this user a live participant? The one question every write asks first.
 *
 * Returns the row so callers can read `muted` without a second trip. A caller
 * who is not in the conversation gets undefined — and every caller turns that
 * into a 404 rather than a 403, because 403 confirms the conversation exists,
 * which in a private-messaging feature is itself the leak.
 *
 * Takes `db` so it works on a pool OR inside a transaction. Several callers
 * need it mid-transaction and a hardcoded pool.query there would be a second
 * connection taken while holding one — the exact shape test_pool exists for.
 */
async function readMembership(db, conversationId, userId) {
  const { rows } = await db.query(
    /* created_by and archived_at come back with the membership because EVERY
       write now has to ask two more questions — "may I manage this" and "is this
       still writable" — and asking them in a second query would mean each write
       path deciding for itself when to ask. One trip, one answer, and canManage()
       and assertWritable() below are the only interpreters of it. */
    `SELECT p.conversation_id, p.user_id, p.muted, p.pinned_at,
            c.kind, c.title, c.created_by, c.archived_at
       FROM chat_participants p
       JOIN chat_conversations c ON c.id = p.conversation_id
      WHERE p.conversation_id = $1 AND p.user_id = $2 AND p.left_at IS NULL`,
    [conversationId, userId]
  );
  return rows[0];
}

/* ── The two questions every management route asks ──────────────────────────
 *
 * Kept next to readMembership because they read its row, and kept as functions
 * rather than repeated inline because the answer must be the same on all nine
 * routes that ask. The old shape — `req.user.is_super_admin ||
 * req.user.permissions.has('MANAGE_CHAT')` written out at each call site — was
 * already in two places and already disagreed with itself: addParticipants let
 * ANY member add somebody while removeParticipant required MANAGE_CHAT, so a
 * member could add a colleague and then not be able to undo it.
 *
 * The rule now: the person who made the group manages it, and MANAGE_CHAT
 * manages any group. A member who is neither can still leave.
 */
function isModerator(user) {
  return !!(user.is_super_admin || user.permissions.has('MANAGE_CHAT'));
}

function canManage(user, member) {
  return member.created_by === user.id || isModerator(user);
}

/**
 * Archived means read-only, and that has to hold for MANAGE_CHAT too.
 *
 * A moderator who can still write in an archived thread means "archived" is a
 * display preference, not a state — and the next person to read this code will
 * reasonably assume archived threads cannot change and build on that. Restoring
 * it first is one click and leaves a system line saying so, which is the honest
 * way to write in a closed thread.
 */
function assertWritable(member) {
  if (member.archived_at) {
    throw Object.assign(
      new Error('This conversation is archived. Restore it to write in it.'),
      { status: 409 }
    );
  }
}

/**
 * Everyone who should be told about a change here, for emitInvalidateTo.
 * Live participants only — somebody who left a group does not get nudged about
 * it. Read inside the sending transaction and used after release(): see the
 * comment in chat.controller.js sendMessage.
 */
async function readParticipantIds(db, conversationId) {
  const { rows } = await db.query(
    `SELECT user_id FROM chat_participants
      WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );
  return rows.map((r) => r.user_id);
}

/**
 * The message this one answers, as a small json object.
 *
 * A LEFT JOIN on the parent, not a recursive walk: the UI renders exactly one
 * quoted strip and never a tree, so one hop is the whole feature. A parent that
 * was deleted still resolves — flagged, so the strip can say so rather than
 * vanishing and leaving a reply answering nothing.
 */
const REPLY_SQL = `
  (SELECT JSON_BUILD_OBJECT(
            'id',      rm.id,
            'sender',  ru.name,
            'deleted', (rm.deleted_at IS NOT NULL),
            'preview', CASE WHEN rm.deleted_at IS NOT NULL THEN NULL
                            ELSE LEFT(rm.body, 90) END,
            'has_ref', (rm.ref_type IS NOT NULL))
     FROM chat_messages rm
     JOIN users ru ON ru.id = rm.sender_id
    WHERE rm.id = m.reply_to_id)`;

/**
 * Reactions on a page of messages, as json per message.
 *
 * Grouped by reaction with a count and a `mine` flag, which is all the UI needs:
 * a pill saying 👍 3, highlighted when you are one of the three. The names of who
 * reacted are fetched separately on hover rather than shipped with every page —
 * fifty messages × six reactions × every name is most of the payload and nobody
 * reads it until they point at one.
 */
const REACTIONS_SQL = `
  (SELECT COALESCE(JSON_AGG(x ORDER BY x->>'reaction'), '[]'::json)
     FROM (
       SELECT JSON_BUILD_OBJECT(
                'reaction', r.reaction,
                'count',    COUNT(*)::int,
                'mine',     BOOL_OR(r.user_id = $2)
              ) AS x
         FROM chat_message_reactions r
        WHERE r.message_id = m.id
        GROUP BY r.reaction
     ) g)`;

/**
 * How far everybody ELSE in this conversation has got, for the ticks.
 *
 * ── The MIN, and why it is a min ──
 * In a group, two ticks must mean EVERYONE has. So the answer for the whole
 * conversation is the least-advanced participant: a message is read when it is at
 * or before the earliest read_at among the others. One number for the page, and
 * the client derives each bubble's state from it — a per-message subquery would
 * ask the same question fifty times for an answer that cannot differ.
 *
 * ── Why it can be NULL, and what that means ──
 * NULL means at least one other participant has no cursor at all: they have never
 * opened the conversation. Which is exactly one tick, and the COALESCE is
 * deliberately absent — coalescing to epoch would be the same answer by accident,
 * and coalescing to NOW() would claim everybody had read everything.
 *
 * Excludes the caller (their own reading says nothing about delivery) and anybody
 * who has left.
 */
const PEER_CURSORS_SQL = `
  SELECT
    /* ── MIN() IGNORES NULLS, AND THAT WAS A BUG ──────────────────────────
       A plain MIN(r.read_at) over {Ben: 10:05, Cai: NULL} returns 10:05,
       because aggregate functions skip NULLs. So a group where one person had
       read it and another had never opened the conversation at all reported
       "everyone has read it" — two teal ticks on a message half the group had
       not seen. In a chat feature that is not a cosmetic bug: people stop
       chasing when they see two ticks.
       The CASE is the fix and it states the rule exactly: the cursor for the
       group is only known when EVERY other participant has one. Otherwise it
       is NULL, which tickState reads as "not yet" — and deliberately does not
       coalesce, because coalescing to epoch would be the same answer by luck
       and to NOW() would be the original bug wearing a different hat. */
    CASE WHEN COUNT(*) = COUNT(r.read_at)      THEN MIN(r.read_at)      END AS peer_read_at,
    CASE WHEN COUNT(*) = COUNT(r.delivered_at) THEN MIN(r.delivered_at) END AS peer_delivered_at,
    COUNT(*)::int              AS peer_count,
    COUNT(r.read_at)::int      AS peers_with_read,
    COUNT(r.delivered_at)::int AS peers_with_delivery
    FROM chat_participants p
    LEFT JOIN chat_reads r
      ON r.conversation_id = p.conversation_id AND r.user_id = p.user_id
   WHERE p.conversation_id = $1
     AND p.user_id <> $2
     AND p.left_at IS NULL`;

/**
 * Who has NOT read up to a given moment — for the hover on a group's ticks.
 * Small and asked for by name, never shipped with the page.
 */
async function readPendingReaders(db, conversationId, userId, upTo) {
  const { rows } = await db.query(
    `SELECT u.name
       FROM chat_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN chat_reads r
         ON r.conversation_id = p.conversation_id AND r.user_id = p.user_id
      WHERE p.conversation_id = $1
        AND p.user_id <> $2
        AND p.left_at IS NULL
        AND (r.read_at IS NULL OR r.read_at < $3)
      ORDER BY u.name`,
    [conversationId, userId, upTo]
  );
  return rows.map((r) => r.name);
}

/**
 * The canonical key for a direct conversation between two people.
 *
 * LEAST/GREATEST so (4,9) and (9,4) are the same string, which is what makes
 * uq_chat_conversations_dm_key able to stop a second thread for the same pair.
 * Computed here, in one place, because two spellings of this would defeat the
 * unique index entirely while looking like they worked.
 */
function dmKey(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) {
    throw Object.assign(new Error('dmKey needs two positive integer user ids'), { status: 400 });
  }
  if (x === y) {
    throw Object.assign(new Error('Cannot open a direct conversation with yourself'), { status: 400 });
  }
  return `${Math.min(x, y)}:${Math.max(x, y)}`;
}

/**
 * One system line, written in whatever transaction the change itself is in.
 *
 * Takes `db` for the same reason readMembership does — several callers are
 * mid-transaction, and a bare pool.query there is a second connection taken
 * while holding one.
 *
 * ── It moves last_message_at, and that is on purpose ──
 * Somebody just added to a group whose last message was in March would otherwise
 * find it sorted by March, near the bottom of a list they have never seen. The
 * bump puts it where they will look. It does NOT light the badge — UNREAD_SQL
 * excludes system events — so everybody already in the group gets the thread
 * nudged up their list and nothing demanding a reply.
 */
async function writeSystemLine(db, conversationId, actorId, event, {
  targetId = null, body = null,
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO chat_messages
       (conversation_id, sender_id, system_event, system_target_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [conversationId, actorId, event, targetId, body]
  );
  await db.query(
    `UPDATE chat_conversations SET last_message_at = $2 WHERE id = $1`,
    [conversationId, rows[0].created_at]
  );
  return rows[0];
}

module.exports = {
  FROM_SQL,
  REPLY_SQL,
  REACTIONS_SQL,
  PEER_CURSORS_SQL,
  readPendingReaders,
  UNREAD_SQL,
  HIDDEN_SQL,
  PARTICIPANTS_SQL,
  LAST_MESSAGE_SQL,
  ROW_SQL,
  ORDER_SQL,
  MAX_PINS,
  PINNED_ONLY_SQL,
  UNPINNED_ONLY_SQL,
  PINNED_ORDER_SQL,
  LIVE_ONLY_SQL,
  readMembership,
  readParticipantIds,
  isModerator,
  canManage,
  assertWritable,
  writeSystemLine,
  dmKey,
};
