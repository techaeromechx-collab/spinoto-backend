'use strict';

/**
 * invoiceRounding.js — the whole-rupee round-off on a customer or purchase invoice.
 *
 * ══ WHAT THIS IS ═══════════════════════════════════════════════════════════
 *
 * The lines add up to ₹834.55. The invoice says ₹835.00, and carries a visible
 * Round Off row of +₹0.45 so the column still reconciles:
 *
 *     Taxable        707.25
 *     CGST            63.65
 *     SGST            63.65
 *     Round Off       +0.45
 *     ─────────────────────
 *     Grand Total    835.00
 *
 * Nearest rupee, both directions: 50 paise or more goes up, less than 50 goes
 * down. ₹834.44 becomes ₹834.00 and the round off is −₹0.44.
 *
 * ══ WHAT IT DELIBERATELY DOES NOT DO ═══════════════════════════════════════
 *
 * It does not touch the taxable value, and it does not touch CGST/SGST/IGST.
 * Those stay at two decimals and are what gets declared.
 *
 * Section 170 of the CGST Act is written about the TAX amount — read strictly,
 * it says round each tax head to a rupee. Doing that has two problems: it
 * changes the tax you declare (₹127.30 becomes ₹128.00 on the bill above, so
 * GSTR-1 stops matching what the invoice computed), and it does not even
 * produce a clean total, because the taxable value still carries paise
 * (707.25 + 64 + 64 = ₹835.25).
 *
 * So this rounds the PAYABLE and leaves the tax exact — which is what Tally,
 * Busy and Zoho all print, and what the Round Off row exists to disclose. The
 * choice is the business's, not this file's; it is written down here because
 * the next person to read it will wonder.
 *
 * ══ WHY IT IS KEYED ON created_at ══════════════════════════════════════════
 *
 * An invoice already handed to a customer must reprint identically for ever. If
 * this applied to every document the moment it shipped, every historical
 * invoice would silently gain a rupee and disagree with the paper in the
 * customer's file, with the payment recorded against it, and with the GST
 * return it was already reported in.
 *
 * So documents created before the cutoff keep their exact-paise totals for
 * ever, and only new ones round. Same mechanism as utils/math.js, and for the
 * same reason.
 *
 * created_at, never invoice_date: invoice_date is backdatable, and a rule
 * keyed on it could be moved across the cutoff by editing a field.
 */

/**
 * Midnight IST on 1 September 2026 — the start of an accounting month.
 *
 * Deliberately a month boundary rather than "whenever this deploys". A cutoff
 * mid-month splits one month's invoices into rounded and unrounded halves, and
 * the person reconciling that month has to know the hour it changed. Starting
 * on the 1st means a month is entirely one or entirely the other.
 */
const ROUNDOFF_START_DATE = new Date('2026-08-31T18:30:00Z');

/** Two decimals, half-up — the same shape as utils/math.js roundHalfUp. */
const round2 = v => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

/**
 * @param {object} opts
 * @param {number} opts.grandTotal  the exact total, already summed from the rounded lines
 * @param {Date|string} [opts.createdAt]  the document's created_at. For a document
 *        being INSERTed, pass new Date() — the row does not exist yet, and that
 *        is the value the column is about to receive.
 * @returns {{ grandTotal: number, roundOff: number }}
 *          grandTotal is what to STORE — the rounded figure IS the total from
 *          then on. Nothing downstream should ever see the unrounded one:
 *          payment matching compares amount_paid against grand_total, and two
 *          numbers that differ by 45 paise leave an invoice stuck at
 *          partially_paid with a 1-paisa tolerance that cannot close it.
 */
function applyGrandTotalRounding({ grandTotal, createdAt }) {
  const exact = round2(grandTotal);

  // Before the cutoff — and for anything with no date at all, which is the
  // safe direction: leave the figure alone rather than invent a round-off for
  // a document whose era cannot be established.
  if (!createdAt || new Date(createdAt) < ROUNDOFF_START_DATE) {
    return { grandTotal: exact, roundOff: 0 };
  }

  /* Math.round is half-up and that is what is wanted: x.50 goes up. It is also
     exact here — `exact` is a two-decimal value, and the only boundary that
     matters (.50) is representable in binary without error, so there is no
     epsilon case to defend against at rupee scale.

     Negative totals are not a thing on an invoice, so Math.round's round-half-
     toward-positive-infinity behaviour on negatives is not reachable. */
  const rounded = Math.round(exact);
  return { grandTotal: rounded, roundOff: round2(rounded - exact) };
}

module.exports = { ROUNDOFF_START_DATE, applyGrandTotalRounding, round2 };
