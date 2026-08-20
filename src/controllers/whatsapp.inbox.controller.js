'use strict';

/**
 * The WhatsApp badge in the topbar, and what is behind it.
 *
 * ── What it counts, and why not messages ────────────────────────────────────
 *
 * CONVERSATIONS with something unread, not unread messages. "4" means four
 * people are waiting on you. A message count says "17" when one customer sent
 * seventeen lines about a bumper, which is one job, and it reads as a backlog
 * that does not exist.
 *
 * ── Whose ───────────────────────────────────────────────────────────────────
 *
 * An advisor sees their own conversations plus the unassigned queue. Anyone who
 * can already see every lead — super admin, or VIEW_LEAD — sees every
 * conversation, because the alternative was discovered the hard way: the owner
 * of the business watched a customer message arrive, saw no badge, and had no
 * way to tell that it was working exactly as asked. It had gone to an advisor,
 * and "mine plus unassigned" excluded it.
 *
 * The queue is in for everybody on purpose. Those are the leads routing could
 * not place, they are visibly nobody's, and a badge that showed only your own
 * would leave them exactly as invisible as they were before any of the routing
 * work. They are everyone's problem until somebody takes one.
 *
 * ── Read state is per user ──────────────────────────────────────────────────
 *
 * wa_conversation_reads (migration 163) is a cursor per (user, number). So an
 * admin opening a thread to check something does not clear the advisor's badge,
 * and the first person to glance at an unassigned conversation does not clear
 * it for the whole team.
 *
 * ── Nothing here writes to `notifications` ──────────────────────────────────
 *
 * The bell and this are two counts of two different things, and a customer
 * message landing in both would be one event shown twice, cleared twice, and
 * argued about once.
 */

const { pool } = require('../config/db');
const { toE164 } = require('../utils/phone');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

/**
 * Who owns this conversation?
 *
 * COALESCE, and the fallback is the whole point.
 *
 * WhatsApp routing writes BOTH wa_conversations.assigned_user_id and
 * leads.assigned_to. Assigning a lead BY HAND writes only the second — nothing
 * on the Leads page has ever touched a conversation row. So a lead somebody
 * assigned to Aman themselves had an owner on one screen and nobody on the
 * other, and it showed:
 *
 *   the dropdown said "Unassigned" beside a leads row that plainly said "Aman"
 *   the conversation sat in the shared queue, so it counted in EVERYONE'S badge
 *   the push notification went to nobody at all — announceInbound looked up
 *     assigned_user_id, found NULL, and sent nothing
 *
 * The conversation still wins when it has an answer: it is the more specific
 * fact, and it is what continuity routing reads next time this number writes.
 */
const OWNER_SQL = `COALESCE(c.assigned_user_id, l.assigned_to)`;

/**
 * Whose conversations this user sees in their badge.
 *
 * Two scopes, and the split is the same one the Leads page already uses
 * (leads.controller.js: is_super_admin, then VIEW_LEAD). Deliberately the same
 * rule rather than a second one invented here — a CRM where "see everything"
 * means one thing on the Leads page and another in the topbar is a CRM where
 * nobody can answer why a customer is missing from a screen.
 *
 * An advisor gets their own work plus the unassigned queue. The queue is in on
 * purpose: those are the leads routing could not place, they are visibly
 * nobody's, and a badge filtered to "mine" would leave them exactly as
 * invisible as they were before any of the routing work.
 */
function seesEverything(user) {
  return !!user.is_super_admin || !!user.permissions?.has?.('VIEW_LEAD');
}

/** $1 is always the user id — the unread cursor needs it whatever the scope. */
function scopeSql(user) {
  return seesEverything(user)
    ? 'TRUE'
    : `(${OWNER_SQL} = $1 OR ${OWNER_SQL} IS NULL)`;
}

/**
 * The lead join, needed by both queries now that ownership can come from it.
 * One definition, because a count and a list built from two different FROM
 * clauses is how a badge saying 3 ends up over a dropdown with 2 rows in it.
 */
const FROM_SQL = `
  FROM wa_conversations c
  LEFT JOIN leads l ON l.id = c.lead_id`;

/**
 * Is there anything on this conversation this user has not seen?
 *
 * COALESCE to 'epoch' rather than a LEFT JOIN with a NULL check: a user who has
 * never opened a conversation has no row at all, and that must mean "everything
 * is unread", not "nothing is". The zero-row case is the common one — it is
 * every conversation nobody has touched yet.
 *
 * direction = 'in' only. An outbound message is one we sent; counting it would
 * have the badge light up because an advisor replied.
 */
const UNREAD_SQL = `
  EXISTS (
    SELECT 1 FROM wa_messages m
     WHERE m.to_number = c.mobile
       AND m.direction = 'in'
       AND m.created_at > COALESCE(
             (SELECT r.read_at FROM wa_conversation_reads r
               WHERE r.user_id = $1 AND r.mobile = c.mobile),
             TIMESTAMPTZ 'epoch')
  )`;

/**
 * Has this user cleared this conversation? (migration 164)
 *
 * A cursor, not a flag — so a cleared conversation comes BACK the moment the
 * customer writes again, by arithmetic, with nothing written anywhere. A
 * boolean would have to be unset from the webhook for every user who had
 * cleared it, and one missed update is a customer's reply landing somewhere
 * invisible.
 *
 * Compared against the conversation's newest message rather than NOW(), which
 * is why it reads `last.created_at` and can only be used where that join
 * exists. The count does not need it at all: clearing sets read_at too, so a
 * cleared conversation has already left the badge.
 */
const HIDDEN_SQL = `
  last.created_at <= COALESCE(
    (SELECT r2.dismissed_at FROM wa_conversation_reads r2
      WHERE r2.user_id = $1 AND r2.mobile = c.mobile),
    TIMESTAMPTZ '-infinity')`;

/**
 * GET /api/whatsapp/inbox/unread-count
 *
 * Called on the same schedule as the bell's count and again on every socket
 * nudge, so it is deliberately one statement with no joins to users, leads or
 * messages beyond the EXISTS.
 */
function unreadCount(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS count
       ${FROM_SQL}
        WHERE ${scopeSql(req.user)} AND ${UNREAD_SQL}`,
      [req.user.id]
    );
    res.json({ count: r.rows[0].count });
  });
}

/**
 * GET /api/whatsapp/inbox
 *
 * The dropdown. Read conversations are included, below the unread ones, because
 * a list that empties itself the moment you look at it is a list you cannot use
 * to find the message you just read.
 */
function listInbox(req, res, next) {
  handle(req, res, next, async () => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const r = await pool.query(
      `SELECT
         c.mobile,
         c.window_expires_at,
         c.lead_id,
         -- Three sources for one label, best first. A conversation with no name
         -- anywhere renders as the number, which is at least dialable.
         COALESCE(NULLIF(TRIM(l.name), ''), NULLIF(TRIM(c.customer_name), ''), c.mobile) AS display_name,
         l.status AS lead_status,
         u.name   AS assigned_to_name,
         ${OWNER_SQL} AS assigned_user_id,
         ${UNREAD_SQL} AS is_unread,
         last.body_rendered AS last_message,
         last.created_at    AS last_message_at,
         last.direction     AS last_direction
       ${FROM_SQL}
       LEFT JOIN users u ON u.id = ${OWNER_SQL}
       -- The last message either way round. Showing only the last INBOUND one
       -- would have a conversation you have already answered still reading as
       -- the customer's question, which looks unhandled.
       LEFT JOIN LATERAL (
         SELECT m.body_rendered, m.created_at, m.direction
           FROM wa_messages m
          WHERE m.to_number = c.mobile
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
       ) last ON TRUE
      WHERE ${scopeSql(req.user)}
        AND last.created_at IS NOT NULL
        AND NOT ${HIDDEN_SQL}
      -- Unread first, then most recent. Sorting purely by time would bury a
      -- customer who wrote this morning under conversations you have already
      -- dealt with since.
      --
      -- Ordering on the OUTPUT column, which Postgres allows and which matters
      -- here: repeating the EXISTS would have the planner evaluate it a second
      -- time per row, and the two copies could drift the day one of them is
      -- edited.
      ORDER BY is_unread DESC, last.created_at DESC
      LIMIT $2`,
      [req.user.id, limit]
    );

    res.json({
      items: r.rows.map(row => ({
        ...row,
        // Trimmed here rather than in the browser: the row shows one line, and
        // a 2,000-character form-fill message is bandwidth spent on text
        // nobody sees — times twenty rows, on every open.
        last_message: row.last_message ? String(row.last_message).slice(0, 120) : null,
      })),
    });
  });
}

/**
 * POST /api/whatsapp/inbox/read   { mobile }
 *
 * Called when a thread is opened. NOW() rather than the timestamp of the last
 * message the client happened to have: between the two there may be a message
 * that arrived while the panel was rendering, and using the client's figure
 * would leave it unread forever — it is older than everything that follows and
 * nothing will ever move the cursor past it.
 */
function markRead(req, res, next) {
  handle(req, res, next, async () => {
    const e164 = toE164(req.body?.mobile);
    if (!e164) return res.status(400).json({ error: 'A valid Indian mobile number is required.' });

    await pool.query(
      `INSERT INTO wa_conversation_reads (user_id, mobile, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, mobile) DO UPDATE SET read_at = NOW()`,
      [req.user.id, e164]
    );
    res.json({ ok: true });
  });
}

/**
 * POST /api/whatsapp/inbox/read-all
 *
 * Scoped to what the badge counts, not to every conversation in the database.
 * "Mark all read" on a screen showing your own queue must not silently mark a
 * colleague's conversations read for you — you would then never see them if one
 * were reassigned to you tomorrow.
 */
function markAllRead(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `INSERT INTO wa_conversation_reads (user_id, mobile, read_at)
       SELECT $1, c.mobile, NOW()
       ${FROM_SQL}
        WHERE ${scopeSql(req.user)}
       ON CONFLICT (user_id, mobile) DO UPDATE SET read_at = NOW()`,
      [req.user.id]
    );
    res.json({ ok: true, cleared: r.rowCount });
  });
}

/**
 * POST /api/whatsapp/inbox/dismiss   { mobile }
 *
 * Clear one conversation out of this user's dropdown.
 *
 * Sets read_at as well, and that pairing is the point: "I am done with this"
 * cannot leave an unread badge behind pointing at a row you can no longer see.
 * A badge counting something invisible is the exact failure that makes people
 * stop trusting badges.
 */
function dismiss(req, res, next) {
  handle(req, res, next, async () => {
    const e164 = toE164(req.body?.mobile);
    if (!e164) return res.status(400).json({ error: 'A valid Indian mobile number is required.' });

    await pool.query(
      `INSERT INTO wa_conversation_reads (user_id, mobile, read_at, dismissed_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, mobile)
       DO UPDATE SET read_at = NOW(), dismissed_at = NOW()`,
      [req.user.id, e164]
    );
    res.json({ ok: true });
  });
}

/**
 * POST /api/whatsapp/inbox/dismiss-all
 *
 * Scoped to what this user can see, like mark-all-read — clearing a colleague's
 * conversation for yourself would hide it if it were reassigned to you
 * tomorrow.
 *
 * Note what it does NOT do: it clears what is in the dropdown NOW. A message
 * arriving a second later is newer than the cursor, so it appears immediately.
 * Clear all is a broom, not a mute.
 */
function dismissAll(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `INSERT INTO wa_conversation_reads (user_id, mobile, read_at, dismissed_at)
       SELECT $1, c.mobile, NOW(), NOW()
       ${FROM_SQL}
        WHERE ${scopeSql(req.user)}
       ON CONFLICT (user_id, mobile)
       DO UPDATE SET read_at = NOW(), dismissed_at = NOW()`,
      [req.user.id]
    );
    res.json({ ok: true, cleared: r.rowCount });
  });
}

module.exports = { unreadCount, listInbox, markRead, markAllRead, dismiss, dismissAll };
