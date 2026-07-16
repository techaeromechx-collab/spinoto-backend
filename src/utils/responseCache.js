/**
 * responseCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Spinoto is a client-rendered SPA (no server-rendered HTML), so the closest
 * equivalent of "a server-rendered fragment that's identical across users and
 * changes rarely" is a master/reference-data GET endpoint: vehicle makes,
 * models, service categories, cc categories, lead statuses, departments,
 * locations. These are NOT per-user (no req.user in their queries — confirmed
 * by reading each controller) and change only when someone edits Master Data,
 * which is rare compared to how often every list page re-fetches them on
 * mount. Right now every one of those requests re-runs the same SQL query.
 *
 * This module caches the JSON response body for those endpoints in memory,
 * keyed by topic + full request URL (so query params like ?type_class=2W or
 * ?vehicle_class=4W — this app's equivalent of "locale" — are naturally part
 * of the key; different params never collide).
 *
 * Regeneration happens two ways, matching "on a schedule or on content
 * change":
 *   - On a schedule: each entry has a TTL and expires on its own.
 *   - On content change: every master-data write already emits
 *     `getIO().emit('invalidate', { topic })` over Socket.IO so the frontend
 *     refetches (see socket.js). That same emit call is wrapped (once, in
 *     socket.js) to also call invalidateTopic() here — so the very next
 *     request after an edit is a guaranteed cache miss, no separate wiring
 *     needed per controller.
 *
 * None of the cached endpoints have a personalized region mixed in (verified:
 * no req.user in their SQL), so the whole response is cached wholesale — no
 * "holes" are needed here. If a future shared-but-partly-personalized
 * endpoint needed this (e.g. a hub-scoped list plus a per-user "is favorite"
 * flag), the pattern would be: cache the shared part under its own key, fetch
 * the personalized slice separately, and merge before responding — not
 * implemented here since nothing currently needs it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — the "schedule" safety net

const store = new Map(); // key -> { body, status, topic, expiresAt }
const stats = { hits: 0, misses: 0 };

function now() { return Date.now(); }

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function set(key, { body, status }, topic, ttlMs) {
  store.set(key, { body, status, topic, expiresAt: now() + ttlMs });
}

/** Clears every cached entry belonging to `topic` — called when that topic's
 *  master data changes (see socket.js's wrap of getIO().emit('invalidate')). */
function invalidateTopic(topic) {
  for (const [key, entry] of store) {
    if (entry.topic === topic) store.delete(key);
  }
}

function clearAll() {
  store.clear();
}

function getStats() {
  return { ...stats, size: store.size };
}

/**
 * Express middleware factory. Wrap a read-only, non-per-user GET route with
 * this — cache key is `${topic}:${req.originalUrl}` so distinct query params
 * (the meaningful variation, in lieu of locale) never collide.
 *
 * Must be placed AFTER auth/permission middleware, so an unauthorized request
 * never reaches (or pollutes) the cache — only the expensive DB query result
 * is cached, not the access check itself.
 */
function cacheGet(topic, ttlMs = DEFAULT_TTL_MS) {
  return function cacheGetMiddleware(req, res, next) {
    const key = `${topic}:${req.originalUrl}`;
    const cached = get(key);

    if (cached) {
      stats.hits++;
      res.set('X-Cache', 'HIT');
      return res.status(cached.status).json(cached.body);
    }

    stats.misses++;
    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful responses — an error shouldn't get memoized.
      if (res.statusCode < 400) {
        set(key, { body, status: res.statusCode }, topic, ttlMs);
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = { cacheGet, invalidateTopic, clearAll, getStats, DEFAULT_TTL_MS };
