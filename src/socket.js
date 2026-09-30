'use strict';

/**
 * Socket.io singleton.
 *
 * Usage:
 *   // In server.js (once):
 *   const { initIO } = require('./socket');
 *   initIO(httpServer);
 *
 *   // In any controller (after a write):
 *   const { emitInvalidate } = require('../socket');
 *   emitInvalidate('locations', req);   // everyone EXCEPT the caller
 *
 *   // Or, for a topic only certain people should be nudged about:
 *   const { emitInvalidateTo } = require('../socket');
 *   emitInvalidateTo([4, 7, 12], 'chat', req);
 */

let _io = null;

/* ══ WHO IS ON THE OTHER END, AND WHY IT USED NOT TO MATTER ═════════════════

   For the whole life of this file the answer was "we don't know and we don't
   need to". The only event on the wire is invalidate { topic }, which is a
   nudge: it says a topic moved and carries no data at all. Someone listening
   without a login learns nothing from it, because the answer itself comes back
   over an authenticated REST call the frontend makes for itself.

   Internal chat changes that, and the first reason is not privacy.

   emitInvalidate broadcasts to EVERY connected socket. Twenty staff logged in,
   one direct message between two of them, and nineteen browsers each fire a
   /unread-count at a pooled Neon connection. Every message. The pool is
   max: 10 (config/db.js), and config/polling.js explains that the only reason
   every poll in this app is 120 seconds is what it costs to keep that database
   awake. An untargeted chat nudge spends exactly what those 120 seconds buy.

   The second reason is the obvious one. Once a broadcast exists that means
   "chat moved", the next person along is tempted to put the sender's name or
   the message itself on it, because it is already going out. Nothing in the
   old design stopped that. Only the old design's emptiness did.

   ── SO: ROOMS, AND AN OPTIONAL HANDSHAKE ─────────────────────────────────

   One room per user, and a second emit helper that talks to a list of rooms
   instead of to everybody. THE PAYLOAD DOES NOT CHANGE. It is still { topic }
   and nothing else, because the thing that made this safe is worth keeping.

   ── WHY OPTIONAL, WHICH LOOKS LIKE A HOLE AND IS NOT ─────────────────────

   A socket with no token, or a bad one, still connects. It joins no room, so
   it receives exactly what it received before this change and no chat nudges.
   Requiring a token would break three real situations:

     1. sw.js precaches the app shell, so a browser can be running an OLDER
        BUNDLE that connects with no auth field at all. Rejecting it would kill
        live updates on Estimates, Job Cards and every other screen — silently,
        and for a feature that tab does not even have.

     2. The JWT is 12 hours. A tab left open overnight reconnects with an
        expired one. That tab should lose chat nudges, not Job Cards.

     3. There is nothing to gain by rejecting. An anonymous socket is in no
        user: room, so a targeted emit cannot reach it anyway. The gate is the
        ROOM, not the handshake — which is why this needed no flag day and no
        coordinated deploy.

   A bad token is therefore NOT a disconnect. It is a socket that stays
   anonymous. Anything else turns a stale token into an app-wide outage.

   ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────

   No permission check. The handshake only answers "which user is this", and
   the only thing it grants is membership of that user's own room. Whether they
   may read a conversation is decided per request by chat.controller.js, which
   joins chat_participants on req.user.id. Putting an authorization decision in
   a handshake would cache it for the life of the connection — and permissions
   are re-read from the database on every request precisely so a revoke is
   instant (auth.middleware.js). A 12-hour socket must not undo that. */

function initIO(httpServer) {
  const { Server } = require('socket.io');
  const jwt = require('jsonwebtoken');

  const allowedOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  _io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
      methods: ['GET', 'POST'],
    },
  });

  // Every master-data write already does getIO().emit('invalidate', { topic })
  // to tell the frontend to refetch. Piggyback on that same call to also
  // clear the server-side response cache (responseCache.js) for that topic —
  // one interception point covers every controller without touching any of
  // them individually.
  const originalEmit = _io.emit.bind(_io);
  _io.emit = (event, payload, ...rest) => {
    if (event === 'invalidate' && payload?.topic) {
      require('./utils/responseCache').invalidateTopic(payload.topic);
    }
    return originalEmit(event, payload, ...rest);
  };

  /* Identify the socket if it can be identified, and never refuse it.
     See the block comment at the top of this file for why next() is called on
     every path including the failures. */
  _io.use((socket, next) => {
    const token = socket.handshake?.auth?.token;
    if (!token) return next();                       // anonymous, as before
    try {
      const { sub } = jwt.verify(token, process.env.JWT_SECRET);
      // A JWT whose sub is missing or non-numeric would join a room named
      // "user:undefined", which every such socket would share. Checked rather
      // than assumed.
      const id = Number(sub);
      if (Number.isInteger(id) && id > 0) {
        socket.data.userId = id;
        socket.join(`user:${id}`);
      }
    } catch {
      /* Expired or malformed. Stays anonymous on purpose — a stale token must
         cost this tab its chat nudges, not every screen's live updates. */
    }
    next();
  });

  /* ── Typing ──────────────────────────────────────────────────────────────
     The ONE event besides `invalidate`, and it earns its place by carrying no
     message content whatsoever: a conversation id and who is typing, nothing
     else. Not stored anywhere, not replayed, gone the moment it is delivered.

     It is a relay, so the server must not take the client's word for two
     things. The SENDER is read from socket.data.userId — set by the handshake
     from a verified JWT — never from the payload, or anybody could type as
     anybody. And MEMBERSHIP is checked here, or anybody could push a typing
     indicator into a conversation they are not in.

     An anonymous socket has no userId and is ignored, which is the same rule
     the rooms already apply.

     One indexed lookup per event, and the client throttles to one every three
     seconds — the cost of a keystroke must not be a query. */
  _io.on('connection', (socket) => {
    socket.on('chat:typing', async ({ conversation_id: convId } = {}) => {
      const userId = socket.data.userId;
      const id = Number(convId);
      if (!userId || !Number.isInteger(id) || id < 1) return;
      try {
        const { pool } = require('./config/db');
        const { rows } = await pool.query(
          `SELECT u.name
             FROM chat_participants p JOIN users u ON u.id = p.user_id
            WHERE p.conversation_id = $1 AND p.user_id = $2 AND p.left_at IS NULL`,
          [id, userId]
        );
        if (!rows.length) return;                    // not in it: say nothing

        const others = await pool.query(
          `SELECT user_id FROM chat_participants
            WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL`,
          [id, userId]
        );
        const rooms = others.rows.map((r) => `user:${r.user_id}`);
        if (!rooms.length) return;
        _io.to(rooms).except(socket.id).emit('chat:typing', {
          conversation_id: id, user_id: userId, name: rows[0].name,
        });
      } catch (err) {
        console.error('[socket] typing relay:', err.message);
      }
    });

    // The payload on the wire is still only { topic } — see emitInvalidateTo.
    // A socket is identified so nudges can be TARGETED, not so they can carry
    // more.
    const who = socket.data.userId ? `user ${socket.data.userId}` : 'anonymous';
    console.log(`[socket] client connected: ${socket.id} (${who})`);
    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
    });
  });

  console.log('[socket] Socket.io attached');
  return _io;
}

/**
 * Tell every OTHER client that a topic moved.
 *
 * ── Why "other" ────────────────────────────────────────────────────────────
 *
 * getIO().emit() is a broadcast to every connected socket, and that includes
 * the one whose request just caused it. So the person clicking Done was being
 * told about their own edit, and every screen listening to that topic
 * re-fetched — on the Estimates page, both the list AND the open drawer, the
 * drawer blanking itself behind its loading state each time. Ten line items,
 * ten round trips and ten flashes, all to re-learn what the PATCH response had
 * already returned to that same browser.
 *
 * The broadcast itself is right: a colleague marking work done SHOULD update
 * your screen. What was wrong is the echo back to the author, who already has
 * the answer and has usually already applied it locally.
 *
 * ── How the caller is identified ───────────────────────────────────────────
 *
 * The frontend puts its socket id on every request as X-Socket-Id (see
 * api/client.js). Socket.IO puts every socket in a room named after its own
 * id, so `.except(id)` is exactly "everyone but that tab".
 *
 * Deliberately per-TAB, not per-user: two tabs open on the same login are two
 * screens, and the one that did not act still needs telling.
 *
 * With no header — an older client, a server-side caller, a webhook — this
 * degrades to the previous behaviour and emits to everybody. Never silently
 * emits to nobody.
 *
 * @param {string} topic   the topic that moved, e.g. 'estimates'
 * @param {object} [req]   the Express request that caused it, if there is one
 */
function emitInvalidate(topic, req) {
  if (!topic) return;
  try {
    const io = getIO();

    /* The response cache is cleared HERE rather than being left to the emit
       interception in initIO. That patch wraps _io.emit, and `.except(id)`
       returns a BroadcastOperator whose own .emit it never sees — so routing
       around the patch would have quietly stopped invalidating the server-side
       cache, which is a far worse bug than the one being fixed. One explicit
       call, on every path. */
    try { require('./utils/responseCache').invalidateTopic(topic); }
    catch { /* cache module absent in tests */ }

    const originId = req?.get?.('X-Socket-Id') || req?.headers?.['x-socket-id'];
    if (originId && typeof io.except === 'function') {
      // Not through the patched _io.emit — the cache is already handled above.
      io.except(originId).emit('invalidate', { topic });
    } else {
      io.emit('invalidate', { topic });
    }
  } catch (err) {
    console.error(`[socket] invalidate emit failed for "${topic}":`, err.message);
  }
}

/**
 * Tell a NAMED LIST OF USERS that a topic moved, and nobody else.
 *
 * Same event, same payload — `invalidate { topic }`, nothing added. The only
 * difference from emitInvalidate is who hears it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A direct message between two people is not news to the other eighteen
 * browsers in the building, and telling them makes eighteen of them ask the
 * database a question whose answer is "nothing, for you". On a max: 10 pool
 * that is the whole problem. See the block comment at the top of this file.
 *
 * ── The payload still carries nothing, and that is the point ───────────────
 *
 * It would be easy, now that the emit is targeted, to put the message on it —
 * the recipients are the right people, after all. Don't. An anonymous socket
 * cannot join a user: room, but "cannot today" is a property of this file, and
 * the reason the old broadcast was safe is that there was nothing on it to
 * leak. Keep that true and this function can never become a leak either.
 *
 * ── The trap ──────────────────────────────────────────────────────────────
 *
 * initIO patches _io.emit to also clear the response cache. `.to(rooms)`
 * returns a BroadcastOperator whose .emit that patch never sees — exactly the
 * same trap emitInvalidate documents for `.except(id)`. So the cache is
 * cleared here, explicitly, before the emit. Every path clears it.
 *
 * @param {Array<number>} userIds  who should be nudged; empty = nobody, and it
 *                                 returns without emitting rather than falling
 *                                 back to a broadcast
 * @param {string} topic           the topic that moved, e.g. 'chat'
 * @param {object} [req]           the Express request, so the acting tab is
 *                                 left out exactly as in emitInvalidate
 */
function emitInvalidateTo(userIds, topic, req) {
  if (!topic) return;

  /* An empty list means nobody, and it must NOT degrade to a broadcast the way
     a missing X-Socket-Id does. Those two fallbacks look alike and are
     opposites: a missing header means "we cannot tell which tab to skip, so
     tell everyone", while an empty recipient list means "we know exactly who
     should hear this, and it is no one". A conversation whose participants all
     left is the ordinary way to get here. */
  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return;

  try {
    const io = getIO();

    // Before the emit, and on every path — see "The trap" above.
    try { require('./utils/responseCache').invalidateTopic(topic); }
    catch { /* cache module absent in tests */ }

    if (typeof io.to !== 'function') return;   // the no-op stub in tests

    const rooms = [...new Set(ids)].map((id) => `user:${id}`);
    let target = io.to(rooms);

    /* Same per-tab exclusion as emitInvalidate, and per-TAB is right here too:
       the sender's OTHER tabs are in the same user: room and still need
       telling. Only the tab that did the writing already knows. */
    const originId = req?.get?.('X-Socket-Id') || req?.headers?.['x-socket-id'];
    if (originId && typeof target.except === 'function') target = target.except(originId);

    target.emit('invalidate', { topic });
  } catch (err) {
    console.error(`[socket] targeted invalidate failed for "${topic}":`, err.message);
  }
}

function getIO() {
  if (!_io) {
    // If socket.io hasn't been initialised yet (e.g. in tests), return a
    // no-op stub so controllers don't crash.
    return { emit: () => {} };
  }
  return _io;
}

module.exports = { initIO, getIO, emitInvalidate, emitInvalidateTo };
