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

/**
 * The address a rate-limit bucket is keyed on.
 *
 * ⚠ X-Forwarded-For IS ATTACKER-CONTROLLED unless a trusted proxy set it.
 *
 * This used to read that header unconditionally, with a comment saying "trust
 * proxy is not assumed" — which had it exactly backwards. Reading the header
 * without configuring trust proxy is the one combination that is never safe:
 * anyone can send a different random value on every request, land in a fresh
 * bucket each time, and never hit any limit. That defeated the 10-orders-per-15
 * minutes guard on the public pay endpoint, which exists specifically to stop
 * someone running a stolen-card list through the company's live merchant
 * account — as well as the OTP limiter and the PDF-render limiter.
 *
 * Express already solves this properly: with `app.set('trust proxy', …)`
 * configured to match the actual hop count, `req.ip` is the left-most address
 * the trusted chain vouches for and forged entries beyond it are discarded.
 * So the header is no longer read here at all — `req.ip` is the answer, and it
 * is correct in both deployments:
 *
 *   behind a proxy   → server.js sets trust proxy, req.ip is the real client
 *   directly exposed → trust proxy is off, req.ip is the socket address, and a
 *                      forged header is ignored rather than believed
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
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

    // req.route.path, NOT req.path.
    //
    // Inside a mounted router, req.path is the router-relative URL with
    // parameters already substituted — so for '/customer-invoice/:token' it is
    // '/customer-invoice/<the actual token>'. Keying on that gives one bucket
    // PER TOKEN, which means an attacker enumerating tokens gets a fresh
    // allowance for every guess and the limiter stops being a limiter.
    //
    // Every route that existed when this was written had a static path, so the
    // two were identical and the bug was invisible; the first parameterised
    // route to be rate-limited is where it would have bitten. req.route is
    // populated before route-level middleware runs, and the ?? keeps this safe
    // if the limiter is ever used as router- or app-level middleware where it
    // is not.
    const routePath = req.route?.path ?? req.path;
    const key = `${req.baseUrl}${routePath}|${clientIp(req)}|${extra}`;

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
