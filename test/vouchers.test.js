/**
 * Phase 4 — the voucher wiring.
 *
 * vouchers.pg.test.js proves the numbers. This proves the plumbing around them,
 * which is where a tax document goes wrong in ways arithmetic cannot catch:
 *
 *   • the receipt rendered through an INVOICE theme — it would print an empty
 *     item table and a "Balance Due" row for a job with no invoice;
 *   • the number rebuilt from the row id instead of the issued series, which
 *     produces a consecutive-looking series full of numbers nobody was given;
 *   • the customer's copy and the advisor's copy built from different queries,
 *     free to disagree on a document both parties are holding;
 *   • the public link served without the checks the invoice link already has.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const be = p => strip(fs.readFileSync(path.join(BE, p), 'utf8'));
const fe = p => strip(fs.readFileSync(path.join(FE, p), 'utf8'));

const cfgSrc    = be('src/utils/documentConfig.js');
const adapter   = be('src/templates/documentAdapter.js');
// Stripped: the header comment explains what this document must NOT say, and
// names the phrases it must not use.
const renderer  = be('src/templates/invoiceThemes/advanceReceipt.js');
const rendDoc   = be('src/utils/renderDocument.js');
const advSvc    = be('src/services/advances.service.js');
const refSvc    = be('src/services/refunds.service.js');
const payCtrl   = be('src/controllers/payments.controller.js');
const payRoutes = be('src/routes/payments.routes.js');
const pubCtrl   = be('src/controllers/public.documents.controller.js');
const pubRoutes = be('src/routes/public.documents.routes.js');
const qrSrc     = be('src/utils/qr.js');
const app       = fe('App.jsx');

// ── The document type ───────────────────────────────────────────────────────
assert.ok(/'purchase_invoice', 'advance_receipt'\]/.test(cfgSrc),
  'advance_receipt is not a document type, so its config falls back to the invoice\'s'); n++;
assert.ok(/advance_receipt:\s*'RECEIPT VOUCHER'/.test(cfgSrc),
  'the receipt voucher is not titled as one'); n++;
assert.ok(/ADVANCE_REFUND_TITLE = 'REFUND VOUCHER'/.test(cfgSrc),
  'the refund voucher has no title of its own'); n++;
assert.ok(/advance_receipt:\s*docSchema/.test(cfgSrc),
  'a saved advance_receipt config would fail validation'); n++;
// The receipt promises the money will be adjusted against the invoice. On a
// refund that is false, and there is no separate setting to inherit from.
assert.ok(/ADVANCE_REFUND_FOOTER/.test(cfgSrc) && /ADVANCE_REFUND_FOOTER/.test(adapter),
  'the refund voucher prints the receipt\'s footer, which says the money will be adjusted against the invoice'); n++;

// ── The adapter ─────────────────────────────────────────────────────────────
assert.ok(/advance_receipt: fromAdvanceReceipt/.test(adapter),
  'buildDocument cannot build a receipt voucher'); n++;
// The number is ISSUED, not composed. Rebuilding it from the id would produce
// numbers that look consecutive and were never given to anyone.
{
  const body = adapter.slice(adapter.indexOf('function fromAdvanceReceipt'),
                             adapter.indexOf('const ADAPTERS'));
  assert.ok(/number: row\.voucher_no/.test(body),
    'the voucher number is not the number that was issued'); n++;
  assert.ok(!/formatNumber\(/.test(body),
    'the voucher number is composed from the row id — a tax series cannot be derived that way'); n++;
  // No item table. That absence is the document.
  assert.ok(/items: \[\]/.test(body),
    'the receipt voucher has an item table, so it will read as a bill'); n++;
  // { interState, lines } — a bare array parses fine and renders nothing.
  assert.ok(/gstBreakup: \{ interState, lines:/.test(body),
    'the GST breakup is not the shape docShared.buildGstLines reads, so CGST/SGST would silently not print'); n++;
  // The tax is the snapshot, never recomputed from an estimate that may have
  // been edited since the customer was handed their copy.
  assert.ok(/const gst = num\(row\.gst_amount\)/.test(body) && !/total_gst/.test(body),
    'the voucher recomputes its tax instead of printing the snapshot'); n++;
  assert.ok(/const taxable = Number\(\(amount - gst\)\.toFixed\(2\)\)/.test(body),
    'taxable is not derived as amount − GST, so the three figures need not add up'); n++;
}

// ── One renderer, and no way to pick another ────────────────────────────────
assert.ok(/docType === 'advance_receipt'/.test(rendDoc) && /theme: advanceReceipt/.test(rendDoc),
  'a receipt voucher can be rendered through an invoice theme'); n++;
assert.ok(rendDoc.indexOf("docType === 'advance_receipt'") < rendDoc.indexOf('themeOverride || shareTheme'),
  'the theme override is applied before the receipt renderer is forced'); n++;
assert.ok(!/advance_receipt/.test(be('src/templates/invoiceThemes/registry.js')),
  'the receipt renderer is selectable as a theme'); n++;

// The document must not read as a bill.
assert.ok(/RECEIVED FROM/.test(renderer) && /Advance received/.test(renderer),
  'the amount is not labelled as an advance received'); n++;
assert.ok(/This is not an invoice/.test(renderer),
  'nothing on the voucher tells the customer it is not the bill'); n++;
assert.ok(!/Amount due|Balance Due/i.test(renderer),
  'the voucher speaks of an amount due for a job that has not been invoiced'); n++;

// ── One query behind both copies ────────────────────────────────────────────
assert.ok(/readReceiptVoucher/.test(payCtrl) && /readReceiptVoucher/.test(pubCtrl),
  'the staff copy and the customer copy of a numbered tax document are built by different queries'); n++;
assert.strictEqual((advSvc.match(/if \(!row\.voucher_no\) return null;/g) || []).length, 2,
  'a document with no number can be rendered — an unpaid link as a receipt, or an unprocessed refund as a credit note'); n++;

// ── Numbering rules ─────────────────────────────────────────────────────────
assert.ok(/doc_kind = \$3/.test(advSvc) && /docKind = 'receipt'/.test(advSvc),
  'receipts and refunds share one counter, so a refund makes the receipt series skip'); n++;
assert.ok(/prefix: 'ADVR'/.test(advSvc), 'the refund voucher has no series of its own'); n++;
// Idempotent: refund.processed can be delivered more than once.
assert.ok(/WHERE id = \$1 AND voucher_no IS NULL/.test(advSvc),
  'a webhook delivered twice would issue two numbers for one refund'); n++;
assert.ok(/if \(rf\.voucher_no\) return rf\.voucher_no;/.test(advSvc),
  'issueRefundVoucher is not idempotent'); n++;
// Numbered on processed, never on request. Cash is processed the moment it is
// recorded; online money is not ours to declare returned, so that path never
// calls the issuer at all — the webhook (or an instant settlement) does.
{
  const body = advSvc.slice(advSvc.indexOf('async function refundAdvance'));
  const gateway = body.slice(body.indexOf('if (!isCash) {'), body.indexOf('const ins = await client.query'));
  assert.ok(/await requestRefund\(\{/.test(gateway),
    'an online advance refund is recorded but never sent to the gateway'); n++;
  assert.ok(!/issueRefundVoucher/.test(gateway),
    'the online path numbers the refund itself, before the money has moved'); n++;
  assert.ok(/ledgerPaymentId: pay\.id,/.test(gateway),
    'the refund is not linked to the advance, so no voucher would ever be issued for it'); n++;
  // A network round-trip must not be made holding a row lock.
  assert.ok(gateway.indexOf("await client.query('COMMIT')") < gateway.indexOf('await requestRefund'),
    'the gateway is called while the advance row is still locked'); n++;
  const cash = body.slice(body.indexOf('const ins = await client.query'));
  assert.ok(/const voucherNo = await issueRefundVoucher\(client, refund\.id\);/.test(cash),
    'a cash refund is not numbered even though the money is already back'); n++;
}
assert.ok(/await issueRefundVoucher\(client, refund\.id\);/.test(refSvc) &&
          refSvc.indexOf("outcome === 'processed'") < refSvc.indexOf('await issueRefundVoucher'),
  'the refund voucher is not issued when the gateway confirms the money went back'); n++;

// ── What can be refunded ────────────────────────────────────────────────────
// Destructured, never used as a number. `const free = await unallocatedOf(...)`
// yields an object; every comparison against it is NaN-false and every ceiling
// silently passes.
assert.ok(/const \{ remaining: refundable \} = await unallocatedOf/.test(advSvc),
  'the refundable amount is read off the row object rather than its number — every ceiling becomes NaN and passes'); n++;
// And it is used DIRECTLY: REMAINING_SQL already subtracts refunds, so
// subtracting them again here would refuse a legitimate second part-refund.
assert.ok(/rf\.status IN \('pending', 'processed'\)/.test(advSvc) &&
          /const REMAINING_SQL = /.test(advSvc),
  'what is left of a payment does not account for money already given back'); n++;
assert.ok(/status IN \('pending', 'processed'\)/.test(advSvc),
  'a refund already in flight is not counted, so the same money can be returned twice'); n++;
assert.ok(/payment_type !== 'advance'/.test(advSvc),
  'an invoice payment can be refunded through the advance path, leaving the invoice balance untouched'); n++;

// ── Routes and authorisation ────────────────────────────────────────────────
assert.ok(/router\.get\('\/advance\/:id\/voucher',\s*canView/.test(payRoutes),
  'the receipt PDF is not behind VIEW_PAYMENTS'); n++;
assert.ok(/router\.get\('\/refund\/:id\/voucher',\s*canView/.test(payRoutes),
  'the refund PDF is not behind VIEW_PAYMENTS'); n++;
assert.ok(/router\.post\('\/advance\/:id\/refund', requirePermission\('REFUND_PAYMENT'\)/.test(payRoutes),
  'returning an advance does not require the refund permission'); n++;
for (const h of ['advanceVoucherPdf', 'refundVoucherPdf', 'refundAdvancePayment']) {
  assert.ok(new RegExp(`function ${h}\\(req, res, next\\) \\{[\\s\\S]{0,200}denyHub\\(`).test(payCtrl),
    `${h} does not reject hub sessions — requirePermissionOrHub lets a hub user with no permissions through`); n++;
}

// ── The public link ─────────────────────────────────────────────────────────
assert.ok(/router\.get\('\/advance\/:token', documentLimit/.test(pubRoutes),
  'the public voucher link is not rate limited'); n++;
{
  const body = pubCtrl.slice(pubCtrl.indexOf('async function getPublicAdvanceVoucher'));
  assert.ok(/token\.length > 20/.test(body),
    'an over-long token reaches the database'); n++;
  assert.ok(/res\.set\('Cache-Control', 'private, no-store'\)/.test(body),
    'a proxy may cache one customer\'s voucher and serve it to the next'); n++;
  assert.ok(/baseUrl: null/.test(body),
    'a public request\'s own headers can set the URL baked into the QR on the customer\'s voucher'); n++;
  assert.ok(/error: 'Document not found'/.test(body) && !/does not exist|never paid|not captured/i.test(body),
    'the 404 distinguishes an unknown token from an unpaid one, which makes it an oracle'); n++;
  // One route serves both documents. Dropping the fallback 404s every refund
  // voucher link ever sent, which looks exactly like an expired link.
  assert.ok(/readReceiptVoucher\(pool, \{ publicToken: token \}\)\s*\n?\s*\|\| await svc\.readRefundVoucher\(pool, \{ publicToken: token \}\)/.test(body),
    'the public link resolves receipts but not refund vouchers'); n++;
}

// ── The customer's route ────────────────────────────────────────────────────
assert.ok(/advance_receipt: 'advance'/.test(qrSrc),
  'the QR printed on a voucher encodes nothing'); n++;
assert.ok(/path="\/advance\/:token"/.test(app),
  'the public voucher link has no page to land on'); n++;
assert.ok(/endpoint="advance" noun="receipt"/.test(app),
  'the voucher route opens the invoice endpoint'); n++;

// ── WhatsApp ────────────────────────────────────────────────────────────────
const wa = be('src/services/whatsapp.dispatcher.js');
assert.ok(/kind === 'advance'/.test(wa) && /ADVANCE_CONTEXT/.test(wa),
  'the receipt cannot be sent to the customer'); n++;
assert.ok(/WHERE p\.id = \$1 AND p\.payment_type = 'advance'/.test(wa),
  'the advance message is keyed on something other than the payment, so a second advance on one job would dedupe away'); n++;
assert.ok(/dedupeKey: `advance:\$\{ledgerPaymentId\}`/.test(advSvc),
  'a retried capture would send the customer a second copy of the same receipt'); n++;
// Sending must never be able to unwind money that was taken — and must not hold
// the transaction's connection while it runs, or every advance occupies two and
// ten at once exhaust the pool.
// Three capture paths now: cash against a job, a gateway capture, and money on
// the customer's account. Every one of them owes the customer a receipt.
assert.strictEqual((advSvc.match(/await sendReceiptMessage\(/g) || []).length, 3,
  'one of the capture paths does not send the customer their receipt'); n++;
for (const fn of ['createManualAdvance', 'captureAdvance', 'createAccountCredit']) {
  const body = advSvc.slice(advSvc.indexOf(`async function ${fn}(`));
  const send = body.indexOf('await sendReceiptMessage');
  const release = body.indexOf('client.release()');
  assert.ok(send > 0 && release > 0 && release < send,
    `${fn} sends the receipt while still holding the transaction's connection`); n++;
}

// ── The document that actually gets built ───────────────────────────────────
//
// Source assertions cannot tell whether the pieces fit. buildDocument is a pure
// function, so the cheapest honest check is to run it and read the result.
{
  const { buildDocument } = require(path.join(BE, 'src/templates/documentAdapter'));
  const { resolveDocumentConfig, ADVANCE_REFUND_FOOTER } = require(path.join(BE, 'src/utils/documentConfig'));
  const renderFn = require(path.join(BE, 'src/templates/invoiceThemes/advanceReceipt')).render;

  const company = { company_name: 'Spinoto', gstin: '24AABCS1429B1ZP', state: 'Gujarat' };
  const cfg = resolveDocumentConfig({}, 'advance_receipt', 'admin');

  const base = {
    amount: '2000.00', gst_amount: '305.08', gst_rate: '18.00', method: 'upi',
    paid_at: '2026-08-14', voucher_no: 'ADV-2026-27-000042', estimate_id: 88,
    mobile: '9876543210', vehicle_number: 'GJ01AS1222', customer_name: 'Raj Patel',
    job_total: '5000.00', job_advanced: '2000.00',
  };

  const rec = buildDocument('advance_receipt', { ...base, kind: 'receipt' }, company, cfg);
  const grand = rec.totals.find(t => t.key === 'grand').value;
  const taxable = rec.totals.find(t => t.key === 'taxable').value;
  const gst = rec.totals.find(t => t.key === 'gst').value;

  // The arithmetic a customer can do on the printed page.
  assert.ok(Math.abs((taxable + gst) - grand) < 0.005,
    `taxable + GST does not equal the amount received (${taxable} + ${gst} != ${grand})`); n++;
  assert.strictEqual(rec.number, 'ADV-2026-27-000042',
    'the printed number is not the number that was issued'); n++;
  assert.strictEqual(rec.items.length, 0, 'the receipt voucher printed an item table'); n++;
  assert.strictEqual(rec.gstBreakup.lines.length, 2,
    'the intra-state receipt did not split into CGST and SGST'); n++;
  assert.ok(Math.abs(rec.gstBreakup.lines.reduce((s2, l) => s2 + l.amount, 0) - gst) < 0.005,
    'the CGST/SGST split does not add up to the GST line above it'); n++;
  assert.strictEqual(rec.job.balanceAfter, 3000,
    'the receipt does not tell the customer what is left to pay'); n++;

  const ref = buildDocument('advance_receipt',
    { ...base, kind: 'refund', voucher_no: 'ADVR-2026-27-000003', against_voucher_no: 'ADV-2026-27-000042' },
    company, cfg);
  assert.strictEqual(ref.title, 'REFUND VOUCHER', 'the refund is titled as a receipt'); n++;
  assert.strictEqual(ref.blocks.footerNote, ADVANCE_REFUND_FOOTER,
    'the refund promises the money will be adjusted against the invoice — it has gone back'); n++;
  assert.strictEqual(ref.job.balanceAfter, null,
    'the refund states a job balance, implying the refund changed what the job costs'); n++;
  assert.ok(ref.meta.some(m => m.key === 'against' && m.value === 'ADV-2026-27-000042'),
    'the refund does not name the receipt it reverses'); n++;

  // ── The same document with no job at all ─────────────────────────────────
  // Money on the customer's account. What it must NOT do is look like a
  // job-shaped receipt whose job failed to print.
  const acct = buildDocument('advance_receipt',
    { ...base, amount: '1180.00', gst_amount: '180.00', gst_rate: '18.00',
      estimate_id: null, job_total: null, job_advanced: null,
      voucher_no: 'ADV-2026-27-000051', kind: 'receipt' },
    company, cfg);
  assert.strictEqual(acct.onAccount, true,
    'an advance with no job is not marked as on-account'); n++;
  assert.strictEqual(acct.job.total, null,
    'the job block would print for money that belongs to no job'); n++;
  assert.ok(!acct.meta.some(m => m.key === 'against'),
    'the voucher names a job it does not have'); n++;
  assert.strictEqual(acct.blocks.footerNote, '',
    'the footer repeats the on-account promise the body already makes'); n++;
  {
    const html = renderFn({ doc: acct, cfg, pageSize: 'A4' });
    assert.ok(/ADVANCE RECEIVED ON ACCOUNT|Advance received on account/i.test(html),
      'the page does not say the money is held on account'); n++;
    assert.ok(/held to your account/.test(html),
      'nothing on the page explains what happens to the money next'); n++;
    assert.ok(!/Still to pay|Against This Job/i.test(html),
      'the page states a job balance for money that belongs to no job'); n++;
    // The tax still has to add up, and the name still has to be there.
    assert.ok(/1,000\.00/.test(html) && /180\.00/.test(html) && /1,180\.00/.test(html),
      'the tax breakdown does not add up on an on-account receipt'); n++;
    assert.ok(/Raj Patel/.test(html),
      'the on-account receipt names nobody'); n++;
  }

  // And the page itself.
  const html = renderFn({ doc: rec, cfg, pageSize: 'A4' });
  assert.ok(/ADV-2026-27-000042/.test(html), 'the number does not reach the page'); n++;
  assert.ok(/CGST \(9%\)/.test(html) && /SGST \(9%\)/.test(html),
    'the tax split does not reach the page'); n++;
  assert.ok(!/<table/.test(html), 'the voucher renders a table — it will read as an itemised bill'); n++;
  const refHtml = renderFn({ doc: ref, cfg, pageSize: 'A4' });
  assert.ok(!/Still to pay/.test(refHtml),
    'the refund voucher tells the customer what is still to pay'); n++;
}

console.log(`vouchers (wiring): ${n} checks passed`);
