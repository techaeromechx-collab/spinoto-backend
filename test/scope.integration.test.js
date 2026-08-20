/**
 * Calls the patched list handlers with a stubbed pg pool and asserts the SQL
 * they build. The failure mode this is really guarding against is $n
 * misnumbering — inserting a param shifts every later placeholder.
 */
const path = require('path');
const Module = require('module');
const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

const captured = [];
const fakePool = {
  query: async (text, params) => {
    captured.push({ text: String(text), params: params || [] });
    // Shape that satisfies both `rows[0].count` (count queries) and the
    // `if (!rows[0]) 404` guards, so handlers run to completion.
    return { rows: [{ count: '0', total_ex_gst: 0, total_inc_gst: 0 }], rowCount: 1 };
  },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};

// Stub every module the controllers pull in that needs a live service.
const origResolve = Module._resolveFilename;
const stubs = {
  [path.join(ROOT, 'config/db.js')]: { pool: fakePool },
  [path.join(ROOT, 'socket.js')]: { getIO: () => ({ emit() {} }) },
};
for (const [file, exp] of Object.entries(stubs)) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exp };
}

function run(handler, req) {
  return new Promise((resolve, reject) => {
    // Enough of an Express response for the CSV/export handlers too.
    const res = {
      setHeader() {}, set() { return res; }, type() { return res; },
      send: (b) => resolve({ status: 200, body: b }),
      end: () => resolve({ status: 200 }),
      json: (b) => resolve({ status: 200, body: b }),
      status: (s) => ({ json: (b) => resolve({ status: s, body: b }), end: () => resolve({ status: s }), send: (b) => resolve({ status: s, body: b }) }),
    };
    handler(req, res, (err) => reject(err || new Error('next() called')));
    setTimeout(resolve, 150);
  });
}

const HUB = { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false };
const HUB_WITH_VIEW = { id: 9, hub_id: 3, permissions: new Set(['VIEW_APPOINTMENT','VIEW_ESTIMATE','VIEW_INVOICE']), is_super_admin: false };
const ADMIN = { id: 1, hub_id: null, permissions: new Set(['VIEW_APPOINTMENT','VIEW_ESTIMATE','VIEW_INVOICE']), is_super_admin: true };

function placeholdersOk(text, params) {
  const used = [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
  if (!used.length) return true;
  return Math.max(...used) <= params.length;
}

function hubPinned(text, params, col) {
  const m = text.match(new RegExp(col.replace('.', '\\.') + '\\s*=\\s*\\$(\\d+)'));
  if (!m) return false;
  return params[Number(m[1]) - 1] === 3;
}

(async () => {
  const cases = [
    ['appointments.controller.js', 'listAppointments', 'a.hub_id', { query: {} }],
    ['appointments.controller.js', 'getStats',         'a.hub_id', { query: {} }],
    ['estimates.controller.js',    'listEstimates',    'e.hub_id', { query: {} }],
    ['customer_invoices.controller.js', 'listCustomerInvoices', 'ci.hub_id', { query: {} }],
    ['customer_invoices.controller.js', 'exportCustomerInvoices', 'ci.hub_id', { query: {} }],
    ['purchase_invoices.controller.js', 'listPurchaseInvoices', 'pi.hub_id', { query: {} }],
    ['purchase_invoices.controller.js', 'listPayouts',          'pi.hub_id', { query: {} }],
    ['purchase_invoices.controller.js', 'listHubPayments',      'pi.hub_id', { query: {} }],
    ['purchase_invoices.controller.js', 'getTechRateSummary',   'pi.hub_id', { query: {} }],
    ['hubs.controller.js',         'listHubs',         'h.id',   { query: {} }],
  ];

  let checks = 0;
  for (const [file, fn, col, baseReq] of cases) {
    const mod = require(path.join(ROOT, 'controllers', file));
    assert.ok(typeof mod[fn] === 'function', `${file}#${fn} exported`);

    // ── hub user, NO query params at all: must still be pinned ──
    captured.length = 0;
    await run(mod[fn], { ...baseReq, user: HUB, params: {}, get: () => '' });
    assert.ok(captured.length, `${fn}: ran a query`);
    for (const q of captured) {
      assert.ok(placeholdersOk(q.text, q.params), `${fn}: $n exceeds params\n${q.text}`);
    }
    assert.ok(captured.some(q => hubPinned(q.text, q.params, col)),
      `${fn}: hub NOT pinned with no query params\n` + captured.map(q=>q.text).join('\n---\n').slice(0,900));
    checks++;

    // ── hub user trying to widen via the query string: must be ignored ──
    captured.length = 0;
    await run(mod[fn], { ...baseReq, query: { hub_ids: '1,2,7', hub_id: '7' }, user: HUB, params: {}, get: () => '' });
    for (const q of captured) {
      assert.ok(placeholdersOk(q.text, q.params), `${fn}: $n exceeds params (widen attempt)`);
      assert.ok(!q.params.some(p => Array.isArray(p) && p.includes(7)),
        `${fn}: honoured a hub_ids the caller does not own`);
      assert.ok(!q.params.includes(7), `${fn}: honoured hub_id=7`);
    }
    assert.ok(captured.some(q => hubPinned(q.text, q.params, col)), `${fn}: hub pin lost when query params present`);
    checks++;

    // ── hub user WITH VIEW_* granted: still pinned (the ladder-order bug) ──
    captured.length = 0;
    await run(mod[fn], { ...baseReq, query: {}, user: HUB_WITH_VIEW, params: {}, get: () => '' });
    assert.ok(captured.some(q => hubPinned(q.text, q.params, col)),
      `${fn}: granting VIEW_* widened a hub user across hubs`);
    checks++;

    // ── admin: no hub predicate injected, placeholders still sane ──
    captured.length = 0;
    await run(mod[fn], { ...baseReq, query: {}, user: ADMIN, params: {}, get: () => '' });
    for (const q of captured) {
      assert.ok(placeholdersOk(q.text, q.params), `${fn}: admin $n exceeds params`);
      assert.ok(!q.params.includes(3) || !hubPinned(q.text, q.params, col),
        `${fn}: admin query got a hub pin`);
    }
    checks++;
  }
  console.log(`scope integration: ${checks} scenario checks passed across ${cases.length} handlers`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
