'use strict';

/**
 * phone.js — the single place a phone number becomes a canonical string.
 *
 * ── Why this needs to exist ──────────────────────────────────────────────────
 *
 * Numbers arrive here in every shape an operator can type: '9876543210',
 * '+91 98765 43210', '098765-43210'. Today each call site decides for itself
 * what to do with that, and they already disagree — AppointmentsPage.jsx:623
 * prefixes 91 on its wa.me link, LeadsPage.jsx:537 does not, so lead WhatsApp
 * links are broken for plain 10-digit numbers.
 *
 * That inconsistency is cosmetic while it only affects a click-to-chat link.
 * It stops being cosmetic once we send through Interakt, because **Interakt
 * upserts its contacts keyed on the phone number**. Two spellings of one
 * customer become two contacts, each with half the conversation history —
 * exactly the way customer_vehicles splits one vehicle across two spellings of
 * its registration.
 *
 * So: one function, and every caller uses it.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * India only, deliberately. Spinoto's own validation is `/^\d{10}$/`
 * (AppointmentsPage.jsx:1922) and every number in the system is an Indian
 * mobile. A general-purpose parser would be more code and more ways to be
 * subtly wrong about a case that does not occur. If that changes, this is the
 * one file to replace.
 */

const DEFAULT_CC = '91';

/**
 * Indian mobile numbers are 10 digits and begin 6–9. Landlines and service
 * numbers do not, and WhatsApp will not deliver to them — so rejecting here is
 * kinder than paying for a send that fails at Meta.
 */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Reduce anything to its national 10-digit form, or null.
 *
 * Accepts, in practice:
 *   '9876543210'        → '9876543210'
 *   '+91 98765 43210'   → '9876543210'
 *   '919876543210'      → '9876543210'
 *   '09876543210'       → '9876543210'
 *   '+91-98765-43210'   → '9876543210'
 *
 * Returns null for anything else — including empty, 'NA', and landlines.
 * Callers must treat null as "cannot message this person", not as "send
 * anyway".
 */
function toNational(raw) {
  if (raw === null || raw === undefined) return null;

  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // '00' international prefix, then the country code.
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Country code present.
  if (digits.length === 12 && digits.startsWith(DEFAULT_CC)) {
    digits = digits.slice(2);
  }

  // Domestic trunk prefix.
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return INDIAN_MOBILE.test(digits) ? digits : null;
}

/**
 * E.164, e.g. '+919876543210'. Null if the number is not a valid Indian mobile.
 *
 * This is the form stored in wa_messages.to_number and wa_conversations.mobile.
 * Storing the national form there instead would work right up until the first
 * non-Indian number, and then join incorrectly rather than fail loudly.
 */
function toE164(raw) {
  const national = toNational(raw);
  return national ? `+${DEFAULT_CC}${national}` : null;
}

/**
 * Interakt wants the two halves separately:
 *
 *   { "countryCode": "+91", "phoneNumber": "9876543210" }
 *
 * Returns null rather than a partly-filled object — a send with a blank
 * phoneNumber is a 400 from their API and a wasted queue attempt.
 */
function toInteraktParts(raw) {
  const national = toNational(raw);
  if (!national) return null;
  return { countryCode: `+${DEFAULT_CC}`, phoneNumber: national };
}

/**
 * Click-to-chat URL. wa.me wants digits only, no '+', country code included.
 *
 * Exists so the frontend link bug cannot be reintroduced server-side; the
 * frontend has its own copy of this for the same reason.
 */
function waMeUrl(raw) {
  const national = toNational(raw);
  return national ? `https://wa.me/${DEFAULT_CC}${national}` : null;
}

/**
 * True when this number can be messaged at all. Sugar, but it reads better at
 * the call site than `toE164(x) !== null` and makes the intent greppable.
 */
function isMessageable(raw) {
  return toNational(raw) !== null;
}

/**
 * Pick the number to message for a record that has both.
 *
 * `whatsapp` is optional throughout the schema and the UI falls back to
 * `mobile`. That fallback is fine for a link a human clicks. For a billed send
 * it is a guess, so this returns WHICH field was used and the caller logs it —
 * "we messaged the mobile because no WhatsApp number was set" is a support
 * answer; silently doing it is a mystery.
 */
function resolveTarget({ whatsapp, mobile } = {}) {
  const wa = toE164(whatsapp);
  if (wa) return { number: wa, source: 'whatsapp' };

  const mob = toE164(mobile);
  if (mob) return { number: mob, source: 'mobile', fellBack: true };

  return { number: null, source: null };
}

module.exports = {
  toNational,
  toE164,
  toInteraktParts,
  waMeUrl,
  isMessageable,
  resolveTarget,
};
