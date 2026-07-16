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
 *   const { getIO } = require('../socket');
 *   getIO().emit('invalidate', { topic: 'locations' });
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

function getIO() {
  if (!_io) {
    // If socket.io hasn't been initialised yet (e.g. in tests), return a
    // no-op stub so controllers don't crash.
    return { emit: () => {} };
  }
  return _io;
}

module.exports = { initIO, getIO };
