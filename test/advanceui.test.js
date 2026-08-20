/**
 * Phase 3 — the advance payment UI.
 *
 * Source assertions, because what can go wrong here is placement and gating,
 * not arithmetic — the arithmetic is Phase 2's and is tested against a real
 * database. What this pins is the set of mistakes that produce a screen which
 * looks right and does the wrong thing:
 *
 *   • offering an advance on a job that already has an invoice, where the
 *     correct action is Record Payment and taking an advance instead creates
 *     money nothing will apply;
 *   • showing "Amount due" and an invoice number on a page taking an advance,
 *     for a job that has not been invoiced;
 *   • a Record Payment dialog that takes fresh cash from a customer who has
 *     already paid and whose credit is sitting unused;
 *   • a permission check the button forgets.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FE = path.resolve(__dirname, '../../frontend/src');
const BE = path.resolve(__dirname, '..');
let n = 0;

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = p => fs.readFileSync(path.join(FE, p), 'utf8');

const modal   = read('components/AdvancePaymentModal.jsx');
const modalC  = strip(modal);
const tab     = read('components/CustomerPaymentsTab.jsx');
const tabC    = strip(tab);
const est     = strip(read('pages/EstimatesPage.jsx'));
const cust    = strip(read('pages/CustomersPage.jsx'));
const payPage = strip(read('pages/PublicPayPage.jsx'));
const admin   = strip(read('components/PaymentsAdminTabs.jsx'));
const pays    = strip(read('pages/PaymentsPage.jsx'));

// ── The button on the estimate ──────────────────────────────────────────────
assert.ok(/AdvancePaymentModal/.test(est), 'the estimate screen cannot open the advance dialog'); n++;
assert.ok(/import AdvancePaymentModal/.test(est), 'the modal is not imported'); n++;

// Hidden once an invoice exists. After that the correct action is Record
// Payment on the invoice; an advance taken then is money with nothing to apply
// it to automatically.
assert.ok(/!estimate\.customer_invoice_id && Number\(estimate\.grand_total\) > 0 && canAdvance/.test(est),
  'the advance button is not gated on "no invoice yet, and a total exists, and permitted"'); n++;
assert.ok(/const canAdvance = useCan\('COLLECT_PAYMENT'\) && !authUser\?\.hub_id;/.test(est),
  'the advance button does not check COLLECT_PAYMENT, or does not exclude hub logins'); n++;

// The ceiling shown must come from the same figure the server validates
// against, or staff are offered an amount that is then refused.
assert.ok(/advanced_total/.test(est), 'the estimate screen does not know what has already been advanced'); n++;
const estCtrl = strip(fs.readFileSync(path.join(BE, 'src/controllers/estimates.controller.js'), 'utf8'));
assert.ok(/\) AS advanced_total,/.test(estCtrl), 'the estimate API does not return advanced_total'); n++;
assert.ok(/p\.payment_type = 'advance'/.test(estCtrl),
  'advanced_total counts every payment, not just advances'); n++;

// ── The modal ───────────────────────────────────────────────────────────────
assert.ok(/api\('\/api\/payments\/advance'/.test(modalC), 'the modal does not call the advance endpoint'); n++;
assert.ok(/method: mode === 'link' \? 'link' : method/.test(modalC),
  'the modal does not send which instrument was chosen'); n++;

// GST is inside the amount. The advisor is asked this at the counter and needs
// the answer on screen.
assert.ok(/GST is already included/.test(modalC),
  'the modal does not say the amount includes GST — "is GST extra?" is the first question asked'); n++;
assert.ok(!/\+ GST|plus GST|GST extra/i.test(modalC), 'the modal implies GST is added on top'); n++;

// The ceiling is enforced before the request leaves.
assert.ok(/const over = !invalid && asked > collectable/.test(modalC),
  'the modal does not stop an amount above what is left on the job'); n++;
assert.ok(/disabled=\{busy \|\| invalid \|\| over\}/.test(modalC),
  'the submit button is enabled for an invalid or over-ceiling amount'); n++;

// A link produces no receipt number, and the copy explains why — otherwise the
// advisor looks for one, does not find it, and assumes something failed.
assert.ok(/Nothing is recorded until the customer actually pays/.test(modalC) &&
          /receipt number is issued/.test(modalC),
  'the link result does not make clear that no receipt number exists yet'); n++;
assert.ok(/leaves no gap in your receipt series/.test(modalC),
  'the modal does not explain why an unused link is harmless'); n++;
// …and cash does show one immediately.
assert.ok(/Receipt <strong>\{result\.voucher_no\}/.test(modalC),
  'a cash advance does not show its receipt number'); n++;

// ── The customer Payments tab ───────────────────────────────────────────────
assert.ok(/CustomerPaymentsTab/.test(cust), 'the customer page has no Payments tab'); n++;
assert.ok((cust.match(/tab === 'payments'/g) || []).length >= 2,
  'the Payments tab is not both selectable and rendered'); n++;
assert.ok(/api\(`\/api\/payments\/for-customer\//.test(tabC), 'the tab does not load the customer history'); n++;
// The credit figure is fetched by the PAGE, not the tab. It moved there when
// the chip moved into the profile header: two fetches is how a chip and the
// card above it start showing different numbers.
assert.ok(/api\(`\/api\/payments\/credit\//.test(cust),
  'the customer page does not load the credit figure'); n++;
assert.ok(!/api\(`\/api\/payments\/credit\//.test(tabC),
  'the tab fetches credit as well as the page — two sources, one number'); n++;

// An advance with no invoice must still appear — that is the whole point.
{
  const rowsBody = tabC.slice(tabC.indexOf('const rows'), tabC.indexOf('const totalPaid'));
  assert.ok(!/!p\.customer_invoice_id|customer_invoice_id[^\n]*return false|filter\(p => p\.customer_invoice_id/.test(rowsBody),
    'the tab filters out payments with no invoice — advances would be invisible'); n++;
}
// Credit is surfaced, and the per-payment figure comes from ONE definition.
// This used to assert the arithmetic inline, twice; it was later lifted into
// remainingOf, which is strictly better — two copies of a money formula is two
// chances for one of them to forget the refund term.
assert.ok(/unused/.test(tabC), 'credit is not surfaced'); n++;
{
  const body = tabC.slice(tabC.indexOf('function remainingOf'), tabC.indexOf('function remainingOf') + 320);
  assert.ok(/Number\(p\.allocated \|\| 0\)/.test(body),
    'unused credit per payment is not derived from allocations'); n++;
  assert.ok(/refunded/.test(body) && /refund_pending/.test(body),
    'unused credit ignores refunds — money already given back would be offered again'); n++;
}

// One payment split across two invoices shows both.
// The grouping was lifted into byInvoice() — several allocations to the SAME
// invoice on different dates are one line, not three, which the inline .map
// could not do.
assert.ok(/byInvoice\(p\.allocations\)/.test(tabC),
  'the tab shows one invoice per payment — a split advance would hide half of itself'); n++;
assert.ok(/function byInvoice/.test(tabC), 'byInvoice is gone'); n++;

// ── One Payment dialog: the AMOUNT comes first ─────────────────────────────
//
// This block used to assert the opposite — that the invoice was chosen before
// anything else — and that was right for the dialog it described. It is the
// wrong rule now, and the reason is worth keeping rather than quietly deleting.
//
// Take Payment and Record Payment were two buttons for one act, and Record
// Payment then asked "which invoice?" before it would accept an amount. At a
// counter neither question has an answer: somebody hands over ₹5,000 and
// nobody knows which of their three invoices it belongs to. So the order is
// reversed — the amount is typed, and the server works out the split.
assert.ok(/function PaymentModal/.test(tabC),
  'the merged Payment dialog is gone'); n++;
assert.ok(!/function TakePaymentModal|function RecordPaymentModal/.test(tabC),
  'the two old dialogs are still here — there must be exactly one'); n++;
{
  const body = tabC.slice(tabC.indexOf('function PaymentModal'));
  const amountIdx = body.indexOf('Amount received');
  const destIdx   = body.indexOf('Goes to');
  const planIdx   = body.indexOf('cpt-plan-hd');
  assert.ok(amountIdx > 0 && amountIdx < destIdx,
    'the destination is asked for before the amount — the amount is what decides it'); n++;
  assert.ok(destIdx > 0 && destIdx < planIdx,
    'the plan is drawn before the destination is chosen'); n++;
}

// The preview comes from the SERVER, not from the same rule written twice.
// Two implementations of "oldest first, fill completely, mind the paise" is two
// chances to disagree, and the one on screen disagreeing with the one that
// saves is the worst version of that bug: the user approves one thing and a
// different thing happens.
assert.ok(/\/api\/payments\/plan\?/.test(tabC),
  'the dialog computes the split itself instead of asking the server'); n++;
assert.ok(/\/api\/payments\/receive/.test(tabC),
  'the dialog cannot record a payment'); n++;
assert.ok(!/\$\{row\.id\}\/allocate/.test(tabC),
  'the dialog loops allocate calls, one per receipt, with no transaction around them'); n++;

// On save the client sends the AMOUNT, not the split — unless a human
// overrode it. That is what makes a stale preview harmless: the server
// re-plans inside its transaction, so there is no window to lose.
assert.ok(/const allocations = dest === 'credit'\s*\?\s*\[\]/.test(tabC),
  '"keep as credit" does not send an explicit empty allocation list'); n++;
assert.ok(/:\s*editing[\s\S]{0,300}:\s*null;/.test(tabC),
  'the automatic split is not sent as null — the client is deciding where money goes'); n++;

// A deposit against an un-billed job is shown apart from free credit, and is
// never spent by ticking "use it too". One number for both is how a Fortuner
// deposit came to be spendable on an Innova invoice.
assert.ok(/credit_available/.test(tabC) && /credit_held/.test(tabC),
  'free credit and held deposits are shown as one number'); n++;
assert.ok(/not spent automatically/.test(tabC),
  'a held deposit does not say that it is held'); n++;

// Both permissions, and separately. New money onto an invoice is
// ADD_INVOICE_PAYMENT or ALLOCATE_PAYMENT; spending money already received is
// ALLOCATE_PAYMENT alone. The server enforces exactly this split — see
// payauth.test.js — and the screen must not offer a path that ends in a 403.
assert.ok(/useCan\('ADD_INVOICE_PAYMENT'\)/.test(tabC), 'recording is not permission-gated'); n++;
assert.ok(/useCan\('ALLOCATE_PAYMENT'\)/.test(tabC), 'applying credit is not permission-gated'); n++;
assert.ok(/useCan\('COLLECT_PAYMENT'\)/.test(tabC), 'taking money at all is not permission-gated'); n++;
assert.ok(/canUseInvoices = outstanding > 0 && \(canAllocate \|\| canRecord\)/.test(tabC),
  'the invoice branch does not accept ADD_INVOICE_PAYMENT — a regression for anyone who has only that'); n++;
assert.ok(/!canAllocate \? 'Spending credit needs/.test(tabC),
  'the use-credit checkbox ignores the allocate permission'); n++;

// A settled invoice is not a place money can go. The server's planner filters
// them, and this is the assertion that says so out loud — the screen renders
// plan.lines and nothing else, so it cannot reintroduce one.
{
  const body = tabC.slice(tabC.indexOf('function PaymentModal'));
  assert.ok(/lines\.map\(l =>/.test(body) && !/invoices\.filter\(/.test(body),
    'the dialog builds its own invoice list instead of rendering the server plan'); n++;
}


// ── The badge says what the money DID, not what column it is stored in ──────
//
// payment_type is 'advance' for anything whose customer_invoice_id is NULL, and
// migration 133 forces that NULL on any payment split across two invoices. So a
// ₹2,500 that settled CI-51 and CI-53 was stored correctly and then labelled
// ADVANCE, which to a person means money taken before there was an invoice.
assert.ok(/function kindOf\(p\)/.test(tabC), 'the row kind is not derived at all'); n++;
{
  const body = tabC.slice(tabC.indexOf('function kindOf'), tabC.indexOf('const KIND_LABEL'));
  // The estimate is checked FIRST: a deposit that has since been applied to its
  // invoice is still a deposit, and testing allocations first would relabel
  // every advance the moment its invoice was raised.
  assert.ok(body.indexOf('p.estimate_id') < body.indexOf('allocations'),
    'allocations are checked before the estimate — applied advances would be relabelled'); n++;
  assert.ok(/return 'advance'/.test(body) && /return 'invoice'/.test(body) && /return 'credit'/.test(body),
    'the three kinds are not all produced'); n++;
}
assert.ok(/KIND_LABEL\[kind\]/.test(tabC),
  'the badge still prints the raw payment_type'); n++;
assert.ok(!/isAdvance \? 'ADVANCE' : 'INVOICE'/.test(tabC),
  'the old two-way badge is still there'); n++;

// The filters must use the same rule, or "Invoice payments" misses every
// payment that settled more than one invoice — the exact kind this creates.
assert.ok(/filter === 'invoice' && kindOf\(p\) !== 'invoice'/.test(tabC),
  'the type filter still matches on the raw column'); n++;

// payment_type is NOT changed, and must not be. CustomerInvoicesPage keys its
// locked-row rendering off it, correctly — those rows have no
// customer_invoice_id and its edit handler matches on one.
assert.ok(/const isAdvance = p\.payment_type === 'advance';/.test(tabC),
  'the stored type is no longer read, so the refund gate has lost its meaning'); n++;
assert.ok(/canRefund && isAdvance && unused > 0\.001/.test(tabC),
  'the refund button no longer gates on the stored type'); n++;

// ── The invoice screen, once an advance has been applied to it ──────────────
// The advance appears in this list because the money is on this invoice. It
// cannot be edited or deleted from here: its ledger row's customer_invoice_id
// is NULL — the money was taken against the estimate — and both handlers match
// on `id AND customer_invoice_id`. So the row must render as locked. A pencil
// that always returns 404 is worse than no pencil.
const ciPage = strip(read('pages/CustomerInvoicesPage.jsx'));
assert.ok(/const isAdvance = pay => pay\?\.payment_type === 'advance';/.test(ciPage),
  'the invoice screen cannot tell an applied advance from an ordinary payment'); n++;
// The branch order matters: the advance case is answered FIRST, because an
// advance taken online is both, and the reason it cannot be deleted here is
// that it belongs to the customer's credit — not that it came through a
// gateway. Whichever branch it lands in, it must not be the one with the bin.
{
  const cell = ciPage.slice(ciPage.indexOf('canDeletePay && ('));
  const del  = cell.slice(0, cell.indexOf('</td>'));
  assert.ok(/\{isAdvance\(pay\) \? \(/.test(del),
    'an applied advance is not answered before the online case, so it falls through'); n++;
  assert.ok(/isOnline\(pay\) \? \(/.test(del),
    'an online payment is no longer kept away from the delete button'); n++;
  const advBranch = del.slice(del.indexOf('{isAdvance(pay) ? ('), del.indexOf('isOnline(pay) ? ('));
  assert.ok(!/deletePayment/.test(advBranch),
    'an applied advance is offered a delete button the backend will not honour'); n++;
}
assert.ok(/canEditPayDate && !isOnline\(pay\) && !isAdvance\(pay\)/.test(ciPage),
  'an applied advance is offered a date pencil the backend will not honour'); n++;
assert.ok(/ADVANCE/.test(ciPage) && /voucher_no/.test(ciPage),
  'the applied advance is not labelled, and its receipt number is not shown'); n++;
// Part-applied: the row shows what landed here, so the difference must be said
// out loud or it reads as a smaller payment than the customer remembers making.
assert.ok(/Number\(pay\?\.payment_amount \|\| 0\) - Number\(pay\?\.amount \|\| 0\) > 0\.01/.test(ciPage),
  'a part-applied advance does not explain the difference between taken and applied'); n++;

// ── The public pay page ─────────────────────────────────────────────────────
// An advance is not a bill, and must not present itself as one.
assert.ok(/const isAdvance = invoice\.kind === 'advance'/.test(payPage),
  'the pay page cannot tell an advance from an invoice'); n++;
assert.ok(/isAdvance \? 'Advance amount' : 'Amount due'/.test(payPage),
  'an advance is labelled "Amount due" — over a job that has not been invoiced'); n++;
assert.ok(/\{!isAdvance && <Row label="Invoice number"/.test(payPage),
  'the pay page shows an invoice number for an advance, where none exists'); n++;
assert.ok(/const askAmount = isAdvance \? Number\(invoice\.link_amount \|\| 0\) : invoice\.balance/.test(payPage),
  'the advance page charges the job balance rather than what the link asked for'); n++;
assert.ok(/Balance after this/.test(payPage),
  'the customer is not told a balance remains — they would think the job is settled'); n++;
assert.ok(/Pay \$\{fmt\(askAmount\)\} securely/.test(payPage),
  'the pay button names the wrong amount'); n++;

// And the backend must supply what the page reads.
const pubPay = strip(fs.readFileSync(path.join(BE, 'src/controllers/public.payments.controller.js'), 'utf8'));
assert.ok(/kind,/.test(pubPay) && /link_amount: Number\(link\.amount\)/.test(pubPay),
  'the pay page API does not return kind and link_amount'); n++;
assert.ok(/link\.entity_type === 'estimate'/.test(pubPay),
  'the pay page cannot resolve an estimate-scoped link'); n++;

// ── The unallocated list ────────────────────────────────────────────────────
assert.ok(/export function UnallocatedPanel/.test(admin), 'there is no unallocated list'); n++;
assert.ok(/api\('\/api\/payments\/unallocated'\)/.test(admin), 'the panel does not call the endpoint'); n++;
assert.ok(/UnallocatedPanel/.test(pays) && /tab === 'unallocated'/.test(pays),
  'the unallocated list is not reachable from the Payments screen'); n++;
// Oldest first: the top of the list is what needs a decision.
const unalloc = strip(fs.readFileSync(path.join(BE, 'src/controllers/payments.controller.js'), 'utf8'))
  .slice(0);
assert.ok(/ORDER BY p\.paid_at ASC/.test(unalloc),
  'unallocated money is not listed oldest first — the part needing a decision is at the bottom'); n++;
assert.ok(/days_held/.test(admin) && /days_held/.test(unalloc),
  'how long money has been held is not shown'); n++;

console.log(`advance payment UI (phase 3): ${n} checks passed`);
