'use strict';
/**
 * Customer contact numbers, masked for hub logins.
 *
 * WHY THIS IS SERVER-SIDE
 * ───────────────────────
 * Hiding the number in React would be theatre: the full value still travels to
 * the hub's browser in the JSON, visible in devtools and in any script they
 * care to run. If a workshop should not hold a list of Spinoto's customer
 * numbers, the API must not send them. Same reasoning as the margin columns on
 * the purchase invoice — the guard is where the data is, not where it renders.
 *
 * WHAT IS DELIBERATELY NOT MASKED
 * ───────────────────────────────
 * /api/customers/lookup. It is exact-match only: a hub has to type the full
 * number before it returns anything, so masking the reply protects nothing and
 * would break the direct-estimate flow, which needs the real mobile to attach
 * the estimate to a customer identity.
 *
 * The hub's OWN numbers — owner_mobile, contact_number, rm_mobile — are
 * different keys and are untouched. Those are theirs.
 */
const { isHubUser } = require('./hubScope');

// Keys that carry a CUSTOMER's contact number. `whatsapp` is on appointments
// and is a second, equally direct channel — masking `mobile` alone would leave
// the front door open.
const MASKED_KEYS = new Set(['mobile', 'whatsapp']);

/**
 * '9838212345' → '98382xxxxx'
 *
 * Keeps the first five digits, which is enough for a human to recognise a
 * number they already know, and hides the rest.
 */
function maskMobile(value) {
  if (value == null || value === '') return value;
  const digits = String(value).replace(/\D/g, '');
  // Anything that is not a recognisable Indian mobile is masked WHOLE rather
  // than passed through. A number stored in an unexpected shape is exactly the
  // case where "leave it alone" quietly leaks it.
  if (digits.length < 10) return 'xxxxxxxxxx';
  // slice(-10) so a stored 91-prefixed number masks the same as a bare one,
  // instead of showing '91983' and hiding a digit that was never secret.
  const last10 = digits.slice(-10);
  return `${last10.slice(0, 5)}xxxxx`;
}

/**
 * Walk a response payload and mask every customer number in it, but only for a
 * hub session. Recursive on purpose: list rows, a single record, nested
 * timelines and payment arrays all carry the same key names, and enumerating
 * every shape by hand is how one gets missed.
 *
 * Returns the value unchanged for staff, so callers can wrap unconditionally.
 */
function scrubMobiles(req, payload) {
  if (!isHubUser(req)) return payload;
  return walk(payload);
}

function walk(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(walk);
  // Dates, Buffers and the like are objects but must not be rebuilt as plain
  // ones — only walk things that are actually record-shaped.
  if (node.constructor && node.constructor !== Object) return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = MASKED_KEYS.has(k) ? maskMobile(v) : walk(v);
  }
  return out;
}

module.exports = { maskMobile, scrubMobiles, MASKED_KEYS };
