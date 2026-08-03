'use strict';

/**
 * Tiny in-memory sliding-window rate limiter.
 *
 * Exists because /api/public/booking/* is UNAUTHENTICATED — anyone on the
 * internet can hit it. Without a limit, send-otp is a free SMS cannon and
 * services/vehicles are a free database scan.
 *
 * Deliberately dependency-free and in-process: this CRM runs as a single
 * Node process. If it is ever scaled horizontally, swap this for Redis —
 * per-process counters would then allow N× the intended rate.
 */

const buckets = new Map(); // key → number[] (ms timestamps)

// Keep the map from growing without bound on a long-running process.
const SWEEP_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now, windowMs) {
  if (now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  for (const [k, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > windowMs) buckets.delete(k);
  }
}

function clientIp(req) {
  // trust proxy is not assumed — fall back through the usual suspects.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * rateLimit({ windowMs, max, keyBy })
 *   keyBy(req) → extra key material (e.g. the mobile number for send-otp),
 *   so one IP cannot burn another number's quota and vice versa.
 */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, keyBy = null } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    sweep(now, windowMs);

    const extra = keyBy ? String(keyBy(req) ?? '') : '';
    const key = `${req.baseUrl}${req.path}|${clientIp(req)}|${extra}`;

    const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retry_after: retryAfter,
      });
    }

    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

module.exports = { rateLimit };
