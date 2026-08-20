/**
 * Phase B + C — one payments list, and hub-wise collections.
 *
 * The defect this fixes is quiet rather than loud: the Payments screen read
 * payment_transactions alone, so it showed every online payment and no cash.
 * "Collected" was a real number under a true-sounding label that excluded most
 * of a workshop's actual takings.
 *
 * Most of what is pinned here is the union — that both sides carry the columns
 * the filters, the projection, the totals and the export all key on, and that
 * neither side can pick up the other's refunds or be mistaken for it.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripSql = s => s.replace(/^\s*--.*$/gm, '');

const ctrl   = fs.readFileSync(`${BE}/src/controllers/payments.controller.js`, 'utf8');
const code   = strip(ctrl);
const svc    = strip(fs.readFileSync(`${BE}/src/services/payments.service.js`, 'utf8'));
const ciCtrl = strip(fs.readFileSync(`${BE}/src/controllers/customer_invoices.controller.js`, 'utf8'));
const routes = strip(fs.readFileSync(`${BE}/src/routes/payments.routes.js`, 'utf8'));
const m131   = stripSql(fs.readFileSync(`${BE}/db/migrations/131_payment_ledger_hub.sql`, 'utf8'));
const m132   = stripSql(fs.readFileSync(`${BE}/db/migrations/132_deprecate_invoice_payments.sql`, 'utf8'));

// ── The union ───────────────────────────────────────────────────────────────
assert.ok(/const PAY_UNION = `\(/.test(code), 'there is no union — the list is still one table'); n++;
const union = code.slice(code.indexOf('const PAY_UNION'), code.indexOf('const PAY_SELECT'));

assert.ok(/FROM payment_transactions t/.test(union), 'the union does not read gateway transactions'); n++;
assert.ok(/FROM customer_invoice_payments cip/.test(union), 'the union does not read the ledger'); n++;
assert.ok(/UNION ALL/.test(union), 'the two sides are not unioned'); n++;

// UNION ALL, never UNION: DISTINCT would silently collapse two genuinely
// separate cash payments of the same amount, on the same day, at the same hub.
assert.ok(!/\bUNION\s+SELECT/.test(union), 'UNION without ALL — two identical cash payments would become one'); n++;

// Only manual rows from the ledger. A gateway capture writes BOTH a
// payment_transactions row and a ledger row, so without this filter every
// online payment appears twice and Collected doubles.
assert.ok(/WHERE cip\.source = 'manual'/.test(union),
  "the ledger side is not filtered to source='manual' — every gateway payment would be counted twice"); n++;

// Both sides must project the same column list, in the same order, or Postgres
// aligns them positionally and quietly puts a method into a status.
{
  const [gw, mn] = union.split('UNION ALL');
  const aliases = s => [...s.matchAll(/AS ([a-z_]+)/g)].map(m => m[1]);
  const gwCols = aliases(gw), mnCols = aliases(mn);
  // Every alias the manual side declares must exist on the gateway side too.
  for (const c of ['kind', 'txn_id', 'ledger_id', 'row_key']) {
    assert.ok(gwCols.includes(c), `the gateway side does not declare ${c}`); n++;
    assert.ok(mnCols.includes(c), `the manual side does not declare ${c}`); n++;
  }
}

// The synthesised values, each of which a total depends on.
assert.ok(/'captured'::varchar\s+AS status/.test(union),
  'manual rows have no captured status — they would drop out of Collected'); n++;
assert.ok(/'live'::varchar\s+AS mode/.test(union),
  'manual rows have no mode — a mode filter would hide all cash'); n++;
assert.ok(/'customer_invoice'::varchar AS entity_type/.test(union),
  'manual rows have no entity_type — the invoice column would be empty'); n++;
assert.ok(/cip\.method\s+AS method_detail/.test(union),
  'the ledger method is not mapped onto method_detail'); n++;
assert.ok(/cip\.customer_invoice_id\s+AS entity_id/.test(union),
  'manual rows do not carry their invoice id'); n++;

// paid_at, not created_at: a backdated cash entry belongs on the day the money
// arrived, which is what the list orders and the date filter compares.
assert.ok(/cip\.paid_at\s+AS created_at/.test(union),
  'manual rows are dated by when they were typed in, not when the money arrived'); n++;

// hub_id on BOTH sides, or hub scoping applies to half the rows.
assert.ok(/t\.hub_id/.test(union.split('UNION ALL')[0]), 'the gateway side has no hub_id'); n++;
assert.ok(/cip\.hub_id/.test(union.split('UNION ALL')[1]),
  'the ledger side has no hub_id — a hub login would see other hubs\' cash'); n++;

// ── Refunds cannot cross the union ──────────────────────────────────────────
assert.ok(/rf\.payment_transaction_id = t\.txn_id/.test(code),
  'refunds are matched on the row id rather than the transaction id'); n++;
assert.ok(/rf\.ledger_payment_id = t\.ledger_id/.test(code),
  'a refund booked against a ledger row is never found'); n++;

// Scoped to the queries that read the UNION, not the whole file.
//
// listForInvoice has its own SELECT straight off payment_transactions, where
// `t` really is that table and `t.id` really is the transaction id — a
// file-wide ban on `rf.payment_transaction_id = t.id` fails on correct code.
// What must not happen is the union's row_key ('T41', a string) reaching an
// integer column.
{
  // Just the template literal. Slicing to the next `const` swept in
  // listForInvoice, whose own query is the legitimate case above.
  const psStart = code.indexOf('const PAY_SELECT');
  const paySelect = code.slice(psStart, code.indexOf('`;', psStart));
  const summary   = code.slice(code.indexOf('function paymentsSummary('), code.indexOf('function paymentsByHub('));
  const byHubQ    = code.slice(code.indexOf('function paymentsByHub('), code.indexOf('function getPayment('));
  for (const [name, block] of [['PAY_SELECT', paySelect], ['paymentsSummary', summary], ['paymentsByHub', byHubQ]]) {
    assert.ok(!/rf\.payment_transaction_id = t\.id\b/.test(block),
      `${name} matches refunds on t.id — the union's row_key is a string and that column is an integer`); n++;
  }
}

// ── Identity ────────────────────────────────────────────────────────────────
// A transaction and a ledger row can both be numbered 41.
assert.ok(/'T' \|\| t\.id\s+AS row_key/.test(union), 'gateway rows have no prefixed key'); n++;
assert.ok(/'M' \|\| cip\.id\s+AS row_key/.test(union), 'manual rows have no prefixed key'); n++;
assert.ok(/t\.row_key AS id/.test(code), 'the projection does not expose row_key as the row id'); n++;
assert.ok(/ORDER BY t\.created_at DESC, t\.row_key DESC/.test(code),
  'the list orders on a non-unique id — two rows numbered 41 would interleave unstably'); n++;

// getPayment must use the integer, not the key.
{
  const gp = code.slice(code.indexOf('function getPayment('), code.indexOf('function exportPayments('));
  assert.ok(/\[txn\.txn_id\]/.test(gp),
    'the refunds lookup passes the row_key into an integer column — a 22P02 on the support screen'); n++;
  assert.ok(!/\[txn\.id\]/.test(gp), 'getPayment still uses txn.id'); n++;
  assert.ok(/\[txn\.txn_id, txn\.gateway_payment_id\]/.test(gp),
    'the webhook-events lookup still uses the row key'); n++;
}

// ── Every read path uses the union, none reads the bare table ───────────────
for (const fn of ['listPayments', 'paymentsSummary', 'paymentsByHub']) {
  const body = code.slice(code.indexOf(`function ${fn}(`));
  const upTo = body.slice(0, body.indexOf('\n}\n') + 1);
  assert.ok(/\$\{PAY_UNION\}|\$\{PAY_SELECT\}/.test(upTo),
    `${fn} does not read the union — it would answer for one source only`); n++;
  assert.ok(!/FROM payment_transactions t\b/.test(upTo),
    `${fn} still reads payment_transactions directly`); n++;
}

// ── The source filter ───────────────────────────────────────────────────────
assert.ok(/source:\s+z\.enum\(\['manual', 'gateway'\]\)\.optional\(\)/.test(code),
  'there is no source filter'); n++;
assert.ok(/if \(q\.source\) \{ params\.push\(q\.source\);\s*where\.push\(`t\.kind = \$/.test(code),
  'the source filter is not applied'); n++;
// Absent must mean BOTH — that is the entire point of the phase.
assert.ok(/\.optional\(\)/.test(code.slice(code.indexOf('source:'), code.indexOf('source:') + 80)),
  'source is required, so the default view is one source again'); n++;

// ── The summary ─────────────────────────────────────────────────────────────
const sum = code.slice(code.indexOf('function paymentsSummary('), code.indexOf('function paymentsByHub('));
assert.ok(/AS collected_manual/.test(sum), 'the summary does not split out cash'); n++;
assert.ok(/AS collected_online/.test(sum), 'the summary does not split out online'); n++;
// Collected must NOT be filtered by kind — it is the whole point.
assert.ok(/COALESCE\(SUM\(t\.amount\) FILTER \(\s*WHERE t\.status IN \('captured','refunded','partially_refunded'\)\), 0\) AS collected/.test(sum),
  'Collected is filtered by source — it is supposed to be everything'); n++;
// Failure and abandonment are gateway-only concepts.
for (const m of [/FILTER \(WHERE t\.kind = 'gateway' AND t\.status = 'failed'\)/,
                 /FILTER \(WHERE t\.kind = 'gateway' AND t\.status IN \('created','attempted'\)\)/]) {
  assert.ok(m.test(sum), `a gateway-only count is not scoped to kind='gateway' (${m})`); n++;
}
// The success rate must not count cash as a success — cash cannot fail.
assert.ok(/success_rate: \(s\.gateway_captured \+ s\.failed_count\)/.test(sum),
  'the success rate counts manual payments, which can never fail — it would always read ~100%'); n++;
assert.ok(/AS gateway_captured/.test(sum), 'there is no gateway-only captured count'); n++;

// ── Hub collections ─────────────────────────────────────────────────────────
const byHub = code.slice(code.indexOf('function paymentsByHub('), code.indexOf('function getPayment('));
assert.ok(/GROUP BY t\.hub_id/.test(byHub), 'hub collections are not grouped by hub'); n++;
assert.ok(/collected_manual/.test(byHub) && /collected_online/.test(byHub),
  'hub collections do not split cash from online'); n++;
assert.ok(/\$\{whereSql\}/.test(byHub),
  'hub collections ignore the filters — a total under a date range that does not apply to it'); n++;
assert.ok(/router\.get\('\/by-hub',\s*canView/.test(routes),
  'the by-hub route is missing or not behind VIEW_PAYMENTS'); n++;
assert.ok(routes.indexOf("router.get('/by-hub'") < routes.indexOf("router.get('/:ref'"),
  'GET /by-hub falls below the /:ref catch-all and is read as a transaction reference'); n++;

// ── Both writers set hub_id ─────────────────────────────────────────────────
assert.ok(/created_by, hub_id\)/.test(ciCtrl) || /notes, created_by, hub_id\)/.test(ciCtrl),
  'the manual INSERT does not set hub_id'); n++;
assert.ok(/inv\.hub_id \|\| null/.test(ciCtrl),
  'the manual INSERT does not copy the hub from the invoice'); n++;
assert.ok(/source, hub_id\)/.test(svc), 'the gateway capture does not set hub_id'); n++;
assert.ok(/txn\.hub_id \|\| null/.test(svc),
  'the gateway capture does not take the hub from the transaction that snapshotted it'); n++;

// ── Migration 131 ───────────────────────────────────────────────────────────
assert.ok(/ADD COLUMN IF NOT EXISTS hub_id INTEGER/.test(m131), 'hub_id is not added'); n++;
assert.ok(/REFERENCES hubs\(id\) ON DELETE SET NULL/.test(m131),
  'the hub FK is not ON DELETE SET NULL — losing a hub would destroy payment records'); n++;
assert.ok(!/ON DELETE CASCADE/.test(m131), 'the hub FK cascades'); n++;
assert.ok(/UPDATE customer_invoice_payments cip\s+SET hub_id = ci\.hub_id/.test(m131),
  'existing rows are not backfilled — every historical payment would have no hub'); n++;
assert.ok(/AND cip\.hub_id IS NULL/.test(m131),
  're-running the migration would overwrite a payment\'s historical hub with the invoice\'s current one'); n++;
assert.ok(/CREATE INDEX IF NOT EXISTS idx_cip_hub_paid/.test(m131), 'the hub+date read path is not indexed'); n++;
assert.ok(!/BEGIN;|COMMIT;/.test(m131), 'the migration opens its own transaction'); n++;
assert.ok(!/DROP TABLE|DELETE FROM/.test(m131), 'the migration is destructive'); n++;

// ── Migration 132 keeps the data ────────────────────────────────────────────
assert.ok(/COMMENT ON TABLE invoice_payments/.test(m132), 'the legacy table is not marked'); n++;
assert.ok(!/DROP TABLE/.test(m132),
  'the legacy table is dropped — those rows are the only record of money taken through the old flow'); n++;
assert.ok(!/DELETE FROM/.test(m132), 'the migration deletes rows'); n++;
assert.ok(!/ALTER TABLE invoice_payments RENAME/.test(m132),
  'the table is renamed — anything still referencing it by name breaks instead of reading the note'); n++;

// ── Frontend ────────────────────────────────────────────────────────────────
const page  = strip(fs.readFileSync(`${FE}/pages/PaymentsPage.jsx`, 'utf8'));
const tabs  = strip(fs.readFileSync(`${FE}/components/PaymentsAdminTabs.jsx`, 'utf8'));
const ciPage = strip(fs.readFileSync(`${FE}/pages/CustomerInvoicesPage.jsx`, 'utf8'));

assert.ok(/source: ''/.test(page), 'the source filter has no default'); n++;
assert.ok(/id="pay-f-source"/.test(page), 'there is no source filter control'); n++;
// A manual row has no drawer to open — assert on the NAVIGATE, not on the mere
// presence of `row.kind === 'manual'`, which also appears on the BY HAND badge
// and so stayed true when the click handler lost its branch entirely.
{
  const nav = page.slice(page.indexOf('onClick={() => navigate('), page.indexOf('onClick={() => navigate(') + 260);
  assert.ok(/row\.kind === 'manual'/.test(nav),
    'the row click does not branch on kind — a manual row would open an empty drawer on a null ref'); n++;
  assert.ok(/customerInvoices/.test(nav),
    'a manual row does not navigate to its invoice, which is where its detail lives'); n++;
}
assert.ok(/row\.txn_ref \|\| row\.reference_no/.test(page),
  'the reference column shows nothing for a manual payment'); n++;
assert.ok(/collected_manual/.test(page) && /collected_online/.test(page),
  'the Collected card does not show the split'); n++;
assert.ok(/HubCollectionsPanel/.test(page) && /export function HubCollectionsPanel/.test(tabs),
  'the hub collections view is missing'); n++;
assert.ok(/qs=\{qs\}/.test(page),
  'hub collections do not inherit the list filters — the totals would ignore the date range shown above them'); n++;
assert.ok(/on: !user\?\.hub_id/.test(page),
  'the by-hub tab is offered to hub logins, who would see a one-row comparison of themselves'); n++;

// C: payment links reachable from the invoice they belong to.
assert.ok(/PaymentLinksPanel customerInvoiceId=\{inv\.id\}/.test(ciPage),
  'payment links are still invisible from the invoice that raised them'); n++;
assert.ok(/import \{ PaymentLinksPanel \}/.test(ciPage), 'the links panel is not imported'); n++;

console.log(`unified payments (phase B + C): ${n} checks passed`);
