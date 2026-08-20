/**
 * Hub self-service profile + admin password reset.
 *
 * The whole value of PATCH /api/hubs/me is that it is NARROW. If it ever grows
 * a commercial field, a workshop can set its own commission or move its own
 * payout account. That is what most of this file guards.
 */
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

let QUERIES = [];
let ROWS = [];
const fakePool = {
  query: async (sql, params) => { QUERIES.push({ sql: String(sql), params }); return { rows: ROWS, rowCount: ROWS.length }; },
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
    setTimeout(() => resolve({ status: 'timeout' }), 400);
  });
}

const HUB   = { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false };
const STAFF = { id: 1, hub_id: null, permissions: new Set(['MANAGE_HUBS', 'EDIT_HUB']), is_super_admin: false };
const SUPER = { id: 2, hub_id: null, permissions: new Set(), is_super_admin: true };

// Fields that must NEVER be writable from the hub portal, and why.
const FORBIDDEN = {
  has_gst:             'decides whether 18% is added to their payout',
  bank_account_number: 'payout destination',
  bank_ifsc:           'payout destination',
  account_holder_name: 'payout destination',
  bank_name:           'payout destination',
  commission_percent:  'negotiated commercial term',
  tech_rate_service:   'negotiated commercial term',
  tech_rate_parts:     'negotiated commercial term',
  payout_terms:        'negotiated commercial term',
  gst_number:          'supplier identity on a tax invoice',
  company_name:        'supplier identity on a tax invoice',
  is_active:           'administrative',
  verification_status: 'administrative',
  hub_name:            'administrative',
  rm_user_id:          'administrative',
};

(async () => {
  let n = 0;
  const hubs = require(path.join(ROOT, 'controllers/hubs.controller.js'));

  // ── PATCH /api/hubs/me ─────────────────────────────────────────────────────
  assert.ok(typeof hubs.updateOwnHubProfile === 'function', 'updateOwnHubProfile is not exported'); n++;

  // A staff session has no "own hub" — refused before any query.
  QUERIES = [];
  let r = await run(hubs.updateOwnHubProfile, { user: STAFF, params: {}, query: {}, body: { address_line1: 'x' } });
  assert.strictEqual(r.status, 403, `staff got ${r.status}, expected 403`); n++;
  assert.strictEqual(QUERIES.length, 0, 'staff request still hit the database'); n++;

  // Super admin without a hub_id is equally not a hub — no back door.
  r = await run(hubs.updateOwnHubProfile, { user: SUPER, params: {}, query: {}, body: { address_line1: 'x' } });
  assert.strictEqual(r.status, 403, 'super admin should have no own-hub either'); n++;

  // A hub updating itself: the UPDATE must be pinned to the SESSION's hub id.
  ROWS = [{ id: 3, hub_name: 'QuickFix' }];
  QUERIES = [];
  r = await run(hubs.updateOwnHubProfile, {
    user: HUB, params: {}, query: {},
    body: { address_line1: '12 Nehru Road', pincode: '380015' },
  });
  assert.strictEqual(r.status, 200, `hub self-update got ${r.status}`); n++;
  const upd = QUERIES.find(q => /UPDATE hubs/.test(q.sql));
  assert.ok(upd, 'no UPDATE ran'); n++;
  assert.ok(upd.params.includes(3), 'the UPDATE is not pinned to the session hub id'); n++;
  assert.ok(/WHERE id = \$\d+/.test(upd.sql), 'UPDATE has no WHERE — it would rewrite every hub'); n++;
  assert.ok(/deleted_at IS NULL/.test(upd.sql), 'UPDATE can touch a soft-deleted hub'); n++;

  // The id must come from the session, never the body or the params.
  ROWS = [{ id: 3 }];
  QUERIES = [];
  await run(hubs.updateOwnHubProfile, {
    user: HUB, params: { id: '7' }, query: {},
    body: { id: 7, hub_id: 7, address_line1: 'somewhere else' },
  });
  const upd2 = QUERIES.find(q => /UPDATE hubs/.test(q.sql));
  assert.ok(!upd2.params.includes(7) && !upd2.params.includes('7'),
    'a hub id from the request body or params reached the UPDATE'); n++;

  // THE important one: no commercial or administrative column is settable.
  const updateSql = upd.sql;
  for (const [field, why] of Object.entries(FORBIDDEN)) {
    assert.ok(!new RegExp(`\\b${field}\\s*=`).test(updateSql),
      `PATCH /api/hubs/me can write ${field} — ${why}`); n++;
  }

  // And the schema strips them rather than 400ing, so the error never
  // enumerates which fields exist.
  ROWS = [{ id: 3 }];
  QUERIES = [];
  r = await run(hubs.updateOwnHubProfile, {
    user: HUB, params: {}, query: {},
    body: { address_line1: 'ok', has_gst: true, commission_percent: 0, bank_ifsc: 'HDFC0001234' },
  });
  assert.strictEqual(r.status, 200, 'unknown keys should be stripped, not rejected'); n++;

  // Validation still bites on the fields it does own.
  for (const [body, label] of [
    [{ pincode: '123' },        'short pincode'],
    [{ contact_number: '123' }, 'short contact number'],
    [{ owner_mobile: 'abcdefghij' }, 'non-numeric owner mobile'],
  ]) {
    ROWS = [{ id: 3 }];
    r = await run(hubs.updateOwnHubProfile, { user: HUB, params: {}, query: {}, body });
    assert.strictEqual(r.status, 400, `${label} was accepted`); n++;
  }

  // ── PATCH /api/hubs/:id/login ──────────────────────────────────────────────
  assert.ok(typeof hubs.resetHubLoginPassword === 'function', 'resetHubLoginPassword is not exported'); n++;

  ROWS = [{ id: 42, email: 'quickfix@example.com' }];
  QUERIES = [];
  r = await run(hubs.resetHubLoginPassword, { user: SUPER, params: { id: '3' }, query: {}, body: { password: 'newpass123' } });
  assert.strictEqual(r.status, 200, `reset got ${r.status}`); n++;
  const pwq = QUERIES.find(q => /UPDATE users/.test(q.sql));
  assert.ok(pwq, 'no UPDATE users ran'); n++;
  assert.ok(/WHERE hub_id = \$\d+/.test(pwq.sql), 'reset is not scoped to the hub'); n++;
  // The plaintext must never reach the query — only a bcrypt hash.
  assert.ok(!pwq.params.includes('newpass123'), 'the plaintext password reached the database'); n++;
  assert.ok(/^\$2[aby]\$/.test(pwq.params[0]), 'password was not bcrypt hashed'); n++;
  // The caller is told the session survives, rather than discovering it later.
  assert.ok(/signed in/i.test(String(r.body?.message || '')), 'reset does not mention surviving sessions'); n++;

  ROWS = [];
  r = await run(hubs.resetHubLoginPassword, { user: SUPER, params: { id: '3' }, query: {}, body: { password: 'newpass123' } });
  assert.strictEqual(r.status, 404, 'a hub with no login should 404'); n++;

  ROWS = [{ id: 42, email: 'x@y.z' }];
  r = await run(hubs.resetHubLoginPassword, { user: SUPER, params: { id: '3' }, query: {}, body: { password: 'short' } });
  assert.strictEqual(r.status, 400, 'a 5-character password was accepted'); n++;

  // ── Route wiring ───────────────────────────────────────────────────────────
  const routes = fs.readFileSync(path.join(ROOT, 'routes/hubs.routes.js'), 'utf8');

  // '/me' is a literal segment. Below '/:id' it would be parsed as an id and
  // idParam.parse('me') would throw a 400 on every valid request.
  const iMe = routes.indexOf("router.patch('/me'");
  const iId = routes.indexOf("router.patch('/:id'");
  assert.ok(iMe > -1 && iId > -1, 'could not find both patch routes'); n++;
  assert.ok(iMe < iId, "PATCH '/me' is declared below '/:id' — it will be matched as an id"); n++;

  // All four per-hub login routes agree on one gate.
  for (const verb of ['get', 'post', 'patch', 'delete']) {
    const re = new RegExp(`router\\.${verb}\\('/:id/login',\\s+requireAuth,\\s+requireSuperAdmin`);
    assert.ok(re.test(routes), `${verb.toUpperCase()} /:id/login is not requireSuperAdmin`); n++;
  }
  // The controller's own is_super_admin checks are gone — one gate, not two
  // that disagree about where the refusal happens.
  const ctrl = fs.readFileSync(path.join(ROOT, 'controllers/hubs.controller.js'), 'utf8');
  assert.ok(!/Super admin only/.test(ctrl), 'a redundant in-controller super-admin check survived'); n++;

  // The password endpoint is a current_password oracle; it must be throttled.
  const me = fs.readFileSync(path.join(ROOT, 'routes/me.routes.js'), 'utf8');
  assert.ok(/router\.patch\('\/password', requireAuth, passwordLimit/.test(me),
    'PATCH /api/me/password is not rate limited'); n++;

  console.log(`hub profile + reset: ${n} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
