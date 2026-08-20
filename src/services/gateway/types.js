'use strict';

/**
 * The payment-gateway adapter contract, plus the money and mapping helpers
 * every adapter needs.
 *
 * WHY AN ADAPTER LAYER AT ALL
 * ───────────────────────────
 * Razorpay was already integrated once, inline, in
 * controllers/public.booking.controller.js. Adding invoice payments the same
 * way would have produced a SECOND order-creation function and a SECOND
 * signature check. Two implementations of a security primitive is one
 * implementation plus one that quietly rots — the day someone fixes a timing
 * leak in one of them, the other still has it.
 *
 * So there is exactly one rule for this directory:
 *
 *   The string 'razorpay' appears ONLY inside services/gateway/. No
 *   controller, service, route or migration outside this folder names a
 *   provider.
 *
 * That is also what makes the module extensible: a second provider is a new
 * file here that exports the same six functions.
 *
 * WHAT AN ADAPTER MUST IMPLEMENT
 * ──────────────────────────────
 *   name                                     'razorpay'
 *   isConfigured()                           → boolean (real keys present)
 *   publicKey()                              → the key the BROWSER may see
 *   mode()                                   → 'test' | 'live'
 *   createOrder({ amount, receipt, notes })  → { id, key_id }
 *   verifyPaymentSignature({ orderId, paymentId, signature })  → boolean
 *   verifyWebhookSignature({ rawBody, signature })             → boolean
 *   fetchPayment(paymentId)                  → normalised payment
 *   createRefund({ paymentId, amount, notes })→ { id, status, raw }
 *   listSettlements({ from, to })            → normalised settlements
 *
 * Amounts crossing this boundary are ALWAYS rupees as a JS number, never
 * paise. The paise conversion is an implementation detail of the provider and
 * lives on the far side of the adapter, so no controller can forget it.
 */

/**
 * Rupees → the gateway's smallest unit.
 *
 * Math.round, not truncation: 1234.56 * 100 is 123455.99999999999 in IEEE-754
 * binary floating point, and `| 0` on that charges the customer one paisa less
 * than the invoice says. On an invoice paid in full that single paisa is the
 * difference between status 'paid' and status 'partially_paid', which then
 * blocks the hub payout. This is not a hypothetical — it is the standard
 * float-money bug, and it bites at the exact moment that matters most.
 */
function toMinorUnit(rupees) {
  // Number(null), Number('') and Number(false) are all 0 — a finite number, so
  // a bare Number.isFinite check waves them through and an amount that was
  // never set becomes a ₹0 charge. Rejected explicitly: a missing amount is a
  // bug in the caller, and it should say so here rather than three layers down.
  if (rupees === null || rupees === undefined || rupees === '' || typeof rupees === 'boolean') {
    throw new Error(`Not a valid amount: ${JSON.stringify(rupees)}`);
  }
  const n = Number(rupees);
  if (!Number.isFinite(n)) throw new Error(`Not a valid amount: ${rupees}`);
  if (n <= 0) throw new Error(`Amount must be greater than zero, got ${n}`);
  return Math.round(n * 100);
}

/** The gateway's smallest unit → rupees, as a number with 2 decimals. */
function fromMinorUnit(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/**
 * Maps what the gateway says the customer used onto the `method` values
 * customer_invoice_payments already accepts (migration 078:
 * cash | upi | card | bank_transfer | other | app_payment).
 *
 * Deliberately lossy. The gateway's exact word is kept separately in
 * payment_transactions.method_detail; this is only so an accountant filtering
 * the ledger by "card" sees online card payments alongside the ones taken on
 * the workshop's own machine. Widening the ledger's CHECK constraint to hold
 * the gateway's growing vocabulary would push provider detail into a table nine
 * other files read.
 */
function toLedgerMethod(gatewayMethod) {
  switch (String(gatewayMethod || '').toLowerCase()) {
    case 'upi':        return 'upi';
    case 'card':
    case 'emi':        return 'card';
    case 'netbanking': return 'bank_transfer';
    case 'wallet':
    case 'paylater':   return 'app_payment';
    default:           return 'other';
  }
}

/**
 * Strips a gateway response down to what is safe to persist in
 * payment_transactions.raw_response.
 *
 * Two separate concerns, both of them real:
 *
 *   1. Secrets. Gateway payloads can echo tokens and card fingerprints. None of
 *      that may land in a table an admin screen renders, or in a database
 *      backup.
 *   2. Personal data. The payload carries the customer's email and phone. This
 *      system masks customer mobiles for hub logins at the response layer
 *      (middleware/maskMobile.middleware.js) — copying an unmasked number into
 *      a JSONB blob would route straight around that.
 *
 * Allow-list, not deny-list. A deny-list is wrong the first time the provider
 * adds a field.
 */
const RAW_ALLOWED = new Set([
  'id', 'entity', 'amount', 'currency', 'status', 'order_id', 'invoice_id',
  'method', 'amount_refunded', 'refund_status', 'captured', 'description',
  // 'vpa' is DELIBERATELY ABSENT — see maskVpa below.
  'card_id', 'bank', 'wallet', 'fee', 'tax', 'error_code',
  'error_description', 'error_source', 'error_step', 'error_reason',
  'acquirer_data', 'created_at', 'speed', 'speed_processed', 'batch_id',
  'settlement_id', 'utr', 'settled_at', 'payment_id',
]);

/**
 * A UPI handle, with the identifier removed.
 *
 * An Indian VPA is overwhelmingly `<10-digit mobile>@bank` — 9838212345@ybl.
 * Allow-listing `vpa` therefore did precisely what this file's own docblock
 * forbids two paragraphs up: it copied the customer's unmasked mobile into a
 * JSONB column, on every UPI payment, permanently. This system masks customer
 * mobiles to 98382xxxxx for hub logins at the response layer — and that masking
 * was being routed around, into a table an admin screen can read and into every
 * database backup.
 *
 * Dropping the field entirely would have cost something real: the handle is how
 * a customer's "I paid, it's not showing" is matched against the gateway
 * dashboard. So the bank suffix is kept — it identifies the app they paid with —
 * and the part that identifies the PERSON is not.
 *
 *   9838212345@ybl  →  98382xxxxx@ybl
 */
function maskVpa(vpa) {
  const s = String(vpa || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return null;                       // not a handle we recognise
  const id = s.slice(0, at), suffix = s.slice(at);
  if (id.length <= 5) return `${'x'.repeat(id.length)}${suffix}`;
  return `${id.slice(0, 5)}${'x'.repeat(id.length - 5)}${suffix}`;
}

function scrubRaw(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  // Handled before the allow-list loop, because the value is transformed rather
  // than copied — and it must never fall through to the generic branch below.
  if (typeof payload.vpa === 'string') {
    const masked = maskVpa(payload.vpa);
    if (masked) out.vpa = masked;
  }
  for (const key of Object.keys(payload)) {
    if (!RAW_ALLOWED.has(key)) continue;
    const v = payload[key];
    // acquirer_data nests one level and can carry a masked card number or a
    // UPI handle — keep the shape, run the same allow-list over it.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = scrubRaw(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Constant-time string comparison for signatures.
 *
 * A plain `===` on a hex digest leaks, through response timing, how many
 * leading characters of a forged signature were correct. That is enough to
 * reconstruct a valid signature one character at a time. The length check is
 * needed because timingSafeEqual throws on unequal lengths — and length alone
 * is not secret, every signature from this algorithm is the same length.
 *
 * The same comparison the booking flow already used; it lives here now so
 * every gateway path shares it instead of each re-deriving it.
 */
function safeEqual(a, b) {
  const crypto = require('crypto');
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Error carrying an HTTP status, matching the convention in the controllers. */
function gatewayError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

module.exports = {
  toMinorUnit,
  fromMinorUnit,
  toLedgerMethod,
  scrubRaw,
  safeEqual,
  maskVpa,
  gatewayError,
  RAW_ALLOWED,
};
