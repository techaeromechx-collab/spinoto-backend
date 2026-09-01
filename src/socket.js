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
 */

let _io = null;

function initIO(httpServer) {
  const { Server } = require('socket.io');

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

  _io.on('connection', (socket) => {
    // No auth needed — invalidate events carry no sensitive data.
    // The frontend re-fetches via its own authenticated API calls.
    console.log(`[socket] client connected: ${socket.id}`);
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

function getIO() {
  if (!_io) {
    // If socket.io hasn't been initialised yet (e.g. in tests), return a
    // no-op stub so controllers don't crash.
    return { emit: () => {} };
  }
  return _io;
}

module.exports = { initIO, getIO, emitInvalidate };
