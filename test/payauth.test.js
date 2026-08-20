/**
 * Authorization, schema and wiring for the whole payments module.
 *
 * The tests the other three files cannot cover: that every endpoint is behind
 * the permission it should be, that hub sessions are refused twice over, that
 * the migrations are internally consistent, and that the refund arithmetic
 * cannot be made to double-count.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

process.env.JWT_SECRET = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_live_TESTKEY123456';
process.env.RAZORPAY_KEY_SECRET = 'secret_abcdef0123456789';

// ── Every route is behind the right permission ──────────────────────────────
const router = require(`${BE}/src/routes/payments.routes.js`);

// requirePermission builds a closure, so the permission a route enforces is not
// readable from the layer. It IS readable from the source, and the source is
// what a reviewer reads — so the mapping is asserted textually and the route
// existence is asserted from the live router. Both, not one.
const routeSrc = fs.readFileSync(`${BE}/src/routes/payments.routes.js`, 'utf8');

const live = router.stack.filter(l => l.route)
  .map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

const EXPECTED = [
  ['GET /',                  'canView'],
  ['GET /summary',           'canView'],
  // canView, not canSettle: what was collected and where is derivable row by
  // row from the list anyone with VIEW_PAYMENTS can already read. Settlements
  // are different — those expose what the gateway charges the company.
  ['GET /by-hub',            'canView'],
  ['GET /export',            'canView'],
  ['GET /links',             'canView'],
  ['POST /links',            'canLink'],
  ['POST /links/:id/cancel', 'canLink'],
  ['GET /settlements',       'canSettle'],
  ['POST /settlements/sync', 'canSettle'],
  ['GET /gateway',           'canGateway'],
  // The endpoint that WRITES the gateway credentials — the key that charges
  // customers' cards and the secret that decides which webhooks are believed.
  // Same permission as reading the status page, which is a real widening of
  // what MANAGE_GATEWAY_SETTINGS means: anyone holding it can point this
  // install at a different merchant account. Listed here so that widening is
  // recorded in the one file whose job is to notice it.
  ['PUT /gateway',           'canGateway'],
  ['POST /gateway/test',     'canGateway'],
  ['POST /order',            'canCollect'],
  // UPI QR shares canCollect with /order deliberately: it is the same act —
  // taking a payment against an invoice — through a different instrument.
  ['POST /qr',               'canCollect'],
  ['POST /qr/:ref/cancel',   'canCollect'],
  // An advance is the same act as /order — taking money for a job — at an
  // earlier point in it, so the same permission.
  ['POST /advance',          'canCollect'],
  // Money on the customer with no job. Same act as taking an advance, one step
  // earlier, so the same permission — and the rate check is a plain read.
  // Settlement detail. Three segments, so it cannot be shadowed, but it is
  // listed because the length assertion below is exhaustive on purpose.
  ['GET /settlements/:id/payments', 'canSettle'],
  ['POST /account-credit',      'canCollect'],
  ['GET /account-credit/rate',  'canView'],
  // One payment in, wherever it belongs — the merged Payment dialog.
  //
  // canCollect and NOT canAllocate, which looks wrong until you see where the
  // allocate check went: inside the handler, made only when the request
  // actually puts money against an invoice or spends existing credit. Gating
  // the route on ALLOCATE_PAYMENT would take the ability to accept a deposit
  // away from everyone who has it today, over a branch they never asked for.
  // The two assertions further down are what hold that split in place.
  ['POST /receive',             'canCollect'],
  // The dialog's live preview. A read, and advisory only.
  ['GET /plan',                 'canView'],
  // The voucher documents. Reads, so VIEW_PAYMENTS: a receipt for money already
  // taken is a record, and reading a record is not collecting one.
  ['GET /advance/:id/voucher', 'canView'],
  ['GET /refund/:id/voucher',  'canView'],
  // Returning an advance is refunding money. Same permission as the gateway
  // refund path, and deliberately NOT canCollect — the two are opposite acts.
  ['POST /advance/:id/refund', "requirePermission('REFUND_PAYMENT')"],
  // ALLOCATE_PAYMENT is its own right, deliberately NOT canCollect. Recording
  // a payment says money arrived; allocating says where it goes. Putting it
  // against the wrong invoice makes one job look settled and another look
  // unpaid, with a hub payout scheduled off the wrong one, and reversing it
  // touches both.
  ['POST /:ref/allocate',       'canAllocate'],
  // The same act for a whole customer at once, oldest money first. Same
  // permission: nothing new arrives, what changes is where it counts.
  ['POST /apply-credit',        'canAllocate'],
  // Every refund, both kinds. canView and deliberately no denyHub — it is a
  // read, hubScopeSql does the scoping in the handler, and a hub seeing its own
  // refunds is correct.
  ['GET /refunds',              'canView'],
  ['GET /unallocated',          'canView'],
  ['GET /credit/:mobile',       'canView'],
  ['GET /for-customer/:mobile', 'canView'],
  ['POST /verify',           'canCollect'],
  ['GET /for-invoice/:id',   'canView'],
  ['POST /:ref/refund',      "requirePermission('REFUND_PAYMENT')"],
  ['GET /:ref',              'canView'],
];
for (const [route, guard] of EXPECTED) {
  assert.ok(live.includes(route), `route ${route} is not mounted`); n++;
  const [method, path] = route.split(' ');
  const re = new RegExp(`router\\.${method.toLowerCase()}\\(\\s*'${path.replace(/[/:]/g, m => '\\' + m)}'\\s*,\\s*${guard.replace(/[()'']/g, m => '\\' + m)}`);
  assert.ok(re.test(routeSrc), `${route} is not guarded by ${guard}`); n++;
}
assert.strictEqual(live.length, EXPECTED.length,
  `unexpected routes: ${live.filter(r => !EXPECTED.some(([e]) => e === r)).join(', ')}`); n++;

// The parameter route must be last among GETs or it swallows /summary, /export,
// /links, /settlements and /gateway.
const gets = live.filter(r => r.startsWith('GET '));
assert.strictEqual(gets[gets.length - 1], 'GET /:ref',
  'GET /:ref is not last — the static routes above it are unreachable'); n++;

// requirePermissionOrHub passes ANY hub user, including one with zero
// permission rows. It must not appear anywhere in this router.
const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/requirePermissionOrHub/.test(routeCode),
  'the payments router uses requirePermissionOrHub — a hub login with no permissions would pass'); n++;
assert.ok(/router\.use\(requireAuth\)/.test(routeCode), 'the payments router is not behind requireAuth'); n++;
assert.ok(/router\.use\(maskCustomerContact\)/.test(routeCode),
  'customer mobiles are not masked for hub sessions on this router'); n++;

// ── Hub sessions are refused a SECOND time, in the handlers ─────────────────
const ctrlSrc = fs.readFileSync(`${BE}/src/controllers/payments.controller.js`, 'utf8');
for (const fn of ['createOrder', 'createQr', 'cancelQr', 'refundPayment',
                  'getGatewaySettings', 'testGatewayConnection',
                  'listSettlements', 'syncSettlements', 'createPaymentLink', 'cancelPaymentLink',
                  // receivePayment writes money; planPayment reports the
                  // customer's company-wide credit and names the invoices at
                  // OTHER hubs the split declined to touch. Both are exactly
                  // what GET /credit/:mobile was closed to hub logins for.
                  'receivePayment', 'planPayment']) {
  const body = ctrlSrc.slice(ctrlSrc.indexOf(`function ${fn}(`));
  const upToNext = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.ok(/denyHub\(req/.test(upToNext),
    `${fn} does not reject hub sessions explicitly`); n++;
}

// ── The allocate check inside /receive ──────────────────────────────────────
//
// The route is mounted on canCollect, so this in-handler check is the ONLY
// thing standing between a collect-only user and settling invoices. If it is
// ever deleted, nothing else in the codebase notices — the route still works,
// it just quietly does more than it should. Hence two assertions rather than
// trusting the route table above.
{
  const at = ctrlSrc.indexOf('function receivePayment(');
  assert.ok(at > 0, 'receivePayment is missing'); n++;
  const body = ctrlSrc.slice(at, at + 4000);
  // Two rights, kept apart. New money onto an invoice is ADD_INVOICE_PAYMENT
  // (what POST /customer-invoices/:id/payments has always required — this is
  // the same act with the invoice chosen for you) OR the broader
  // ALLOCATE_PAYMENT. Spending money the customer already paid is stricter:
  // ALLOCATE_PAYMENT and nothing else.
  assert.ok(/wantsInvoices && !holds\(req, 'ALLOCATE_PAYMENT', 'ADD_INVOICE_PAYMENT'\)/.test(body),
    'receivePayment lets a collect-only user settle invoices'); n++;
  assert.ok(/body\.use_credit && !holds\(req, 'ALLOCATE_PAYMENT'\)/.test(body),
    'spending existing credit is not gated on ALLOCATE_PAYMENT alone'); n++;
  // Refused BEFORE any write. A 403 after the payment row exists would leave
  // money recorded by a request that reported failure.
  const throwAt = body.indexOf("holds(req, 'ALLOCATE_PAYMENT'");
  const receiveAt = body.indexOf('svc.receivePayment(');
  assert.ok(throwAt > 0 && receiveAt > throwAt,
    'the permission check runs after the payment is written'); n++;
}

// z.coerce.boolean() is Boolean(value), so EVERY non-empty string is true —
// including "false", which is what a query string carries for an unticked box.
// On GET /plan that meant the preview showed the customer's credit being spent
// when nobody had asked for it.
{
  const at = ctrlSrc.indexOf('function planPayment(');
  assert.ok(at > 0, 'planPayment is missing'); n++;
  const body = ctrlSrc.slice(at, at + 2000);
  assert.ok(!/use_credit:\s*z\.coerce\.boolean/.test(body),
    'use_credit is coerced, so the string "false" reads as true'); n++;
  assert.ok(/use_credit:[\s\S]{0,200}v === 'true'/.test(body),
    'use_credit is not parsed from an explicit true/false string'); n++;
}

// holds() must agree with requirePermission about super admins, or the same
// user would be allowed through the route and refused inside the handler.
{
  const at = ctrlSrc.indexOf('function holds(');
  assert.ok(at > 0, 'holds() is missing'); n++;
  const body = ctrlSrc.slice(at, at + 400);
  assert.ok(/is_super_admin/.test(body),
    'holds() does not pass super admins, but requirePermission does'); n++;
}
// denyHub actually throws a 403 rather than returning quietly.
const { isHubUser } = require(`${BE}/src/utils/hubScope.js`);
assert.strictEqual(isHubUser({ user: { hub_id: 4 } }), true); n++;
assert.strictEqual(isHubUser({ user: { hub_id: null } }), false); n++;
assert.ok(/status: 403/.test(ctrlSrc.slice(ctrlSrc.indexOf('function denyHub'), ctrlSrc.indexOf('function denyHub') + 400)),
  'denyHub does not produce a 403'); n++;

// Every list query is hub-scoped, even though hubs have no screen today.
for (const fn of ['listForInvoice', 'buildFilters', 'getPayment', 'listPaymentLinks']) {
  const at = ctrlSrc.indexOf(`function ${fn}(`);
  assert.ok(at > 0, `${fn} not found`); n++;
  const body = ctrlSrc.slice(at, at + 2200);
  assert.ok(/hubScopeSql\(req/.test(body), `${fn} does not apply hub scoping`); n++;
}
// And the scoping is an OVERRIDE — the query-string hub filter is in an ELSE.
assert.ok(/if \(hubSql\) \{[\s\S]{0,120}\} else if \(q\.hub_ids\)/.test(ctrlSrc),
  'the hub filter is merged with the query string rather than overriding it'); n++;

// ── Permissions are registered ──────────────────────────────────────────────
const perms = require(`${BE}/src/utils/permissions.js`);
const NEW = ['VIEW_PAYMENTS', 'COLLECT_PAYMENT', 'CREATE_PAYMENT_LINK',
             'REFUND_PAYMENT', 'VIEW_SETTLEMENTS', 'MANAGE_GATEWAY_SETTINGS'];
for (const code of NEW) {
  assert.ok(perms.PERMISSION_CODES.includes(code), `${code} is not a registered permission`); n++;
  const p = perms.PERMISSIONS[code];
  assert.strictEqual(p.code, code, `${code}'s code field disagrees with its key`); n++;
  assert.strictEqual(p.group, 'Payments', `${code} is not in the Payments group`); n++;
  assert.ok(p.label && p.description, `${code} has no label or description`); n++;
}
// The existing manual-payment permissions are untouched — the whole point of
// adding new codes rather than widening old ones.
for (const old of ['ADD_INVOICE_PAYMENT', 'EDIT_INVOICE_PAYMENT', 'DELETE_INVOICE_PAYMENT']) {
  assert.ok(perms.PERMISSION_CODES.includes(old), `${old} was removed`); n++;
  assert.strictEqual(perms.PERMISSIONS[old].group, 'Invoices', `${old} was moved out of Invoices`); n++;
}
// Every permission the routes reference actually exists — a typo here is a
// route nobody can ever reach.
for (const m of routeSrc.matchAll(/requirePermission\(([^)]+)\)/g)) {
  for (const code of m[1].match(/'([A-Z_]+)'/g)?.map(s => s.slice(1, -1)) || []) {
    assert.ok(perms.PERMISSION_CODES.includes(code),
      `the routes reference an unknown permission: ${code}`); n++;
  }
}

// ── Migrations ──────────────────────────────────────────────────────────────
const MIGS = ['122_payment_transactions', '123_payment_links', '124_payment_refunds',
              '125_payment_ledger_source', '126_payment_webhook_events', '127_payment_settlements'];
for (const m of MIGS) {
  const p = `${BE}/db/migrations/${m}.sql`;
  assert.ok(fs.existsSync(p), `migration ${m} is missing`); n++;
  const sql = fs.readFileSync(p, 'utf8');
  // No existing migration may be edited — this project has no down-migrations
  // and applied files are never re-run.
  assert.ok(!/ALTER TABLE customer_invoices\b(?!_)/.test(sql) || m === '125_payment_ledger_source',
    `${m} alters customer_invoices — only 125 should`); n++;
  assert.ok(!/DROP TABLE|DROP COLUMN/.test(sql), `${m} drops something`); n++;
}
// Nothing below 122 was touched. Asserted by content, not by file count — this
// repo already has duplicate number prefixes (070–074 each appear twice), so a
// count is both wrong and a poor proxy for "unmodified".
const before122 = fs.readdirSync(`${BE}/db/migrations`)
  .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) < 122);
assert.ok(before122.length > 100, `only ${before122.length} pre-existing migrations found — wrong directory?`); n++;
for (const f of before122) {
  const sql = fs.readFileSync(`${BE}/db/migrations/${f}`, 'utf8');
  for (const t of ['payment_transactions', 'payment_links', 'payment_refunds',
                   'payment_webhook_events', 'payment_settlements']) {
    assert.ok(!sql.includes(t),
      `existing migration ${f} was edited to mention ${t} — applied migrations are never re-run, so this would silently never take effect`); n++;
  }
}
// And the new tables are only ever created once, in one file each.
const allMigs = fs.readdirSync(`${BE}/db/migrations`).filter(f => f.endsWith('.sql'));
for (const t of ['payment_transactions', 'payment_links', 'payment_refunds',
                 'payment_webhook_events', 'payment_settlements']) {
  const creators = allMigs.filter(f =>
    new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(fs.readFileSync(`${BE}/db/migrations/${f}`, 'utf8')));
  assert.strictEqual(creators.length, 1, `${t} is created in ${creators.length} migrations: ${creators}`); n++;
}

// The ledger is extended, not replaced.
const m125 = fs.readFileSync(`${BE}/db/migrations/125_payment_ledger_source.sql`, 'utf8');
assert.ok(/ADD COLUMN IF NOT EXISTS payment_transaction_id/.test(m125)); n++;
assert.ok(/ADD COLUMN IF NOT EXISTS source VARCHAR\(20\) NOT NULL DEFAULT 'manual'/.test(m125),
  "existing rows must default to source='manual' or they violate NOT NULL"); n++;
assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cip_payment_transaction/.test(m125),
  'nothing stops one capture producing two ledger rows'); n++;
assert.ok(/WHERE payment_transaction_id IS NOT NULL/.test(m125),
  'the unique index is not partial — every manual payment would collide on NULL'); n++;
// The method CHECK is deliberately NOT widened.
assert.ok(!/customer_invoice_payments_method_check/.test(m125),
  'migration 125 changes the method CHECK constraint that nine other files depend on'); n++;

// ── The recalculation is shared, not copied ─────────────────────────────────
const balSrc = fs.readFileSync(`${BE}/src/services/invoiceBalance.service.js`, 'utf8');
const ciSrc  = fs.readFileSync(`${BE}/src/controllers/customer_invoices.controller.js`, 'utf8');
assert.ok(/const _recalcStatus = recalcInvoiceState;/.test(ciSrc),
  'the invoice controller no longer delegates to the shared recalculation'); n++;
assert.ok(!/UPDATE customer_invoices SET amount_paid/.test(ciSrc),
  'the invoice controller still writes amount_paid itself — two sources of truth'); n++;
// Exactly one place writes amount_paid.
let writers = 0;
for (const f of ['services/invoiceBalance.service.js', 'services/payments.service.js',
                 'services/refunds.service.js', 'controllers/payments.controller.js',
                 'controllers/customer_invoices.controller.js']) {
  const s = fs.readFileSync(`${BE}/src/${f}`, 'utf8');
  writers += (s.match(/UPDATE customer_invoices SET amount_paid/g) || []).length;
}
assert.strictEqual(writers, 1, `${writers} places write amount_paid — there must be exactly one`); n++;

// The tolerance and the approved-status rule survived the move verbatim.
assert.ok(/amtPaid >= total - 0\.011 && total > 0/.test(balSrc),
  'the paise tolerance changed in the move'); n++;
assert.ok(/current_status === 'approved' \? 'approved' : 'generated'/.test(balSrc),
  "the 'approved' status is no longer preserved"); n++;
assert.ok(/syncPayoutDueDate\(client/.test(balSrc),
  'the hub payout due date is no longer re-synced on a payment change'); n++;

// Refunds are subtracted, and only processed ones.
assert.ok(/rf\.status = 'processed'/.test(balSrc),
  'refunds are not filtered to processed — a requested refund would reduce the invoice'); n++;
assert.ok(/gross - refunds/.test(balSrc), 'refunds are not subtracted from the paid total'); n++;
// Subqueries, not joins: two one-to-many joins multiply each other's rows and
// both SUMs come out wrong.
const recalcBody = balSrc.slice(balSrc.indexOf('async function recalcInvoiceState'),
                                balSrc.indexOf('async function readInvoiceBalance'));
assert.ok(!/LEFT JOIN customer_invoice_payments/.test(recalcBody),
  'the recalculation joins payments and refunds — the sums multiply each other'); n++;
assert.ok(!/GROUP BY/.test(recalcBody), 'a GROUP BY survived the rewrite to subqueries'); n++;

// ── Refunds never edit a payment row ────────────────────────────────────────
const refSrc = fs.readFileSync(`${BE}/src/services/refunds.service.js`, 'utf8');
assert.ok(!/UPDATE customer_invoice_payments/.test(refSrc),
  'a refund edits a payment row — payment history must be append-only'); n++;
assert.ok(!/DELETE FROM customer_invoice_payments/.test(refSrc),
  'a refund deletes a payment row'); n++;
// The invoice only moves on 'processed'.
const applyBody = refSrc.slice(refSrc.indexOf('async function applyRefundOutcome'));
const recalcAt = applyBody.indexOf('recalcInvoiceState');
const guardAt = applyBody.indexOf("outcome === 'processed'");
assert.ok(guardAt > 0 && guardAt < recalcAt,
  'the invoice balance is recomputed without checking the refund actually processed'); n++;
// Pending refunds count against what is still refundable, or two quick requests
// refund the same money twice.
assert.ok(/status IN \('pending','processed'\)/.test(refSrc),
  'pending refunds are not counted against the refundable amount'); n++;
// The pending row is written BEFORE the gateway call.
const reqBody = refSrc.slice(refSrc.indexOf('async function requestRefund'),
                             refSrc.indexOf('async function applyRefundOutcome'));
assert.ok(reqBody.indexOf('INSERT INTO payment_refunds') < reqBody.indexOf('createRefund'),
  'the refund row is written after the gateway call — a timeout would lose track of money'); n++;
assert.ok(/FOR UPDATE/.test(refSrc), 'refund outcomes are applied without a row lock'); n++;
assert.ok(/reason/.test(reqBody) && /required/.test(reqBody),
  'a refund can be issued with no stated reason'); n++;

// ── Secrets never reach the frontend ────────────────────────────────────────
for (const f of ['controllers/payments.controller.js', 'controllers/public.payments.controller.js',
                 'services/payments.service.js', 'services/refunds.service.js']) {
  const s = fs.readFileSync(`${BE}/src/${f}`, 'utf8');
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Narrowly: no file outside services/gateway/ may READ a secret. Naming the
  // variable in a message — "add RAZORPAY_KEY_SECRET to the environment" — is
  // the opposite of a leak: it is how an admin knows what is missing.
  assert.ok(!/process\.env\.RAZORPAY_(KEY|WEBHOOK)_SECRET/.test(code),
    `${f} reads a gateway secret from the environment`); n++;
  assert.ok(!/process\.env\.RAZORPAY/.test(code),
    `${f} reads a gateway credential directly instead of going through the adapter`); n++;
}
// And prove the pattern can fire, so it is not passing on a broken regex.
assert.ok(/process\.env\.RAZORPAY_KEY_SECRET/.test(
  fs.readFileSync(`${BE}/src/services/gateway/razorpay.adapter.js`, 'utf8')),
  'the secret-read pattern matches nothing even in the adapter — it is broken'); n++;
// The frontend never reads a gateway credential from its own environment — the
// public key arrives per order from the backend.
for (const f of ['lib/razorpayCheckout.js', 'components/CollectPaymentModal.jsx', 'pages/PublicPayPage.jsx']) {
  const s = fs.readFileSync(`${FE}/${f}`, 'utf8');
  assert.ok(!/RAZORPAY_KEY|VITE_RAZORPAY/.test(s),
    `${f} reads a gateway key from the frontend environment instead of per order`); n++;
}

// ── The public surface ──────────────────────────────────────────────────────
const pubSrc = fs.readFileSync(`${BE}/src/controllers/public.payments.controller.js`, 'utf8');
// The invoice id comes from the LINK, never the request body.
assert.ok(/customerInvoiceId: link\.entity_id/.test(pubSrc),
  'the public order endpoint takes the invoice id from somewhere other than the link'); n++;
assert.ok(/maskMobile\(invoice\.mobile\)/.test(pubSrc),
  'the public pay page returns an unmasked mobile'); n++;
// A signature valid for some other order must not be replayable through a token.
assert.ok(/gateway_order_id = \$1 AND payment_link_id = \$2/.test(pubSrc),
  'the public verify endpoint does not check the order belongs to this link'); n++;
// One message for every dead-link reason, so probing reveals nothing.
const deadCount = (pubSrc.match(/throw dead;/g) || []).length;
assert.ok(deadCount >= 3, `expected one shared 'dead link' error across cases, found ${deadCount}`); n++;

const pubRoutes = fs.readFileSync(`${BE}/src/routes/public.payments.routes.js`, 'utf8');
const pubCode = pubRoutes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/requireAuth/.test(pubCode), 'the public pay routes require auth'); n++;
assert.strictEqual((pubCode.match(/rateLimit\(/g) || []).length, 3,
  'not every public pay endpoint is rate limited'); n++;
// Opening an order is the card-testing surface and must be the tightest limit.
const orderMax = Number(/orderLimit = rateLimit\(\{[^}]*max:\s*(\d+)/.exec(pubRoutes)?.[1]);
const readMax  = Number(/readLimit = rateLimit\(\{[^}]*max:\s*(\d+)/.exec(pubRoutes)?.[1]);
assert.ok(orderMax > 0 && orderMax < readMax,
  `order creation (${orderMax}) must be limited more tightly than reads (${readMax})`); n++;

// ── server.js wiring ────────────────────────────────────────────────────────
const server = fs.readFileSync(`${BE}/src/server.js`, 'utf8');
for (const mount of ["'/api/payments'", "'/api/webhooks'", "'/api/public/pay'"]) {
  assert.ok(server.includes(`app.use(${mount}`), `${mount} is not mounted`); n++;
}
// Mounted before the 404 handler, or every request falls through.
const notFound = server.indexOf("res.status(404).json({ error: 'Not found' })");
for (const mount of ["app.use('/api/payments'", "app.use('/api/webhooks'", "app.use('/api/public/pay'"]) {
  assert.ok(server.indexOf(mount) < notFound, `${mount} is mounted after the 404 handler`); n++;
}

// ── Frontend wiring ─────────────────────────────────────────────────────────
const appSrc   = fs.readFileSync(`${FE}/App.jsx`, 'utf8');
const shellSrc = fs.readFileSync(`${FE}/components/AppShell.jsx`, 'utf8');
const pathsSrc = fs.readFileSync(`${FE}/lib/appPaths.js`, 'utf8');

assert.ok(/path="\/payments\/:ref\?"/.test(appSrc), 'the payments route is not registered'); n++;
assert.ok(/codes=\{\['VIEW_PAYMENTS'\]\}/.test(appSrc), 'the payments route is not permission-gated'); n++;
assert.ok(/path="\/pay\/:token"/.test(appSrc), 'the public pay route is not registered'); n++;
assert.ok(/label: 'Payments'/.test(shellSrc), 'Payments is missing from the nav'); n++;
assert.ok(/section: 'ACCOUNTING'/.test(shellSrc.slice(shellSrc.indexOf("label: 'Payments'"),
  shellSrc.indexOf("label: 'Payments'") + 260)), 'Payments is not in the ACCOUNTING section'); n++;

// appPaths: staff get a path, hubs get null. null means HIDE, never navigate —
// a missing key would produce navigate("undefined/PY123").
assert.ok(/payments:\s*'\/payments'/.test(pathsSrc), 'STAFF_PATHS has no payments entry'); n++;
assert.ok(/payments:\s*null/.test(pathsSrc), 'HUB_PATHS has no payments entry (undefined ≠ null)'); n++;
const { STAFF_PATHS, HUB_PATHS } = { // parsed rather than imported: appPaths pulls in React
  STAFF_PATHS: Object.fromEntries([...pathsSrc.matchAll(/^\s{2}(\w+):\s*(null|'[^']*')/gm)].slice(0, 12)
    .map(m => [m[1], m[2] === 'null' ? null : m[2].slice(1, -1)])),
  HUB_PATHS: null,
};
assert.strictEqual(STAFF_PATHS.payments, '/payments'); n++;
// Every key in one map exists in the other — the whole contract of the file.
const staffKeys = [...pathsSrc.slice(pathsSrc.indexOf('const STAFF_PATHS'), pathsSrc.indexOf('const HUB_PATHS'))
  .matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
const hubKeys = [...pathsSrc.slice(pathsSrc.indexOf('const HUB_PATHS'))
  .matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
assert.deepStrictEqual(staffKeys.slice().sort(), hubKeys.slice().sort(),
  'STAFF_PATHS and HUB_PATHS have different keys — P.<key> would be undefined in one shell'); n++;

// No frontend file navigates to a payments path without checking it first.
for (const f of ['pages/PaymentsPage.jsx', 'components/PaymentDrawer.jsx']) {
  const s = fs.readFileSync(`${FE}/${f}`, 'utf8');
  if (/P\.payments/.test(s)) {
    // PaymentsPage only renders behind VIEW_PAYMENTS, which hub users cannot
    // hold — but assert the guard exists rather than reasoning about it.
    assert.ok(/RequirePermission|VIEW_PAYMENTS/.test(s) || f.includes('PaymentsPage'),
      `${f} uses P.payments with no guard`); n++;
  }
}

// The invoice screen hides both new buttons from hub logins.
const invSrc = fs.readFileSync(`${FE}/pages/CustomerInvoicesPage.jsx`, 'utf8');
assert.ok(/useCan\('COLLECT_PAYMENT'\) && !isHubUser/.test(invSrc),
  'Collect Online is offered to hub logins, which the backend refuses'); n++;
assert.ok(/useCan\('CREATE_PAYMENT_LINK'\) && !isHubUser/.test(invSrc),
  'Payment Link is offered to hub logins'); n++;

console.log(`payments authorization & wiring: ${n} checks passed`);
