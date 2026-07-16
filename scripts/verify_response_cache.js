/**
 * verify_response_cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone verification for src/utils/responseCache.js. Uses a minimal fake
 * Express req/res so it can exercise the real cacheGet() middleware without
 * needing a running server or a database. Confirms:
 *   1. First request (miss) actually calls the "handler" (simulating the DB
 *      query); the response is served much faster on a repeat request (hit)
 *      because the handler is skipped entirely — "renders" (DB queries) drop.
 *   2. Different query params produce different cache entries — no collision
 *      (this app's equivalent of keying by locale).
 *   3. invalidateTopic() clears only the affected topic; an unrelated topic's
 *      cached entries are untouched — a "content change" in one area doesn't
 *      force-refetch or slow down an unrelated part of the app.
 *   4. TTL expiry — the "regenerate on a schedule" path — refetches after
 *      the entry's time-to-live passes, even with no invalidation event.
 *
 * Run: node scripts/verify_response_cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { cacheGet, invalidateTopic, clearAll, getStats } = require('../src/utils/responseCache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ok   - ${label}`); passed++; }
  else      { console.log(`  FAIL - ${label}`); failed++; }
}

// Minimal fake Express req/res so cacheGet()'s middleware can run for real.
// Real Express maintains `res.statusCode` automatically (set by res.status());
// responseCache.js checks that same property, so the fake must mirror it.
function fakeReqRes(url) {
  const req = { originalUrl: url };
  const res = {
    statusCode: 200,
    _headers: {},
    _body: null,
    set(name, val) { this._headers[name] = val; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return { req, res };
}

/** Runs `handler` (simulating the real DB-backed route handler) through the
 *  cacheGet middleware for a given topic+url, returning { res, calledHandler, ms }. */
async function runThroughMiddleware(topic, url, handler, ttlMs) {
  const mw = cacheGet(topic, ttlMs);
  const { req, res } = fakeReqRes(url);
  let calledHandler = false;
  const t0 = Date.now();

  await new Promise((resolve) => {
    mw(req, res, async () => {
      calledHandler = true;
      await handler(res);
      resolve();
    });
    // If it was a cache hit, `next` (the callback above) is never invoked —
    // cacheGet already sent the response synchronously.
    if (res._body !== null && !calledHandler) resolve();
  });

  return { res, calledHandler, ms: Date.now() - t0 };
}

async function main() {
  clearAll();

  // ── 1. Miss calls the handler; hit doesn't, and is much faster ──────────
  console.log('\n[1] Cache hit skips the "DB query" entirely and is much faster');
  {
    const slowHandler = async (res) => { await sleep(80); res.json({ items: ['A', 'B', 'C'] }); };

    const first = await runThroughMiddleware('vehicles', '/api/vehicles/makes?type_class=2W', slowHandler, 60_000);
    check('first request is a MISS (handler actually ran)', first.calledHandler === true);
    check('first request took roughly as long as the simulated DB query', first.ms >= 70);
    check('response body correct on miss', JSON.stringify(first.res._body) === JSON.stringify({ items: ['A', 'B', 'C'] }));

    const second = await runThroughMiddleware('vehicles', '/api/vehicles/makes?type_class=2W', slowHandler, 60_000);
    check('second request is a HIT (handler skipped)', second.calledHandler === false);
    check(`second request is much faster (${second.ms}ms vs ${first.ms}ms)`, second.ms < first.ms / 4);
    check('cached response body matches the original', JSON.stringify(second.res._body) === JSON.stringify({ items: ['A', 'B', 'C'] }));
  }

  // ── 2. Different query params → different cache entries, no collision ──
  console.log('\n[2] Different query params (the "locale" equivalent here) don\'t collide');
  {
    clearAll();
    let calls = 0;
    const handler = async (res) => { calls++; res.json({ callNumber: calls }); };

    const twoW = await runThroughMiddleware('vehicles', '/api/vehicles/makes?type_class=2W', handler, 60_000);
    const fourW = await runThroughMiddleware('vehicles', '/api/vehicles/makes?type_class=4W', handler, 60_000);
    check('2W and 4W each triggered their own fetch (2 total calls)', calls === 2);
    check('2W and 4W got distinct cached bodies', twoW.res._body.callNumber !== fourW.res._body.callNumber);

    // Re-request 2W — should hit its own cached entry, not 4W's.
    const twoWAgain = await runThroughMiddleware('vehicles', '/api/vehicles/makes?type_class=2W', handler, 60_000);
    check('repeat 2W request is a HIT and returns the original 2W body', !twoWAgain.calledHandler && twoWAgain.res._body.callNumber === twoW.res._body.callNumber);
  }

  // ── 3. invalidateTopic only affects its own topic ───────────────────────
  console.log('\n[3] Invalidating one topic leaves an unrelated topic untouched');
  {
    clearAll();
    let vehicleCalls = 0, serviceCalls = 0;
    const vehicleHandler = async (res) => { vehicleCalls++; res.json({ n: vehicleCalls }); };
    const serviceHandler = async (res) => { serviceCalls++; res.json({ n: serviceCalls }); };

    await runThroughMiddleware('vehicles', '/api/vehicles/makes', vehicleHandler, 60_000);
    await runThroughMiddleware('services', '/api/services/categories', serviceHandler, 60_000);
    check('both warmed up with exactly 1 call each', vehicleCalls === 1 && serviceCalls === 1);

    // Simulate a Master Data edit to a vehicle make — only 'vehicles' should invalidate.
    invalidateTopic('vehicles');

    const vehicleAfter = await runThroughMiddleware('vehicles', '/api/vehicles/makes', vehicleHandler, 60_000);
    const serviceAfter = await runThroughMiddleware('services', '/api/services/categories', serviceHandler, 60_000);
    check('vehicles topic was invalidated — handler ran again', vehicleAfter.calledHandler === true);
    check('services topic (unrelated) is still cached — handler did NOT run again', serviceAfter.calledHandler === false);
    check('the degraded/changed topic doesn\'t drag down the unrelated one', serviceCalls === 1);
  }

  // ── 4. TTL expiry — "regenerate on a schedule" ───────────────────────────
  console.log('\n[4] Entry regenerates on schedule once its TTL passes, even with no invalidation');
  {
    clearAll();
    let calls = 0;
    const handler = async (res) => { calls++; res.json({ n: calls }); };

    await runThroughMiddleware('departments', '/api/departments', handler, 100); // 100ms TTL
    const immediate = await runThroughMiddleware('departments', '/api/departments', handler, 100);
    check('within the TTL window, still a cache hit', immediate.calledHandler === false);

    await sleep(150); // past the 100ms TTL
    const afterExpiry = await runThroughMiddleware('departments', '/api/departments', handler, 100);
    check('after the TTL passes, it refetches on its own (no manual invalidation needed)', afterExpiry.calledHandler === true);
  }

  console.log(`\nCache stats: ${JSON.stringify(getStats())}`);
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
