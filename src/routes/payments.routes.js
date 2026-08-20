'use strict';

/**
 * /api/payments — authenticated payment endpoints.
 *
 * Everything here is behind requireAuth AND a permission. Note what is NOT
 * used: requirePermissionOrHub. That helper waves through any hub login,
 * including one with no permission rows at all, and these endpoints open
 * charges against the company's gateway account. The handlers reject hub
 * sessions explicitly as well — see the header of payments.controller.js.
 *
 * maskCustomerContact is mounted at the router, as on customer_invoices.routes,
 * so a hub login would see 98382xxxxx here too if hubs are ever given the
 * screen. Mounting it now rather than later means that decision is a nav change
 * and not a data-exposure review.
 *
 * The PUBLIC pay endpoints are deliberately NOT in this file — they live in
 * public.payments.routes.js, so a route can never be added here and quietly
 * inherit an unauthenticated mount.
 */

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const { maskCustomerContact } = require('../middleware/maskMobile.middleware');
const ctrl = require('../controllers/payments.controller');

const router = express.Router();

router.use(requireAuth);
router.use(maskCustomerContact);

// Reading the payment history of an invoice you can already see.
const canView = requirePermission('VIEW_PAYMENTS', 'VIEW_INVOICE');
// Starting a charge is its own permission — a person who may look at payments
// is not automatically a person who may take one.
const canCollect = requirePermission('COLLECT_PAYMENT');

// Static paths BEFORE the /:ref parameter route, or 'summary' and 'export' are
// captured as transaction references and every request 404s. The same ordering
// rule the invoice and appointment routers already carry.
router.get('/',        canView, ctrl.listPayments);
router.get('/summary', canView, ctrl.paymentsSummary);
// Collections grouped by hub, over the same filters as the list. canView, not
// canSettle: this is what was taken and where, which anyone who may look at the
// payments list may already work out row by row — unlike settlements, which
// expose what the gateway charges the company.
router.get('/by-hub',  canView, ctrl.paymentsByHub);
router.get('/export',  canView, ctrl.exportPayments);

// Payment links. Static, so above /:ref. Its own permission, because a link is
// a public URL that keeps working for whoever it is forwarded to — a different
// risk from taking a payment in person on a device you are holding.
const canLink = requirePermission('CREATE_PAYMENT_LINK');
router.get('/links',            canView, ctrl.listPaymentLinks);
router.post('/links',           canLink, ctrl.createPaymentLink);
router.post('/links/:id/cancel', canLink, ctrl.cancelPaymentLink);

// Settlements: accounting reconciliation, its own permission. Someone who
// handles day-to-day payments has no reason to see what the gateway transfers
// into the company's bank account, or what it charges for doing so.
const canSettle = requirePermission('VIEW_SETTLEMENTS');
router.get('/settlements',       canSettle, ctrl.listSettlements);
router.post('/settlements/sync', canSettle, ctrl.syncSettlements);
// Three segments, so it cannot be shadowed by anything below — but it is
// declared beside its siblings anyway, because the next person adding a
// settlements route will look here and nowhere else.
router.get('/settlements/:id/payments', canSettle, ctrl.listSettlementPayments);

// Gateway configuration — and, since the credentials moved into
// integration_settings, the endpoint that writes them.
//
// MANAGE_GATEWAY_SETTINGS is doing more work than it used to. It used to gate
// reading a status page; it now gates the key that charges customers' cards and
// the secret that decides which webhooks are believed. Anyone holding it can
// point this install at a different merchant account. Audit who has it.
//
// The PUT never returns a credential — see the header of the handler — so this
// is a write-only door, not a read-write one.
const canGateway = requirePermission('MANAGE_GATEWAY_SETTINGS');
router.get('/gateway',       canGateway, ctrl.getGatewaySettings);
router.put('/gateway',       canGateway, ctrl.saveGatewaySettings);
router.post('/gateway/test', canGateway, ctrl.testGatewayConnection);

router.post('/order',  canCollect, ctrl.createOrder);

// UPI QR. Same permission as /order — it is the same act (taking a payment
// against an invoice) through a different instrument, and giving it its own
// permission would mean a workshop that grants COLLECT_PAYMENT still cannot
// take the payment method most of its customers actually use.
//
// Static, and above /:ref. 'qr' would otherwise be read as a transaction
// reference by the catch-all at the bottom of this file.
router.post('/qr',             canCollect, ctrl.createQr);
router.post('/qr/:ref/cancel', canCollect, ctrl.cancelQr);

// Advances — money taken against an estimate, before any invoice exists.
//
// canCollect, same as /order and /qr: it is the same act (taking money from a
// customer for a job) at an earlier point in the job. A workshop that may
// collect payment may collect it in advance.
router.post('/advance', canCollect, ctrl.createAdvance);

// Money on the customer, before any job exists. Same permission as taking an
// advance against a quoted job — it is the same act, one step earlier — but its
// own route, because the two validate different things and a shared endpoint
// with a nullable estimate would hide that.
router.post('/account-credit', canCollect, ctrl.createAccountCredit);

// ── One payment in, wherever it belongs ─────────────────────────────────────
//
// The endpoint behind the merged Payment dialog: an amount, and the server
// works out which invoices it settles. Static, and above /:ref.
//
// canCollect gates the route because nothing may arrive without it. It is NOT
// canAllocate, even though this usually allocates — that check is made inside
// the handler and only when the request actually puts money against an invoice
// or spends existing credit. Gating the whole route on ALLOCATE_PAYMENT would
// take away the ability to accept a deposit from everyone who can do it today,
// for the sake of a branch they were not going to use.
router.post('/receive', canCollect, ctrl.receivePayment);
// The preview the dialog draws while you type. A read, and advisory only —
// /receive re-decides inside its own transaction rather than trusting it.
router.get('/plan', canView, ctrl.planPayment);
// Whether the feature is switched on at all. A read, so canView.
router.get('/account-credit/rate', canView, ctrl.accountCreditRate);

// The voucher documents. Reads, so VIEW_PAYMENTS — a receipt for money already
// taken is a record, and reading a record is not collecting one.
//
// Declared BEFORE the '/:ref/...' routes below. Express matches in order, and a
// fixed first segment is what keeps '/advance/12/voucher' meaning this route
// the day somebody adds a two-segment '/:ref/...' pattern that would otherwise
// swallow it.
router.get('/advance/:id/voucher', canView, ctrl.advanceVoucherPdf);
router.get('/refund/:id/voucher',  canView, ctrl.refundVoucherPdf);

// Returning an advance is refunding money, so it takes the refund permission,
// not the collect one. It is a separate route from '/:ref/refund' because that
// one addresses a GATEWAY transaction by txn_ref, and a cash advance has no
// transaction to name.
router.post('/advance/:id/refund', requirePermission('REFUND_PAYMENT'), ctrl.refundAdvancePayment);

// Applying received money to an invoice gets its OWN permission, and this is
// the one genuinely new right in the payments module.
//
// Recording a payment says money arrived. Allocating says WHERE it goes — and
// putting it against the wrong invoice makes one job look settled and another
// look unpaid, with a hub payout scheduled off the wrong one. Reversing it
// touches two invoices. That is not the same authority as taking cash at a
// counter, so it is not the same permission.
const canAllocate = requirePermission('ALLOCATE_PAYMENT');
router.post('/:ref/allocate', canAllocate, ctrl.allocatePayment);

// The same act for a whole customer at once, oldest money first. Static, so it
// sits with the allocate route it belongs to rather than below /:ref.
router.post('/apply-credit', canAllocate, ctrl.applyCustomerCredit);

// Reads. VIEW_PAYMENTS, because all three answer questions the payments list
// already answers row by row — they only answer them faster.
// ⚠ MUST stay above `router.get('/:ref')` at the bottom of this file.
//
// That route is a catch-all declared last on purpose. A literal path added
// BELOW it never matches — Express hands '/refunds' to getPayment as a txn_ref,
// which 404s with "Payment not found" and looks like a data problem rather than
// a routing one. It sits here with the other literal GETs so the ordering is
// obvious rather than remembered.
//
// canView, and deliberately no denyHub: this is a read, and a hub seeing its
// own refunds is correct. hubScopeSql in the handler does the scoping.
router.get('/refunds',              canView, ctrl.listRefunds);
router.get('/unallocated',          canView, ctrl.listUnallocated);
router.get('/credit/:mobile',       canView, ctrl.customerCredit);
router.get('/for-customer/:mobile', canView, ctrl.listForCustomer);

// Verification carries the gateway's signature, so it authenticates itself. It
// still sits behind the collect permission: the session that opened the order
// is the session that should be closing it, and leaving it on canView would let
// a read-only user drive a capture.
router.post('/verify', canCollect, ctrl.verifyPayment);

router.get('/for-invoice/:id', canView, ctrl.listForInvoice);

// Refunds are their own permission, not part of "can handle payments". Taking a
// payment wrongly is correctable; sending money out of the company account is
// not, from this system. The handler rejects hub sessions on top of this.
router.post('/:ref/refund', requirePermission('REFUND_PAYMENT'), ctrl.refundPayment);

// Last: this pattern matches anything, so every static route has to be above it.
router.get('/:ref', canView, ctrl.getPayment);

module.exports = router;
