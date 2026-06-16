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
