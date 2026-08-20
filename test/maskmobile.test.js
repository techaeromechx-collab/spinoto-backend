/**
 * Customer mobile masking for hub logins.
 *
 * The value of this is entirely in it being SERVER-side and DEFAULT-on. A UI
 * that renders 98382xxxxx while the API still ships 9838212345 in the JSON has
 * achieved nothing, and a handler added next year must be covered without its
 * author knowing this exists.
 */
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/src';

const { maskMobile, scrubMobiles } = require(path.join(ROOT, 'utils/maskMobile.js'));
const { maskCustomerContact } = require(path.join(ROOT, 'middleware/maskMobile.middleware.js'));

const HUB   = { user: { id: 9, hub_id: 3, permissions: new Set(), is_super_admin: false } };
const STAFF = { user: { id: 1, hub_id: null, permissions: new Set(['VIEW_INVOICE']), is_super_admin: false } };
const SUPER = { user: { id: 2, hub_id: null, permissions: new Set(), is_super_admin: true } };

let n = 0;

// ── The mask itself ─────────────────────────────────────────────────────────
assert.strictEqual(maskMobile('9838212345'), '98382xxxxx'); n++;
assert.strictEqual(maskMobile('98382 12345'), '98382xxxxx', 'spaces must not shift the mask'); n++;
assert.strictEqual(maskMobile('+91 98382 12345'), '98382xxxxx', 'a country code must not become the visible part'); n++;
assert.strictEqual(maskMobile('919838212345'), '98382xxxxx', '91-prefixed masks the same as bare'); n++;
assert.strictEqual(maskMobile('00919838212345'), '98382xxxxx'); n++;

// Exactly five digits survive, and no more.
for (const raw of ['9838212345', '919838212345', '+91-98382-12345']) {
  const out = maskMobile(raw);
  assert.strictEqual(out.replace(/[^0-9]/g, '').length, 5, `${raw}: more than five digits survived`); n++;
  assert.strictEqual(out.length, 10, `${raw}: masked value is not 10 characters`); n++;
}

// Anything unrecognisable is masked WHOLE rather than passed through — the
// "leave it alone" branch is exactly where a leak would hide.
for (const raw of ['12345', 'abc', '99']) {
  assert.strictEqual(maskMobile(raw), 'xxxxxxxxxx', `${raw} was passed through`); n++;
}
// Absent stays absent — masking null into a string would invent a number.
for (const raw of [null, undefined, '']) {
  assert.strictEqual(maskMobile(raw), raw, `${JSON.stringify(raw)} was turned into a value`); n++;
}
// Idempotent: a masked value that somehow round-trips must not degrade.
assert.strictEqual(maskMobile(maskMobile('9838212345')), 'xxxxxxxxxx'); n++;

// ── scrubMobiles walks whatever shape it is given ───────────────────────────
const payload = {
  items: [
    { id: 1, customer_name: 'Ramesh', mobile: '9838212345', whatsapp: '919838212345' },
    { id: 2, mobile: null },
  ],
  item: {
    mobile: '9876543210',
    hub_payments: [{ id: 5, mobile: '9000000001' }],
    nested: { deep: { mobile: '9000000002' } },
  },
  // Keys that are NOT the customer's number must survive untouched.
  owner_mobile: '9111111111',
  contact_number: '9222222222',
  rm_mobile: '9333333333',
  total: 4,
};

const staffOut = scrubMobiles(STAFF, payload);
assert.strictEqual(staffOut, payload, 'staff payload should be returned untouched, same reference'); n++;
assert.strictEqual(scrubMobiles(SUPER, payload), payload, 'super admin payload was altered'); n++;

const hubOut = scrubMobiles(HUB, payload);
assert.strictEqual(hubOut.items[0].mobile, '98382xxxxx'); n++;
assert.strictEqual(hubOut.items[0].whatsapp, '98382xxxxx', 'whatsapp is a second direct channel and must mask too'); n++;
assert.strictEqual(hubOut.items[0].customer_name, 'Ramesh', 'unrelated fields were altered'); n++;
assert.strictEqual(hubOut.items[1].mobile, null, 'null became a value'); n++;
assert.strictEqual(hubOut.item.mobile, '98765xxxxx'); n++;
assert.strictEqual(hubOut.item.hub_payments[0].mobile, '90000xxxxx', 'nested array not walked'); n++;
assert.strictEqual(hubOut.item.nested.deep.mobile, '90000xxxxx', 'deeply nested not walked'); n++;
assert.strictEqual(hubOut.total, 4); n++;

// The hub's OWN contact details are theirs.
assert.strictEqual(hubOut.owner_mobile, '9111111111', "the hub's own owner_mobile was masked"); n++;
assert.strictEqual(hubOut.contact_number, '9222222222', "the hub's own contact_number was masked"); n++;
assert.strictEqual(hubOut.rm_mobile, '9333333333', "the RM's number was masked"); n++;

// The input must not be mutated — a handler may reuse the row it passed in.
assert.strictEqual(payload.items[0].mobile, '9838212345', 'scrubMobiles mutated its input'); n++;

// ── The middleware ──────────────────────────────────────────────────────────
function throughMiddleware(reqLike) {
  let sent = null;
  const res = { json: (b) => { sent = b; return res; } };
  maskCustomerContact({ ...reqLike }, res, () => {});
  res.json({ items: [{ mobile: '9838212345' }] });
  return sent;
}
assert.strictEqual(throughMiddleware(HUB).items[0].mobile, '98382xxxxx', 'middleware did not mask for a hub'); n++;
assert.strictEqual(throughMiddleware(STAFF).items[0].mobile, '9838212345', 'middleware masked for staff'); n++;

// ── Every hub-reachable router that carries customer data mounts it ─────────
// This is the check that matters: coverage by default, not by remembering.
for (const f of ['appointments', 'estimates', 'customer_invoices', 'purchase_invoices']) {
  const src = fs.readFileSync(path.join(ROOT, `routes/${f}.routes.js`), 'utf8');
  assert.ok(/maskMobile\.middleware/.test(src), `${f}.routes.js does not import the mask`); n++;
  // Importing it is not using it. Count mentions OUTSIDE the require line —
  // my first version of this check passed on a router where the mount had been
  // deleted, because the import alone satisfied it.
  const uses = src.split('\n')
    .filter(l => l.includes('maskCustomerContact') && !l.includes('require('))
    .length;
  assert.ok(uses > 0, `${f}.routes.js imports the mask but never mounts it`); n++;
}

// customers.routes.js must NOT mount it: /lookup is exact-match, so the hub
// already knows the number, and the direct-estimate flow needs the real value
// back to attach the estimate to a customer identity.
const custRoutes = fs.readFileSync(path.join(ROOT, 'routes/customers.routes.js'), 'utf8');
assert.ok(!/maskCustomerContact/.test(custRoutes),
  'customers.routes.js mounts the mask — this breaks hub direct estimates'); n++;

// ── The PDF path ────────────────────────────────────────────────────────────
const adapter = fs.readFileSync(path.join(ROOT, 'templates/documentAdapter.js'), 'utf8');
assert.ok(/function buyerPhone\(row, cfg\)/.test(adapter), 'documentAdapter has no buyerPhone helper'); n++;
assert.ok(!/phone: row\.mobile/.test(adapter), 'a raw row.mobile still reaches a rendered document'); n++;
// Three now: the estimate, the customer invoice and the advance receipt. Every
// document that names a CUSTOMER must mask the number on a hub's copy — a count
// that lags behind reality is a document quietly printing an unmasked mobile.
assert.strictEqual((adapter.match(/phone: buyerPhone\(row, cfg\)/g) || []).length, 3,
  'a customer-facing document does not mask the mobile on a hub copy'); n++;

// ── The CSV export ──────────────────────────────────────────────────────────
// res.json wrapping cannot reach a res.send(csv), and a spreadsheet is the one
// artefact a full contact list would really be useful in.
const ci = fs.readFileSync(path.join(ROOT, 'controllers/customer_invoices.controller.js'), 'utf8');
assert.ok(/maskFor\(req, inv\.mobile\)/.test(ci), 'the CSV export still writes a raw mobile'); n++;

// ── The masked value must not produce a broken WhatsApp link ────────────────
// waTarget returns null for anything that is not a real Indian mobile, and the
// UI already hides the button on null — so this holds without a UI change.
const phoneSrc = fs.readFileSync(require('path').resolve(__dirname, '../../frontend/src') + '/lib/phone.js', 'utf8').replace(/^export /gm, '');
const { waTarget } = new Function(`${phoneSrc}; return { waTarget };`)();
assert.strictEqual(waTarget({ mobile: '98382xxxxx' }), null,
  'a masked number produces a WhatsApp link — the button would render and 404'); n++;
assert.strictEqual(waTarget({ whatsapp: '98382xxxxx', mobile: '98382xxxxx' }), null); n++;
assert.ok(waTarget({ mobile: '9838212345' }), 'staff lost their WhatsApp link — regression'); n++;

console.log(`mobile masking: ${n} checks passed`);
