/** Record + PDF guards: another hub's id must 404, never 403, never 200. */
const path = require('path'); const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

let ROW = null;
const fakePool = {
  query: async () => ({ rows: ROW ? [ROW] : [], rowCount: ROW ? 1 : 0 }),
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
      send: (b) => resolve({ status: 200, body: b }),
      status: (s) => ({ json: (b) => resolve({ status: s, body: b }), end: () => resolve({ status: s }), send: (b) => resolve({ status: s, body: b }) }),
    };
    handler(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
    setTimeout(() => resolve({ status: 'timeout' }), 200);
  });
}

const HUB   = { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false };
const ADMIN = { id: 1, hub_id: null, permissions: new Set(['VIEW_INVOICE','VIEW_ESTIMATE','VIEW_APPOINTMENT']), is_super_admin: true };

(async () => {
  const cases = [
    ['appointments.controller.js',       'getAppointment'],
    ['estimates.controller.js',          'getEstimate'],
    ['customer_invoices.controller.js',  'getCustomerInvoice'],
    ['purchase_invoices.controller.js',  'getPurchaseInvoice'],
  ];
  let n = 0;
  for (const [file, fn] of cases) {
    const mod = require(path.join(ROOT, 'controllers', file));

    // another hub's record → 404, and the message must not describe it
    ROW = { id: 42, hub_id: 7, status: 'generated', items: [] };
    let r = await run(mod[fn], { user: HUB, params: { id: '42' }, query: {}, get: () => '' });
    assert.strictEqual(r.status, 404, `${fn}: cross-hub read returned ${r.status}, expected 404`);
    assert.ok(!/7|forbid|permission/i.test(String(r.body?.error || '')), `${fn}: 404 body leaks detail`);
    n++;

    // record with NO hub (decision 0b: unassigned is not theirs) → 404
    ROW = { id: 42, hub_id: null, status: 'generated', items: [] };
    r = await run(mod[fn], { user: HUB, params: { id: '42' }, query: {}, get: () => '' });
    assert.strictEqual(r.status, 404, `${fn}: NULL-hub record returned ${r.status}, expected 404`);
    n++;

    // own record → reaches the handler (not 404 from the guard)
    ROW = { id: 42, hub_id: 3, status: 'generated', items: [] };
    r = await run(mod[fn], { user: HUB, params: { id: '42' }, query: {}, get: () => '' });
    assert.notStrictEqual(r.status, 404, `${fn}: hub blocked from its OWN record`);
    n++;

    // admin reads anything — the invariant
    ROW = { id: 42, hub_id: 7, status: 'generated', items: [] };
    r = await run(mod[fn], { user: ADMIN, params: { id: '42' }, query: {}, get: () => '' });
    assert.notStrictEqual(r.status, 404, `${fn}: ADMIN behaviour changed — regression`);
    n++;
  }
  console.log(`record guards: ${n} checks passed across ${cases.length} handlers`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
