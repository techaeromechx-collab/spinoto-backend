'use strict';

// What moving a customer invoice's date would do to its warranties.
//
// Warranty expiry is computed live from a service_date, never stored — see
// warranty_claims.controller.js. That service_date is the last payment date if
// there is one, otherwise the invoice's own date. So changing invoice_date
// moves the warranty clock for any UNPAID invoice, and backdating shortens the
// remaining cover.
//
// That is intended (SPEC decision 4): the backdated date is the claim about
// when the work was actually done, so the warranty should run from then. What
// is NOT acceptable is discovering it afterwards — hence this preflight, which
// reports exactly which items shift and which would cross from valid to
// expired before anything is written.
//
// Items with an already-registered claim are excluded: registration freezes
// service_date onto the warranty_claims row, so those are unaffected whatever
// happens to the invoice.

// Adds months then days to a 'YYYY-MM-DD', staying in pure calendar
// arithmetic via Date.UTC so the server's own timezone can never shift it.
//
// Month overflow follows the same convention as the existing claim maths
// (JS Date.setMonth): 31 Jan + 1 month lands on 3 March in a non-leap year,
// not 28 Feb. Kept deliberately identical so the preflight can never disagree
// with the validator it is predicting.
function addMonthsDays(from, months = 0, days = 0) {
  const [y, m, d] = String(from).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (months) dt.setUTCMonth(dt.getUTCMonth() + Number(months));
  if (days)   dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

// Normalises anything Postgres or Zod might hand us into 'YYYY-MM-DD'.
//
// The Date branch reads LOCAL components on purpose. pg-types parses a DATE
// column into a JS Date at LOCAL midnight, so toISOString() on it returns the
// PREVIOUS day on any server east of UTC — IST included. Reading the local
// fields gives back the calendar day Postgres actually sent.
function ymd(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * @param {object} a
 * @param {Array}  a.items        rows with { description, warranty_months, warranty_days,
 *                                guarantee_months, guarantee_days, has_open_claim,
 *                                last_payment_date }
 * @param {string} a.currentDate  the invoice's current invoice_date
 * @param {string} a.newDate      the proposed invoice_date
 * @param {string} a.today        'YYYY-MM-DD' — what counts as expired now
 *
 * @returns {{ shifting: Array, expiring: Array, unaffected: number }}
 *   shifting  — cover moves (start and expiry both change)
 *   expiring  — cover moves AND the item goes from valid today to expired today
 */
function warrantyImpact({ items = [], currentDate, newDate, today }) {
  const shifting = [];
  const expiring = [];
  let unaffected = 0;

  for (const it of items) {
    // A registered claim froze its own service_date; nothing here can move it.
    if (it.has_open_claim) { unaffected++; continue; }

    // A payment date wins over the invoice date, so a paid invoice's warranty
    // does not move at all when the invoice date changes.
    if (it.last_payment_date) { unaffected++; continue; }

    const months = Number(it.warranty_months || 0) + 0;
    const days   = Number(it.warranty_days   || 0) + 0;
    const gMonths = Number(it.guarantee_months || 0);
    const gDays   = Number(it.guarantee_days   || 0);

    // No time-based cover at all — km-only or none. Nothing to shift.
    if (!months && !days && !gMonths && !gDays) { unaffected++; continue; }

    const oldExpiry = months || days ? addMonthsDays(currentDate, months, days) : null;
    const newExpiry = months || days ? addMonthsDays(newDate,     months, days) : null;
    const oldGExpiry = gMonths || gDays ? addMonthsDays(currentDate, gMonths, gDays) : null;
    const newGExpiry = gMonths || gDays ? addMonthsDays(newDate,     gMonths, gDays) : null;

    const entry = {
      description: it.description,
      customer_invoice_item_id: it.customer_invoice_item_id ?? it.id ?? null,
      old_service_date: ymd(currentDate),
      new_service_date: ymd(newDate),
      old_expiry: oldExpiry,
      new_expiry: newExpiry,
      old_guarantee_expiry: oldGExpiry,
      new_guarantee_expiry: newGExpiry,
    };

    // Would this move an item from "still covered today" to "expired today"?
    const wasValid  = (oldExpiry  && oldExpiry  >= today) || (oldGExpiry  && oldGExpiry  >= today);
    const nowValid  = (newExpiry  && newExpiry  >= today) || (newGExpiry  && newGExpiry  >= today);

    if (wasValid && !nowValid) expiring.push(entry);
    else if (oldExpiry !== newExpiry || oldGExpiry !== newGExpiry) shifting.push(entry);
    else unaffected++;
  }

  return { shifting, expiring, unaffected };
}

// The rows warrantyImpact() needs, for one customer invoice.
const WARRANTY_ITEMS_SQL = `
  SELECT
    cii.id AS customer_invoice_item_id,
    cii.description,
    cii.warranty_months, cii.warranty_days,
    cii.guarantee_months, cii.guarantee_days,
    (SELECT MAX(p.paid_at)::date
       FROM invoice_payment_lines p
      WHERE p.customer_invoice_id = cii.customer_invoice_id)::text AS last_payment_date,
    EXISTS (
      SELECT 1 FROM warranty_claims wc
       WHERE wc.customer_invoice_item_id = cii.id
         AND wc.status IN ('registered','under_review','approved')
    ) AS has_open_claim
  FROM customer_invoice_items cii
  WHERE cii.customer_invoice_id = $1
  ORDER BY cii.id
`;

module.exports = { warrantyImpact, addMonthsDays, ymd, WARRANTY_ITEMS_SQL };
