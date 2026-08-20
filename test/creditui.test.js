/**
 * Credit chasing the invoice.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * An advance taken against an estimate applies ITSELF when the invoice is
 * generated — one estimate has one possible invoice, so there is nothing to
 * decide. Money taken ON ACCOUNT has no such destination, so it waits.
 *
 * Waiting is fine. Waiting UNSEEN is not: the customer paid, gets billed the
 * full amount, and the money they handed over sits in a list nobody opened.
 * That is exactly the problem the whole advance feature was built to prevent,
 * and on-account credit would quietly reintroduce it.
 *
 * So the invoice asks on every read and the screen offers to apply it. What
 * follows pins that it asks, that it only asks where the answer can be acted
 * on, and that the offer is gated and capped.
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
const be = p => strip(fs.readFileSync(path.join(BE, p), 'utf8'));
const fe = p => strip(fs.readFileSync(path.join(FE, p), 'utf8'));

const ciCtl = be('src/controllers/customer_invoices.controller.js');
const payCtl = be('src/controllers/payments.controller.js');
const svc = be('src/services/advances.service.js');
const invPg = fe('pages/CustomerInvoicesPage.jsx');

// ── The invoice asks ────────────────────────────────────────────────────────
assert.ok(/await _attachCustomerCredit\(item\);/.test(ciCtl),
  'the invoice never asks whether the customer has credit, so it waits unseen'); n++;
{
  const body = ciCtl.slice(ciCtl.indexOf('async function _attachCustomerCredit'),
                           ciCtl.indexOf('async function _attachPartyBalance'));
  // Only where the answer can be acted on. Credit against a settled invoice is
  // an offer that does nothing, and against a cancelled one it is an offer to
  // put money somewhere it must not go.
  assert.ok(/if \(Number\(invoice\.balance\) <= 0\.01\) return;/.test(body),
    'credit is offered on an invoice with nothing left to pay'); n++;
  assert.ok(/invoice\.status === 'cancelled'/.test(body),
    'credit is offered on a cancelled invoice'); n++;
  // Refunded money is not credit. This subtraction was missing once and the
  // effect was silent: money the customer already had back, offered again.
  assert.ok(/FROM payment_refunds rf/.test(body) &&
            /rf\.status IN \('pending', 'processed'\)/.test(body),
    'the invoice counts money already given back as available credit'); n++;
  assert.ok(/FROM payment_allocations a/.test(body),
    'the invoice counts money already on another invoice as available credit'); n++;
}

// ── The endpoint ────────────────────────────────────────────────────────────
assert.ok(/function applyCustomerCredit\(req, res, next\) \{[\s\S]{0,200}denyHub\(/.test(payCtl),
  'applying a customer\'s credit does not reject hub sessions — requirePermissionOrHub lets a hub user with no permissions through'); n++;

// ── The banner ──────────────────────────────────────────────────────────────
assert.ok(/const customerCredit = parseFloat\(inv\?\.customer_credit \|\| 0\);/.test(invPg),
  'the invoice screen does not read the credit figure'); n++;
assert.ok(/const canAllocateCredit = useCan\('ALLOCATE_PAYMENT'\);/.test(invPg),
  'the banner does not check the allocate permission'); n++;
assert.ok(/\{customerCredit > 0\.01 && canAllocateCredit && \(/.test(invPg),
  'the banner is shown without the permission, or when there is no credit'); n++;
// What it offers must be what can actually be applied, or the number on the
// button disagrees with what happens when it is pressed.
assert.ok(/Apply \{fmt\(Math\.min\(customerCredit, parseFloat\(inv\.balance \|\| 0\)\)\)\} to this invoice/.test(invPg),
  'the button offers more than the invoice owes'); n++;
assert.ok(/api\('\/api\/payments\/apply-credit'/.test(invPg),
  'the banner does not call the apply-credit endpoint'); n++;
// One request, not one per receipt — see applyCustomerCredit.
assert.ok(!/\/allocate`/.test(invPg),
  'the invoice screen loops allocate calls with no transaction around them'); n++;

// ── The service ─────────────────────────────────────────────────────────────
{
  const body = svc.slice(svc.indexOf('async function applyCustomerCredit'));
  assert.ok(/FROM customer_invoices WHERE id = \$1 FOR UPDATE/.test(body),
    'the invoice is not locked, so two advisors can both fill the same balance'); n++;
  assert.ok(/status === 'cancelled'/.test(body),
    'credit can be applied to a cancelled invoice'); n++;
  assert.ok(/ORDER BY p\.paid_at ASC, p\.id ASC/.test(body),
    'credit is not consumed oldest-first'); n++;
  assert.ok(/const owed = Number\(bal\.balance\);/.test(body),
    'what the invoice owes is read from the wrong key, and the cap becomes NaN'); n++;
  // One transaction around the whole thing.
  assert.ok(/await client\.query\('BEGIN'\)/.test(body) && /await client\.query\('COMMIT'\)/.test(body),
    'applying credit is not atomic — a failure halfway leaves the invoice part-paid'); n++;
}

// ── Taking money with no job, inside the one Payment dialog ────────────────
//
// This block used to describe TakePaymentModal, which no longer exists. Take
// Payment and Record Payment were two buttons for one act; they are now three
// destinations inside one dialog, and "no job at all" is the third of them.
// What has NOT changed is why the confirmation step exists, which is the part
// worth carrying forward.
{
  const tab  = fe('components/CustomerPaymentsTab.jsx');
  const page = fe('pages/CustomersPage.jsx');

  // Never offered on a path that would only refuse. The rate is unset until
  // somebody has answered the tax question, and the service says no.
  assert.ok(/api\('\/api\/payments\/account-credit\/rate'\)/.test(tab),
    'the screen does not ask whether taking money with no job is switched on'); n++;

  // ONE button, on the page, shown to anyone who can do any of the three
  // things the dialog offers. The dialog then disables the branches they
  // cannot use, with the reason — rather than the button meaning something
  // different per person.
  assert.ok(/\(canCollect \|\| canRecordPay \|\| canAllocate\) && \(/.test(page),
    'the Payment button is gated on the wrong set of permissions'); n++;
  assert.ok(!/Take Payment|Record Payment/.test(page),
    'the two old buttons are still on the customer page'); n++;
  assert.ok(/const canCollect = useCan\('COLLECT_PAYMENT'\);/.test(tab),
    'taking money does not check the collect permission'); n++;
  assert.ok(/api\('\/api\/payments\/receive'/.test(tab),
    'the dialog does not call the receive endpoint'); n++;

  const body = tab.slice(tab.indexOf('function PaymentModal'));

  // THE guard, and now it is applied precisely.
  //
  // Money going onto an invoice is checked by the invoice — you cannot overpay
  // one, so a stray zero is refused by arithmetic. Money becoming credit or a
  // job deposit has no ceiling at all, and nothing else will ever question it.
  // So the confirmation is asked for exactly those two and not for the third,
  // which is stricter than the old dialog: it used to be unconditional, which
  // meant it was also ceremony half the time and got clicked through.
  assert.ok(/phase === 'confirm'/.test(body),
    'there is no confirmation step on an amount nothing can check'); n++;
  assert.ok(/const needsConfirm = dest === 'credit' \|\| dest === 'job';/.test(body),
    'the confirmation is not scoped to the paths with no ceiling'); n++;
  assert.ok(/needsConfirm \? setPhase\('confirm'\) : submit\(\)/.test(body),
    'the form submits straight to the write, with no confirmation'); n++;
  assert.ok(/no invoice to check this against/.test(body),
    'the confirmation does not say why it is being asked'); n++;
  assert.ok(/Confirm \{fmt\(asked\)\}/.test(body),
    'the confirmation button does not name the amount being confirmed'); n++;

  // GST is inside, and the rate is shown rather than chosen — it is a tax
  // decision, not a data-entry field.
  assert.ok(/GST at \{rate\}% is already included/.test(body),
    'the dialog does not answer "is GST extra?", which is asked at the counter'); n++;
  assert.ok(!/\+ GST|plus GST|GST extra/i.test(body),
    'the dialog implies GST is added on top'); n++;
  assert.ok(/\(asked \* rate\) \/ \(100 \+ rate\)/.test(body),
    'the tax shown is not the part inside the amount'); n++;
  assert.ok(!/setRate|<select[\s\S]{0,120}rate/i.test(body),
    'the rate can be changed on the form — a tax decision made at the counter'); n++;

  // The receipt exists the moment the money is recorded.
  assert.ok(/openAdvanceVoucher\(result\.payment_id\)/.test(body),
    'the dialog cannot open the receipt it just created'); n++;
  assert.ok(/Kept as this customer's credit/.test(body),
    'nothing says where the money has gone'); n++;
}

console.log(`credit chasing the invoice: ${n} checks passed`);
