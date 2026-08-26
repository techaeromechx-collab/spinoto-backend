'use strict';
/**
 * transactionDiscount.js — how a whole-bill discount reaches the tax lines.
 *
 * ══ THE BUG THIS REPLACES ══════════════════════════════════════════════════
 *
 * Every place that handled a transaction discount did this:
 *
 *     grandTotal = grandTotal - discount;      // and nothing else
 *
 * subtotal_ex_gst and total_gst were left at their PRE-discount values, so the
 * summary block on the document did not add up:
 *
 *     taxable  2,031.36
 *     GST        365.64
 *     ─────────────────
 *              2,397.00      ...printed under a Grand Total of 1,897.00
 *
 * And the tax was overstated: ₹365.64 declared on a sale that no longer
 * carried it. A discount given at the time of supply reduces the taxable
 * value; the tax follows the value down.
 *
 * That line was written five times — estimates.controller, the customer
 * invoice, the purchase invoice (differently), and twice in EstimatesPage.
 * Four of them agreed and the fifth did not, which is the entire argument for
 * this file existing.
 *
 * ══ THE RULE ═══════════════════════════════════════════════════════════════
 *
 * The discount comes off the EX-GST value. Tax is then charged on what is
 * left.
 *
 *     taxable      = ex-GST − discount
 *     gst          = taxable × the line's own rate
 *     grand total  = taxable + gst
 *
 * So ₹500 off the worked example above gives 1,531.36 + 275.64 = ₹1,807.00,
 * and the three numbers reconcile.
 *
 * ── Why per line and not on the total ──────────────────────────────────────
 *
 * "GST on the discounted subtotal" only works if every line carries the same
 * rate. A bill mixing an 18% service with a 28% part has no single rate to
 * apply, and using a blended one puts the wrong amount under each head — the
 * grand total would come out right and the CGST/SGST split would be wrong,
 * which is the version of this mistake nobody notices.
 *
 * So the discount is apportioned across the lines in proportion to their
 * ex-GST value, and each line is then taxed at its own rate.
 *
 * ── Why the last line absorbs the rounding ─────────────────────────────────
 *
 * Three lines sharing ₹500 gives ₹166.666… each. Rounded independently they
 * sum to ₹500.01 or ₹499.98, and the discount printed on the invoice is not
 * the discount actually given. The first n−1 shares are rounded and the last
 * takes the remainder, so the apportionment sums to the discount exactly.
 */

/**
 * @param {object}   opts
 * @param {Array}    opts.items          objects carrying an ex-GST amount and a rate
 * @param {string}   [opts.discountType] 'percent' | 'flat' | null
 * @param {number}   [opts.discountValue]
 * @param {function} opts.roundFn        the era-correct rounder — see utils/math.js
 * @param {function} [opts.exGstOf]      item → its ex-GST amount
 * @param {function} [opts.rateOf]       item → its GST percentage
 *
 * @returns {{
 *   discountAmount: number,
 *   subtotalExGst:  number,   // AFTER the discount — what is actually taxable
 *   totalGst:       number,
 *   grandTotal:     number,
 *   grossExGst:     number,   // BEFORE the discount, for the "you saved" line
 *   lines: Array<{ item, share, taxable, gst, total }>
 * }}
 */
function applyTransactionDiscount({
  items,
  discountType = null,
  discountValue = 0,
  roundFn,
  exGstOf = it => Number(it.total_inc_gst || 0) - Number(it.gst_amount || 0),
  rateOf  = it => Number(it.gst_percent || 0),
}) {
  const rows = (items || []).map(it => ({
    item:   it,
    exGst:  Number(exGstOf(it)) || 0,
    rate:   Number(rateOf(it))  || 0,
  }));

  const grossExGst = rows.reduce((s, r) => s + r.exGst, 0);

  /* The percentage is of the EX-GST value, not the inclusive total — the same
     change of basis as everything else here. 10% off a ₹2,397 bill used to
     mean ₹239.70; it now means ₹203.14, and the customer pays ₹239.70 less
     either way once the tax follows it down. */
  let discountAmount = 0;
  if (discountValue > 0) {
    if (discountType === 'percent')   discountAmount = roundFn(grossExGst * discountValue / 100);
    else if (discountType === 'flat') discountAmount = Math.min(discountValue, grossExGst);
  }
  /* Capped at the ex-GST value. Without it a ₹5,000 discount on a ₹2,000 bill
     produces a negative taxable value and therefore negative tax — an invoice
     that claims the government owes the customer money. */
  discountAmount = Math.min(Math.max(discountAmount, 0), grossExGst);

  let allocated = 0;
  const lines = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    // Last line takes the remainder so the shares sum to the discount exactly.
    const share = isLast
      ? roundFn(discountAmount - allocated)
      : (grossExGst > 0 ? roundFn(discountAmount * r.exGst / grossExGst) : 0);
    allocated += share;

    const taxable = roundFn(r.exGst - share);
    const gst     = roundFn(taxable * r.rate / 100);
    return { item: r.item, share, taxable, gst, total: roundFn(taxable + gst) };
  });

  const subtotalExGst = roundFn(lines.reduce((s, l) => s + l.taxable, 0));
  const totalGst      = roundFn(lines.reduce((s, l) => s + l.gst, 0));

  return {
    discountAmount: roundFn(discountAmount),
    subtotalExGst,
    totalGst,
    // Summed from the lines rather than subtotal + totalGst, so the printed
    // total is the sum of the printed rows and cannot be a paisa off them.
    grandTotal: roundFn(lines.reduce((s, l) => s + l.total, 0)),
    grossExGst: roundFn(grossExGst),
    lines,
  };
}

module.exports = { applyTransactionDiscount };
