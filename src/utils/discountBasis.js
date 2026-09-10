'use strict';

/**
 * discountBasis.js — is a whole-bill discount an ex-GST amount or an inclusive one?
 *
 * ══ WHAT THE TWO BASES MEAN ════════════════════════════════════════════════
 *
 * A ₹1,100 service that already includes 18% GST, with ₹100 off:
 *
 *   ex_gst      ₹100 comes off the ₹932.20 taxable value, and the tax follows
 *               it down. The customer pays ₹982 — ₹118 less, not ₹100 less.
 *
 *   inclusive   ₹100 comes off the ₹1,100 the customer was quoted. They pay
 *               ₹1,000. The taxable value is then read back out of that
 *               (₹847.46) and the tax is what remains (₹152.54).
 *
 * Both are arithmetically sound and both declare tax on exactly what was
 * charged. They differ in what "₹100 off" is a promise ABOUT — the price on
 * the board, or a number the customer never sees. On a bill where every rate
 * quoted to the customer already includes GST, the second reading is the only
 * one that matches what was agreed at the counter.
 *
 * A PERCENTAGE lands on the same payable either way — 10% off a value and 10%
 * off that value plus its tax scale identically. What changes is the figure
 * PRINTED as the discount: on the ex-GST basis a "10%" discount on a ₹9,750
 * bill prints as ₹826.27, which is not 10% of any number the customer can see.
 *
 * ══ WHY IT IS KEYED ON created_at ══════════════════════════════════════════
 *
 * An invoice already handed to a customer must reprint identically for ever.
 * Applied to every document the moment it shipped, this would change the total
 * of every past invoice carrying a whole-bill discount — disagreeing with the
 * paper in the customer's file, with the payment recorded against it, and with
 * the GST return it was already reported in.
 *
 * So documents created before the cutover keep the ex-GST rule for ever, and
 * only new ones use the inclusive one. Identical mechanism to utils/math.js
 * (rounding) and utils/invoiceRounding.js (whole-rupee round off), for
 * identical reasons — and deliberately the same shape, so the next person
 * recognises the pattern rather than deciphering a third one.
 *
 * created_at, NEVER invoice_date: invoice_date is backdatable, and a rule that
 * moved when somebody backdated a document would let the totals of an issued
 * invoice be changed by editing a date field.
 *
 * ══ THE CUTOVER ════════════════════════════════════════════════════════════
 *
 * Midnight IST at the end of 7 September 2026 — the day the decision was made.
 * Chosen to sit slightly in the FUTURE of that decision rather than at the
 * start of the day: an invoice raised on the morning of the 7th stored totals
 * computed under the ex-GST rule, and a cutover at 00:00 that same day would
 * have made it re-render under the new one and disagree with itself.
 *
 * Move this and you rewrite history. It is a constant, not a setting, for that
 * reason.
 */

const INCLUSIVE_DISCOUNT_FROM = new Date('2026-09-07T18:30:00Z'); // 2026-09-08 00:00 IST

/**
 * @param {Date|string|null} createdAt  the DOCUMENT's created_at
 * @returns {'ex_gst'|'inclusive'}
 *
 * A missing date means a row being created right now (the generate handlers
 * pass `new Date()` because their row does not exist yet), so it takes the
 * current rule. Defaulting the other way would quietly put every new document
 * on the legacy basis the day this ships.
 */
function getDiscountBasis(createdAt) {
  if (!createdAt) return 'inclusive';
  return new Date(createdAt) < INCLUSIVE_DISCOUNT_FROM ? 'ex_gst' : 'inclusive';
}

module.exports = { INCLUSIVE_DISCOUNT_FROM, getDiscountBasis };
