const assert = require('assert');
const { hubScopeSql, assertHubOwns, isHubUser } = require(require('path').resolve(__dirname, '..') + '/src/utils/hubScope');

const hub  = { user: { id: 9, hub_id: 3, permissions: new Set() } };
const staff= { user: { id: 1, hub_id: null, permissions: new Set(['VIEW_INVOICE']) } };
const sa   = { user: { id: 2, hub_id: null, is_super_admin: true, permissions: new Set() } };

// 1. staff + super admin are unaffected — the invariant for this whole change
for (const r of [staff, sa]) {
  const p = [];
  assert.strictEqual(hubScopeSql(r, p, 'ci.hub_id'), null);
  assert.deepStrictEqual(p, [], 'no param pushed for non-hub users');
  assert.doesNotThrow(() => assertHubOwns(r, { hub_id: 99 }));
  assert.doesNotThrow(() => assertHubOwns(r, null));
}

// 2. hub user gets a pinned predicate using the right placeholder index
const p = ['%swift%'];
assert.strictEqual(hubScopeSql(hub, p, 'ci.hub_id'), 'ci.hub_id = $2');
assert.deepStrictEqual(p, ['%swift%', 3]);

// 3. record guard
assert.doesNotThrow(() => assertHubOwns(hub, { hub_id: 3 }));
for (const bad of [{ hub_id: 4 }, { hub_id: null }, null, undefined, {}]) {
  assert.throws(() => assertHubOwns(hub, bad), e => e.status === 404, 'must 404: ' + JSON.stringify(bad));
}
// NULL hub_id is invisible to a hub user (decision 0b)
assert.throws(() => assertHubOwns(hub, { hub_id: null }), e => e.status === 404);

// 4. never leaks existence via the status code
try { assertHubOwns(hub, { hub_id: 4 }); } catch (e) {
  assert.strictEqual(e.status, 404);
  assert.ok(!/forbidden|permission|hub 4/i.test(e.message), 'message must not describe the other hub');
}

assert.strictEqual(isHubUser(hub), true);
assert.strictEqual(isHubUser(staff), false);
assert.strictEqual(isHubUser({}), false);

console.log('hubScope: 20 assertions passed');
