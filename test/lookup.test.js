/**
 * lookupCustomers: the hub mode must be exact-match, number-only, and must
 * never reach the DB with a partial. Staff mode must keep partial + name.
 */
const path = require('path'); const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

let captured = [];
const fakePool = {
  query: async (text, params) => {
    captured.push({ text: String(text), params: params || [] });
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};
for (const [f, e] of Object.entries({
  [path.join(ROOT,'config/db.js')]: { pool: fakePool },
  [path.join(ROOT,'socket.js')]:    { getIO: () => ({ emit(){} }) },
})) require.cache[f] = { id:f, filename:f, loaded:true, exports:e };

const ctrl = require(path.join(ROOT,'controllers/customers.controller.js'));

function run(req){ return new Promise(res=>{
  const r = { json:b=>res({status:200,body:b}), status:s=>({json:b=>res({status:s,body:b})}) };
  ctrl.lookupCustomers(req, r, e=>res({status:e?.status||500, body:{error:e?.message}}));
  setTimeout(()=>res({status:'timeout'}), 200);
});}

const HUB   = { id:9, hub_id:3, permissions:new Set() };
const STAFF = { id:1, hub_id:null, permissions:new Set(['VIEW_CUSTOMER']) };

(async () => {
  let n = 0;

  // ── HUB: partial input must return empty WITHOUT querying ──
  for (const q of ['9876', '98765432', 'Raj', 'Rajesh Kumar', 'a', 'GJ01']) {
    captured = [];
    const r = await run({ user: HUB, query: { q } });
    assert.strictEqual(r.status, 200, `hub "${q}" status`);
    assert.deepStrictEqual(r.body.items, [], `hub must not match partial "${q}"`);
    assert.strictEqual(captured.length, 0, `hub "${q}" must not hit the DB`);
    n++;
  }

  // ── HUB: a name that is long enough must STILL not search by name ──
  captured = [];
  await run({ user: HUB, query: { q: 'Rajesh Kumar Patel' } });
  assert.strictEqual(captured.length, 0, 'hub name search must never reach the DB');
  n++;

  // ── HUB: complete mobile → queries, and never on customer_name ──
  for (const q of ['9876543210', '98765 43210', '+91 98765 43210']) {
    captured = [];
    await run({ user: HUB, query: { q } });
    assert.strictEqual(captured.length, 1, `hub "${q}" should run exactly one lookup query`);
    const { text, params } = captured[0];
    assert.ok(!/customer_name.{0,40}LIKE/is.test(text), 'hub SQL must not LIKE on customer_name');
    assert.ok(params.includes('9876543210'), `hub "${q}" should normalise to 10 digits, got ${JSON.stringify(params)}`);
    n++;
  }

  // ── HUB: complete plate → queries on the normalised plate ──
  for (const [q, want] of [['GJ01AB1234','GJ01AB1234'], ['gj 01 ab 1234','GJ01AB1234']]) {
    captured = [];
    await run({ user: HUB, query: { q } });
    assert.strictEqual(captured.length, 1, `hub plate "${q}" should query`);
    assert.ok(captured[0].params.includes(want), `plate should normalise to ${want}`);
    n++;
  }

  // ── STAFF: partial and name still work, unchanged ──
  for (const q of ['Raj', '9876', 'Rajesh Kumar']) {
    captured = [];
    const r = await run({ user: STAFF, query: { q } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(captured.length, 1, `staff "${q}" should query`);
    assert.ok(/customer_name.{0,40}LIKE/is.test(captured[0].text), 'staff SQL should match on name');
    assert.ok(captured[0].params.some(p => String(p).includes(q.toLowerCase())), 'staff should pass a LIKE pattern');
    n++;
  }

  // ── mode is reported so the UI can word itself correctly ──
  assert.strictEqual((await run({ user: HUB,   query:{q:'9876543210'} })).body.mode, 'exact');
  assert.strictEqual((await run({ user: STAFF, query:{q:'Raj'} })).body.mode, 'partial');
  n += 2;

  // ── response must never carry commercial or cross-hub fields ──
  const banned = /total_spend|total_appointments|hub_name|hub_id|last_activity|invoice/i;
  captured = [];
  await run({ user: HUB, query: { q: '9876543210' } });
  assert.ok(!banned.test(captured[0].text.replace(/customer_invoices/g,'')),
    'lookup SQL must not select spend/visit/hub columns');
  n++;

  console.log(`lookupCustomers: ${n} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
