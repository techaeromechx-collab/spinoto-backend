/**
 * A hub has NO edit access to its own Sales Invoice.
 *
 * sync-from-estimate rewrites every line item and total of an already-issued
 * invoice. Its only other guard is payment_status='paid', so an APPROVED
 * invoice — one that has claimed a number from the hub's consecutive series —
 * was rewritable by a zero-permission hub login through canGenerate's bypass.
 *
 * Two independent guards are asserted: the route gate and the controller.
 */
const path = require('path');
const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

let QUERIES = [];
const fakePool = {
  query: async (sql) => { QUERIES.push(String(sql)); return { rows: [], rowCount: 0 }; },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};
for (const [file, exp] of Object.entries({
  [path.join(ROOT, 'config/db.js')]: { pool: fakePool },
  [path.join(ROOT, 'socket.js')]: { getIO: () => ({ emit() {} }) },
})) require.cache[file] = { id: file, filename: file, loaded: true, exports: exp };

function run(handler, req) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {}, set() { return res; },
      json: (b) => resolve({ status: 200, body: b }),
      status: (s) => ({ json: (b) => resolve({ status: s, body: b }), end: () => resolve({ status: s }) }),
    };
    handler(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
    setTimeout(() => resolve({ status: 'timeout' }), 200);
  });
}

// Runs one express middleware and reports how it terminated.
function gate(mw, user) {
  return new Promise((resolve) => {
    const res = { status: (s) => ({ json: (b) => resolve({ status: s, body: b }) }) };
    mw({ user }, res, () => resolve({ status: 'next' }));
  });
}

const HUB_NOPERM = { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false };
// The case a permission-code check alone would miss: a hub login that
// legitimately holds CREATE_INVOICE for the direct-estimate flow.
const HUB_PERMED = { id: 9, hub_id: 3, permissions: new Set(['CREATE_INVOICE']), is_super_admin: false };
const STAFF      = { id: 1, hub_id: null, permissions: new Set(['MANAGE_HUBS']), is_super_admin: false };

(async () => {
  let n = 0;
  const pi = require(path.join(ROOT, 'controllers/purchase_invoices.controller.js'));

  // ── Controller guard ──────────────────────────────────────────────────────
  for (const [label, user] of [['zero-permission hub', HUB_NOPERM], ['hub with CREATE_INVOICE', HUB_PERMED]]) {
    QUERIES = [];
    const r = await run(pi.syncPurchaseInvoiceFromEstimate, { user, params: { id: '42' }, query: {}, body: {} });
    assert.strictEqual(r.status, 403, `sync as ${label}: got ${r.status}, expected 403`);
    n++;
    // Refused BEFORE any read — the invoice is never touched, not even loaded.
    assert.strictEqual(QUERIES.length, 0, `sync as ${label}: ran ${QUERIES.length} queries before refusing`);
    n++;
    // The message has to tell a workshop owner what to do next, not name a
    // permission code they cannot act on.
    assert.ok(/Spinoto/.test(String(r.body?.error || '')), `sync as ${label}: unhelpful error text`);
    n++;
  }

  // Staff are unaffected: not refused by the hub guard, so they reach the
  // handler body (which then 404s on the empty fake pool).
  QUERIES = [];
  const s = await run(pi.syncPurchaseInvoiceFromEstimate, { user: STAFF, params: { id: '42' }, query: {}, body: {} });
  assert.notStrictEqual(s.status, 403, 'staff sync blocked — regression');
  assert.ok(QUERIES.length > 0, 'staff sync never reached the invoice lookup');
  n += 2;

  // ── Route gate ────────────────────────────────────────────────────────────
  // Capture the middleware the router actually mounts, so a future rewiring
  // back to requirePermissionOrHub fails here rather than in production.
  const express = require(path.join(require('path').resolve(__dirname, '..') + '/node_modules/express'));
  const mounted = {};
  const realRouter = express.Router;
  express.Router = function () {
    const r = realRouter.apply(this, arguments);
    for (const m of ['get', 'post', 'patch', 'delete']) {
      const orig = r[m].bind(r);
      r[m] = (p, ...rest) => { if (rest.length > 1) mounted[`${m} ${p}`] = rest[0]; return orig(p, ...rest); };
    }
    return r;
  };
  require(path.join(ROOT, 'routes/purchase_invoices.routes.js'));
  express.Router = realRouter;

  const syncGate = mounted['post /:id/sync-from-estimate'];
  assert.ok(syncGate, 'sync-from-estimate route not found — did the path change?');
  n++;

  for (const [label, user, expect] of [
    ['zero-permission hub', HUB_NOPERM, 403],
    ['hub with CREATE_INVOICE', HUB_PERMED, 'next'],  // gate passes; controller refuses
    ['staff with MANAGE_HUBS', STAFF, 'next'],
  ]) {
    const g = await gate(syncGate, user);
    assert.strictEqual(g.status, expect, `sync route gate, ${label}: got ${g.status}, expected ${expect}`);
    n++;
  }

  // The generation route keeps its hub bypass — raising the invoice once is
  // not editing it, and the hub direct-estimate flow depends on it.
  const genGate = mounted['post /generate'];
  assert.ok(genGate, 'generate route not found');
  assert.strictEqual((await gate(genGate, HUB_NOPERM)).status, 'next', 'hub can no longer generate — regression');
  n += 2;

  // Approval, rate edits and payments stay closed to hubs.
  for (const key of ['post /:id/approve', 'patch /:id', 'post /:id/recalculate', 'post /:id/payments']) {
    assert.strictEqual((await gate(mounted[key], HUB_NOPERM)).status, 403, `${key}: hub not blocked`);
    n++;
  }

  console.log(`hub write access: ${n} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
