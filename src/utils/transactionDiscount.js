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
 * There are two, and which one applies is decided by the document's created_at
 * — see utils/discountBasis.js for why an issued invoice must keep its own.
 *
 * 'inclusive' (documents created from the cutover onwards)
 *
 *     The discount comes off the price the customer was quoted, which already
 *     includes GST. The taxable value is then read back out of what is left.
 *
 *         payable = inc-GST − discount
 *         taxable = payable ÷ (1 + rate/100)
 *         gst     = payable − taxable
 *
 *     ₹100 off a ₹1,100 service means the customer pays ₹1,000. That is what
 *     "₹100 off" says on the board, and it is what the customer counts out.
 *
 * 'ex_gst' (documents created before the cutover — unchanged, for ever)
 *
 *         taxable     = ex-GST − discount
 *         gst         = taxable × the line's own rate
 *         grand total = taxable + gst
 *
 *     ₹100 off the same service means the customer pays ₹982 — ₹118 less,
 *     because the tax came off the discount too.
 *
 * Both declare tax on exactly what was charged. They differ in what the
 * discount is a promise about.
 *
 * ── Why per line and not on the total ──────────────────────────────────────
 *
 * "GST on the discounted subtotal" only works if every line carries the same
 * rate. A bill mixing an 18% service with a 28% part has no single rate to
 * apply, and using a blended one puts the wrong amount under each head — the
 * grand total would come out right and the CGST/SGST split would be wrong,
 * which is the version of this mistake nobody notices.
 *
 * So the discount is apportioned across the lines in proportion to their value
 * — inclusive value on the inclusive basis, ex-GST value on the legacy one —
 * and each line is then taxed at its own rate.
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
  /* The line's INCLUSIVE value — what the customer was quoted for it.
     ─────────────────────────────────────────────────────────────────────────
     Read directly rather than derived, because deriving it round-trips through
     a rounded ex-GST figure and loses a paisa: a ₹2,000 line stores ex-GST
     ₹1,694.92, and ₹1,694.92 × 1.18 is ₹2,000.01. That paisa reached the face
     of the document — a ₹2,000 bill discounted to zero printed a discount of
     ₹2,000.01, which is not a number anyone can defend.

     Returns 0/null when the caller's items carry no inclusive field, and the
     derivation below takes over.

     IF YOU OVERRIDE exGstOf, OVERRIDE THIS TOO. The pair has to describe the
     same money: an item row's total_inc_gst is the value AFTER any line-item
     discount, so a caller passing a PRE-discount ex-GST value through exGstOf
     and leaving this default would mix the two and mis-apportion the split. */
  incOf   = it => Number(it.total_inc_gst || 0),
  /* Which of the two rules above applies. Callers pass
     getDiscountBasis(row.created_at) — see utils/discountBasis.js.

     Defaults to 'ex_gst' so that any caller not yet updated keeps its exact
     current behaviour rather than silently changing what it charges. A
     money-handling default must be the one that changes nothing. */
  basis = 'ex_gst',
}) {
  const inclusive = basis === 'inclusive';

  const rows = (items || []).map(it => {
    const exGst = Number(exGstOf(it)) || 0;
    const rate  = Number(rateOf(it))  || 0;
    return {
      item: it,
      exGst,
      rate,
      // Stored value when there is one; derived only as a fallback.
      inc: Number(incOf(it)) || roundFn(exGst * (1 + rate / 100)),
    };
  });

  const grossExGst = rows.reduce((s, r) => s + r.exGst, 0);
  const grossIncGst = roundFn(rows.reduce((s, r) => s + r.inc, 0));
  // The value the discount is a percentage OF, and is capped BY.
  const base = inclusive ? grossIncGst : grossExGst;

  /* On the inclusive basis a percentage is of the price the customer sees, so
     "10%" on a ₹9,750 bill prints as ₹975.00 — a number they can verify. On
     the legacy basis it was 10% of the ex-GST value and printed as ₹826.27,
     which is 10% of nothing on the page. Both take the same amount off the
     payable; only one of them says so. */
  let discountAmount = 0;
  if (discountValue > 0) {
    if (discountType === 'percent')   discountAmount = roundFn(base * discountValue / 100);
    else if (discountType === 'flat') discountAmount = Math.min(discountValue, base);
  }
  /* Capped at the base. Without it a ₹5,000 discount on a ₹2,000 bill produces
     a negative taxable value and therefore negative tax — an invoice that
     claims the government owes the customer money. */
  discountAmount = Math.min(Math.max(discountAmount, 0), base);

  let allocated = 0;
  const lines = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    const weight = inclusive ? r.inc : r.exGst;
    // Last line takes the remainder so the shares sum to the discount exactly.
    const share = isLast
      ? roundFn(discountAmount - allocated)
      : (base > 0 ? roundFn(discountAmount * weight / base) : 0);
    allocated += share;

    if (inclusive) {
      /* The share is an INCLUSIVE amount, so it comes off the inclusive line
         and the taxable value is read back out of what remains. Subtracting it
         from the ex-GST value instead would take the tax off the discount too
         — which is precisely the legacy branch below. */
      const total   = roundFn(Math.max(0, r.inc - share));
      const taxable = r.rate > 0 ? roundFn(total / (1 + r.rate / 100)) : total;
      /* total − taxable, never taxable × rate: the two disagree by a paisa on
         values that do not divide cleanly, and only this form guarantees the
         three printed figures on the row add up to each other. */
      return { item: r.item, share, taxable, gst: roundFn(total - taxable), total };
    }

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
    /* What the customer was quoted, before the discount — the "Items (incl.
       GST)" row. On the inclusive basis that row minus the discount row equals
       the grand total, which is the arithmetic a customer checks by hand. */
    grossIncGst,
    basis,
    lines,
  };
}

module.exports = { applyTransactionDiscount };
