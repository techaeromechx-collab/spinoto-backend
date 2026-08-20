/**
 * The buttons that reach the vouchers and the refund.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Phase 4 built a refund endpoint, a receipt voucher, a refund voucher and a
 * public customer link. Every one of them worked and every one of them was
 * UNREACHABLE — no screen called any of it. A cash advance could be taken and
 * then neither printed nor returned from anywhere in the CRM.
 *
 * That is not a bug a test can catch by asserting on the backend, because the
 * backend was right. What follows pins the other half: that each of those
 * endpoints has something in the interface that calls it, and that the two
 * dangerous ones are gated and worded correctly.
 *
 *   • Refunding is not the same authority as collecting. It carries its own
 *     permission, and the button has to check it — the route refusing later is
 *     a worse experience than the button not being there.
 *   • Only UNUSED credit can be returned. Money already on an invoice has paid
 *     for something.
 *   • An online refund has NOT happened yet when the dialog closes. Telling a
 *     customer "here is your refund voucher" for money still in transit is the
 *     one sentence this screen must not say.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(__dirname, '../../frontend/src');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
                    .replace(/^\s*\/\/.*$/gm, '');
const fe = p => strip(fs.readFileSync(path.join(FE, p), 'utf8'));
const be = p => strip(fs.readFileSync(path.join(BE, p), 'utf8'));

const pdfLib = fe('lib/documentPdf.js');
const tab    = fe('components/CustomerPaymentsTab.jsx');
const modal  = fe('components/AdvancePaymentModal.jsx');
const invPg  = fe('pages/CustomerInvoicesPage.jsx');
const payCtl = be('src/controllers/payments.controller.js');

// ── The openers ─────────────────────────────────────────────────────────────
// Shared with the invoice PDF path rather than re-implemented, so the Bearer
// header, the %PDF- sniff and the pop-up check are not written twice.
assert.ok(/export function openAdvanceVoucher/.test(pdfLib),
  'there is no way to open an advance receipt voucher'); n++;
assert.ok(/export function openRefundVoucher/.test(pdfLib),
  'there is no way to open a refund voucher'); n++;
assert.ok(/\/api\/payments\/advance\/\$\{paymentId\}\/voucher/.test(pdfLib),
  'the receipt opener points at the wrong endpoint'); n++;
assert.ok(/\/api\/payments\/refund\/\$\{refundId\}\/voucher/.test(pdfLib),
  'the refund voucher opener points at the wrong endpoint'); n++;
// The auth header is the reason this cannot be a plain window.open().
assert.ok(/Authorization: `Bearer \$\{getToken\(\)\}`/.test(pdfLib),
  'the voucher fetch sends no token, so it would 401'); n++;
assert.ok(/openPdfPath/.test(pdfLib) &&
          (pdfLib.match(/const res = await fetch\(/g) || []).length === 1,
  'the voucher path re-implements the fetch instead of sharing it'); n++;

// ── The receipt is reachable from all three places it is wanted ─────────────
// Anchored on the CALL, not the name. `void 0 && openAdvanceVoucher(p.id)`
// still contains the identifier and does nothing.
// The row's handler grew a .catch and a menu close, so it is a block body now.
// Still anchored on the CALL rather than the name: `void 0 &&
// openAdvanceVoucher(p.id)` would contain the identifier and do nothing.
assert.ok(/openAdvanceVoucher\(p\.id\)\.catch/.test(tab),
  "the customer's Payments tab cannot open a receipt"); n++;
assert.ok(/onClick=\{\(\) => openAdvanceVoucher\(result\.payment_id\)/.test(modal),
  'the advance dialog cannot open the receipt it just created'); n++;
assert.ok(/onClick=\{\(\) => openAdvanceVoucher\(pay\.id\)/.test(invPg),
  'the invoice screen cannot open the receipt for an advance applied to it'); n++;
// Only a captured advance HAS a voucher — an unpaid link has none, and the
// button must not offer a document that does not exist.
// The guard was lifted into a named flag when a second button (the share
// link) came to depend on the same condition — one test, two uses.
assert.ok(/const hasVoucher = /.test(tab) && /\{hasVoucher && \(/.test(tab),
  'the receipt button is offered on payments that have no voucher'); n++;
assert.ok(/result\.payment_id &&/.test(modal),
  'the advance dialog offers a receipt before the payment id is known'); n++;

// The customer's own link, so an advisor can send it again without hunting
// through WhatsApp history.
assert.ok(/\/advance\/\$\{p\.public_token\}/.test(tab),
  'there is no way to re-send the customer their own receipt link'); n++;
assert.ok(/p\.public_token,/.test(payCtl),
  'the API does not return the public token, so the link cannot be built'); n++;

// ── The refund button ───────────────────────────────────────────────────────
assert.ok(/const canRefund = useCan\('REFUND_PAYMENT'\);/.test(tab),
  'the refund button does not check the refund permission'); n++;
// Same three conditions, lifted into a named flag. Asserted on the flag's
// DEFINITION so it still fails if one of the three is ever dropped.
assert.ok(/const canDoRefund = canRefund && isAdvance && unused > 0\.001;/.test(tab),
  'the refund button is offered without the permission, on invoice payments, or on money already spent'); n++;
assert.ok(/api\(`\/api\/payments\/advance\/\$\{payment\.id\}\/refund`/.test(tab),
  'the dialog does not call the advance refund endpoint'); n++;
// The gateway refund path exists and takes a txn_ref; an advance has none.
assert.ok(!/\/refund`, \{[\s\S]{0,80}txn_ref/.test(tab),
  'the dialog calls the gateway refund route, which cannot address a cash advance'); n++;

// ── What the dialog will not let you do ─────────────────────────────────────
{
  const body = tab.slice(tab.indexOf('function RefundModal'));
  assert.ok(/const max = Number\(payment\.unused \|\| 0\);/.test(body),
    'the ceiling is not the unused part — money already on an invoice could be returned'); n++;
  assert.ok(/const over = !invalid && asked > max \+ 0\.001;/.test(body),
    'an amount above the unused credit can be submitted'); n++;
  assert.ok(/const shortReason = reason\.trim\(\)\.length < 3;/.test(body),
    'a refund can be recorded with no stated reason'); n++;
  assert.ok(/disabled=\{busy \|\| invalid \|\| over \|\| shortReason\}/.test(body),
    'the submit button is enabled for an invalid, over-ceiling or unexplained refund'); n++;

  // ── The sentence this screen must not say ────────────────────────────────
  // An online refund is NOT done when the dialog closes.
  // The ternary itself, not the identifier: `{false ? … : …}` still mentions
  // done.pending elsewhere in the file and would take the "already returned"
  // branch every time.
  assert.ok(/\{done\.pending\s*\n?\s*\?/.test(body),
    'the result does not distinguish money already returned from money still in transit'); n++;
  assert.ok(/5–7 working days/.test(body),
    'an online refund is reported as complete the moment it is requested'); n++;
  assert.ok(/\{!done\.pending && done\.refund\.id && \(/.test(body),
    'a refund voucher is offered before the money has gone back — it has no number yet'); n++;
  // And before submitting, the two cases are explained rather than discovered.
  assert.ok(/const isOnline = payment\.source === 'gateway';/.test(body) &&
            /hand the money back now/.test(body),
    'the dialog does not say whether the cash is handed back now or sent by the bank'); n++;
  assert.ok(/already paid an invoice, so it is no longer credit/.test(body),
    'a part-spent advance does not explain why only some of it can be returned'); n++;
}

// ── The invoice screen still refuses to edit or delete an advance ───────────
// Opening a document is a read. It must not have re-opened the two actions the
// backend cannot honour.
{
  assert.ok(/isAdvance\(pay\) \? \(/.test(invPg),
    'the invoice screen no longer treats an applied advance as a special case'); n++;
  assert.ok(/canEditPayDate && !isOnline\(pay\) && !isAdvance\(pay\)/.test(invPg),
    'the date pencil came back on an advance, where it can only 404'); n++;
  const del = invPg.slice(invPg.indexOf('canDeletePay &&'));
  assert.ok(!/isAdvance\(pay\)[\s\S]{0,400}deletePayment\(pay\.id\)/.test(del.slice(0, 1200)),
    'the delete button came back on an advance'); n++;
}

console.log(`voucher & refund UI: ${n} checks passed`);
