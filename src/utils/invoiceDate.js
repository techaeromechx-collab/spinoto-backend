'use strict';

// Document-date rules — the single place that decides whether a given date is
// allowed, for ALL THREE documents: estimate, purchase invoice, customer
// invoice. Every write path goes through validateInvoiceDate(), so a rule can
// never be enforced on one and forgotten on another.
//
// The chain it enforces:
//
//   estimate_date  <=  purchase_invoice.invoice_date  <=  customer_invoice.invoice_date  <=  today
//
// See SPEC_backdated_customer_invoice.md §4 and PLAN_backdated_job_chain.md
// for why each rule exists.
//
// ── On timezones ────────────────────────────────────────────────────────────
// Everything here is plain 'YYYY-MM-DD' string arithmetic in IST. No JS Date
// is used for comparison, on purpose: the pool sets no session timezone (Neon
// defaults to UTC) while the business runs on IST, and mixing the two is the
// bug utils/payoutSchedule.js already had to be fixed for. A calendar date has
// no time-of-day, so treating it as a string keeps it that way.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // India has no DST

// Today's calendar date in IST, regardless of the server's own timezone.
function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Whole days from `a` to `b`, both 'YYYY-MM-DD'. Positive when b is later.
// Uses Date.UTC so it is pure calendar arithmetic with no local-time exposure.
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Indian financial year runs 1 April → 31 March. Returns the starting year:
// 2026-03-31 is FY2025, 2026-04-01 is FY2026.
function financialYear(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

function fyLabel(ymd) {
  const y = financialYear(ymd);
  return `FY ${y}-${String(y + 1).slice(2)}`;
}

// Accepts a Date, a timestamp string, or an already-plain 'YYYY-MM-DD', and
// returns the IST calendar date. Used to normalise created_at values coming
// back from Postgres, which may be either a string or a Date depending on the
// column type and the pg type parser.
function toIstDate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;            // already a date
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return istToday(new Date(value));
    return istToday(new Date(value));
  }
  return istToday(new Date(value));
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// What each document is called in an error message, and what sits upstream of
// it in the chain. The chain is estimate → purchase invoice → customer invoice:
// the work is quoted, the hub bills us, we bill the customer.
const DOC_LABEL = {
  estimate:         'Estimate',
  purchase_invoice: 'Purchase invoice',
  customer_invoice: 'Invoice',
};
// What sits immediately upstream of each document. A customer invoice derives
// from the purchase invoice when one exists (PI is generated first), and from
// the estimate otherwise — so the label depends on which was actually passed,
// not on the document type alone. Saying "before its estimate" when the real
// constraint was the purchase invoice sends the user to fix the wrong thing.
const CHAIN_BEFORE_LABEL = {
  purchase_invoice: { explicit: 'its estimate',           fallback: 'its estimate' },
  customer_invoice: { explicit: 'its purchase invoice',   fallback: 'its estimate' },
  estimate:         { explicit: 'the document it derives from', fallback: 'the document it derives from' },
};

/**
 * Validates a proposed invoice_date.
 *
 * @param {object}  a
 * @param {string}  a.invoiceDate      proposed date, 'YYYY-MM-DD'
 * @param {string}  a.currentDate      the date it has now (null when creating)
 * @param {string}  a.estimateDate     linked estimate's created_at (IST date)
 * @param {string}  a.piDate           linked PI's invoice_date, if any
 * @param {string}  a.earliestPayment  earliest recorded payment date, if any
 * @param {string}  a.maxExistingDate  highest invoice_date already issued
 * @param {object}  a.settings         { books_locked_through, backdate_max_days }
 * @param {object}  a.warranty         { expiring: [{description, oldExpiry, newExpiry}] }
 * @param {boolean} a.canBackdate      holds BACKDATE_INVOICE
 * @param {boolean} a.canOverride      holds OVERRIDE_INVOICE_DATE_LIMITS
 * @param {string}  a.documentType     'estimate' | 'purchase_invoice' | 'customer_invoice'
 * @param {string}  a.chainBefore      the date of the document upstream of this
 *                                     one (estimate for a PI, PI for a CI)
 * @param {string}  a.chainAfter       the date of the document downstream, if it
 *                                     already exists
 * @param {string}  a.today            override for tests
 *
 * @returns {{ ok: boolean, errors: Array, warnings: Array }}
 *   errors   — block the write. Each { code, message, overridable }.
 *   warnings — surface to the user, do not block.
 */
function validateInvoiceDate({
  invoiceDate,
  currentDate = null,
  estimateDate = null,
  piDate = null,
  earliestPayment = null,
  maxExistingDate = null,
  settings = {},
  warranty = null,
  canBackdate = false,
  canOverride = false,
  today = null,
  documentType = 'customer_invoice',
  chainBefore = null,
  chainAfter = null,
  chainAfterLabel = 'a later document in this job',
} = {}) {
  const DOC = DOC_LABEL[documentType] || 'Document';
  const errors = [];
  const warnings = [];
  const err = (code, message, overridable = false) => errors.push({ code, message, overridable });

  // ── Shape ────────────────────────────────────────────────────────────────
  if (!invoiceDate || !YMD_RE.test(invoiceDate)) {
    err('INVALID_FORMAT', `${DOC} date must be a calendar date in YYYY-MM-DD form.`);
    return { ok: false, errors, warnings };
  }
  // Rejects 2026-02-31 and friends, which pass the regex but aren't real days.
  const [yy, mm, dd] = invoiceDate.split('-').map(Number);
  const probe = new Date(Date.UTC(yy, mm - 1, dd));
  if (probe.getUTCMonth() + 1 !== mm || probe.getUTCDate() !== dd) {
    err('INVALID_FORMAT', `${invoiceDate} is not a real calendar date.`);
    return { ok: false, errors, warnings };
  }

  const now = today || istToday();
  const unchanged = currentDate && currentDate === invoiceDate;

  // No-op: nothing to validate, nothing to record.
  if (unchanged) return { ok: true, errors, warnings, unchanged: true };

  const isBackdated = invoiceDate < now;

  // ── 1. Not in the future. Hard, always. ──────────────────────────────────
  // Not overridable: a tax invoice dated in the future is invalid under every
  // configuration, and there is no legitimate reason to issue one.
  if (invoiceDate > now) {
    err('FUTURE_DATE', `${DOC} date cannot be in the future (today is ${now} IST).`);
  }

  // ── Permission ───────────────────────────────────────────────────────────
  if (isBackdated && !canBackdate && !canOverride) {
    err('NOT_PERMITTED', `You do not have permission to backdate ${documentType === 'estimate' ? 'an estimate' : 'an invoice'}.`);
  }

  // ── 2. The chain must stay in order. Hard. ───────────────────────────────
  //
  //   estimate_date  <=  purchase invoice  <=  customer invoice
  //
  // A document cannot predate the one it derives from. This is the rule that
  // used to compare against estimates.created_at and made backdating useless
  // for retroactively-entered jobs — now that an estimate has its own date,
  // the guarantee is the same but backdating the estimate moves the floor.
  // Prefer the explicit link, fall back to the estimate. Whichever is LATER is
  // the binding constraint, so check both rather than only the nearer one — a
  // PI dated before its own estimate would otherwise let a CI slip under the
  // estimate date too.
  const explicitUp = chainBefore ? toIstDate(chainBefore) : null;
  const fallbackUp = (documentType === 'customer_invoice' && estimateDate)
    ? toIstDate(estimateDate) : null;
  const upstream = [explicitUp, fallbackUp].filter(Boolean).sort().pop() || null;
  if (upstream && invoiceDate < upstream) {
    const labels = CHAIN_BEFORE_LABEL[documentType] || CHAIN_BEFORE_LABEL.estimate;
    const what = (explicitUp && upstream === explicitUp) ? labels.explicit : labels.fallback;
    err('BEFORE_ESTIMATE',
      `${DOC} date ${invoiceDate} is before ${what} (${upstream}). ` +
      'Backdate that first if the whole job needs moving.');
  }

  // The mirror of the same rule: moving a document forward past something
  // downstream of it would break the chain from the other end.
  if (chainAfter && invoiceDate > toIstDate(chainAfter)) {
    err('AFTER_DOWNSTREAM',
      `${DOC} date ${invoiceDate} is after ${chainAfterLabel} (${toIstDate(chainAfter)}). ` +
      'Move that one first, or move them together.');
  }

  // ── 3. Same financial year. Hard. ────────────────────────────────────────
  //
  // Compared against the document's CURRENT financial year, not today's. Both
  // directions matter and only checking against `now` caught one of them: an
  // invoice dated 28 March (FY2025) could be moved to 1 April (FY2026) on
  // 2 April with no complaint, quietly shifting revenue into the new year —
  // the more damaging direction, and the one the old rule allowed.
  //
  // For a brand-new document currentDate is null, so the reference is today,
  // which is the same rule as before.
  const referenceFy = financialYear(currentDate ? toIstDate(currentDate) : now);
  if (financialYear(invoiceDate) !== referenceFy) {
    const refLabel = currentDate ? fyLabel(toIstDate(currentDate)) : fyLabel(now);
    err('DIFFERENT_FINANCIAL_YEAR',
      `${DOC} date ${invoiceDate} falls in ${fyLabel(invoiceDate)}, but this document ` +
      `belongs to ${refLabel}. Documents cannot be moved across financial years.`);
  }

  // ── 4. Books lock. Overridable. Both directions. ─────────────────────────
  //
  // Checking only the NEW date left the bigger hole open: an invoice already
  // sitting inside a closed, filed period could be moved OUT of it freely,
  // because the destination was in the open period. That removes revenue from
  // a period already reported to the tax authority — at least as serious as
  // adding to it. Either endpoint being locked is a locked change.
  const lockedThrough = settings.books_locked_through
    ? toIstDate(settings.books_locked_through) : null;
  if (lockedThrough) {
    const currentLocked = currentDate && toIstDate(currentDate) <= lockedThrough;
    const targetLocked  = invoiceDate <= lockedThrough;
    if (targetLocked || currentLocked) {
      const what = targetLocked && currentLocked
        ? `Both ${invoiceDate} and its current date are inside the closed period`
        : (targetLocked
            ? `Dating this ${DOC.toLowerCase()} ${invoiceDate} would put it in a period that may already have been filed`
            : `This ${DOC.toLowerCase()} is currently dated ${toIstDate(currentDate)}, inside the closed period — moving it out would change a period that may already have been filed`);
      err('PERIOD_LOCKED', `The books are closed through ${lockedThrough}. ${what}.`, true);
    }
  }

  // ── 5. Backdating window. Overridable. ───────────────────────────────────
  // `?? 30`, not Number.isFinite(Number(x)) — Number(null) is 0, which is
  // finite, so a null column silently produced a zero-day window and rejected
  // every backdate with "the limit is 0 days".
  const maxDays = settings.backdate_max_days ?? 30;
  if (isBackdated) {
    const back = daysBetween(invoiceDate, now);
    if (back > maxDays) {
      err('OUTSIDE_WINDOW',
        `${DOC} date is ${back} days back; the limit is ${maxDays} days.`,
        true);
    }
  }

  // ── 6. Warranty. Overridable, but only when nothing actually expires. ────
  // Shortening cover is expected (decision 4). Retroactively expiring an
  // unclaimed item is not something to do by accident.
  const expiring = warranty?.expiring || [];
  if (expiring.length) {
    const names = expiring.slice(0, 3).map(i => i.description).join(', ');
    const more  = expiring.length > 3 ? ` and ${expiring.length - 3} more` : '';
    err('WARRANTY_WOULD_EXPIRE',
      `${expiring.length} warranty item(s) would become expired at this date: ${names}${more}.`,
      true);
  }
  const shifting = warranty?.shifting || [];
  if (shifting.length && !expiring.length) {
    warnings.push({
      code: 'WARRANTY_SHORTENED',
      message: `Warranty cover on ${shifting.length} item(s) will start earlier and end sooner.`,
      items: shifting,
    });
  }

  // ── 7. PI must not be dated after its CI. Warning. ───────────────────────
  if (piDate && toIstDate(piDate) > invoiceDate) {
    warnings.push({
      code: 'PI_AFTER_CI',
      message: `The linked purchase invoice is dated ${toIstDate(piDate)}, after this date. ` +
               'Consider moving it too.',
    });
  }

  // ── 8. Payment before invoice. Warning — advance payments are real. ──────
  if (earliestPayment && toIstDate(earliestPayment) < invoiceDate) {
    warnings.push({
      code: 'PAYMENT_BEFORE_INVOICE',
      message: `A payment is recorded on ${toIstDate(earliestPayment)}, before this invoice date.`,
    });
  }

  // ── 9. Sequence break. Warning, recorded. ────────────────────────────────
  // Invoice numbers come from the row id, so they follow creation order while
  // the date follows user input. Decision 1 (option A) permits the two to
  // disagree; this is what makes the disagreement visible instead of silent.
  if (maxExistingDate && invoiceDate < toIstDate(maxExistingDate)) {
    warnings.push({
      code: 'SEQUENCE_BREAK',
      message: `A later-numbered invoice already carries a newer date ` +
               `(${toIstDate(maxExistingDate)}). Invoice number order and date order ` +
               'will not match for this invoice.',
    });
  }

  // ── Resolve overrides ────────────────────────────────────────────────────
  const blocking = canOverride ? errors.filter(e => !e.overridable) : errors;
  // Only claim something was overridden when the write can actually proceed.
  // With a hard rule also failing, the request is refused and nothing was
  // overridden — saying otherwise in the 409 body is just misleading.
  const overridden = (canOverride && blocking.length === 0)
    ? errors.filter(e => e.overridable) : [];
  for (const o of overridden) {
    warnings.push({ code: `OVERRIDDEN_${o.code}`, message: `Overridden: ${o.message}` });
  }

  return {
    ok: blocking.length === 0,
    errors: blocking,
    warnings,
    overridden,
    isBackdated,
  };
}

/**
 * Turns a validation result into the 409 body the API returns. Kept here so
 * both write paths report failures identically.
 */
function validationError(result) {
  const requiresOverride = result.errors.some(e => e.overridable);
  return {
    error: result.errors[0]?.message || 'Invoice date is not allowed.',
    code: result.errors[0]?.code,
    errors: result.errors,
    warnings: result.warnings,
    requires_override: requiresOverride,
  };
}

module.exports = {
  validateInvoiceDate,
  validationError,
  istToday,
  daysBetween,
  financialYear,
  fyLabel,
  toIstDate,
};
