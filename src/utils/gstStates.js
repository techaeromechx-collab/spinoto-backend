'use strict';

/**
 * Indian GST state codes and intra- vs inter-state resolution.
 *
 * Under GST, the tax split depends on whether the supply is intra-state or
 * inter-state:
 *   - intra-state (supplier's state === place of supply) → CGST + SGST,
 *     each at half the rate
 *   - inter-state (different states)                     → IGST at the full rate
 *
 * Before this module the codebase always printed CGST + SGST with no
 * interstate check at all, which silently produced a non-compliant invoice for
 * any out-of-state customer.
 *
 * The first two digits of a GSTIN are the state code, so for any registered
 * party the state is derivable from the GSTIN itself with no extra data entry.
 */

// Official GST state/UT codes. 'Other Territory' (97) and 'Other Country' (96)
// are included because they appear on real GSTINs (SEZ / foreign-facing).
const STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '96': 'Other Country',
  '97': 'Other Territory',
};

// Reverse lookup, normalised, so a free-text state name from company_settings
// ("gujarat", "GUJARAT ", "Gujrat") can still resolve to a code.
const NAME_TO_CODE = {};
for (const [code, name] of Object.entries(STATE_CODES)) {
  NAME_TO_CODE[normaliseName(name)] = code;
}
// Common spellings/aliases people actually type.
const ALIASES = {
  'gujrat': '24',
  'orissa': '21',
  'pondicherry': '34',
  'uttaranchal': '05',
  'newdelhi': '07',
  'delhincr': '07',
  'tamilnad': '33',
  'jammukashmir': '01',
  'andamannicobar': '35',
  'dadranagarhaveli': '26',
  'damandiu': '26',
};
Object.assign(NAME_TO_CODE, ALIASES);

function normaliseName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** State code from a GSTIN's first two digits, or null if not derivable. */
function stateCodeFromGstin(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  if (g.length < 2) return null;
  const code = g.slice(0, 2);
  return STATE_CODES[code] ? code : null;
}

/** State code from a free-text state name, or null. */
function stateCodeFromName(name) {
  if (!name) return null;
  return NAME_TO_CODE[normaliseName(name)] || null;
}

function stateName(code) {
  return STATE_CODES[String(code || '').padStart(2, '0')] || '';
}

/**
 * Resolve the supplier's own state — GSTIN first (authoritative, it's what the
 * tax office sees), falling back to the free-text state name in company
 * settings for a company that hasn't entered a GSTIN yet.
 */
function supplierStateCode(company) {
  return stateCodeFromGstin(company?.gstin) || stateCodeFromName(company?.state) || null;
}

/**
 * Resolve the place of supply for a document, in priority order:
 *   1. An explicitly stored place_of_supply_code on the row (user override)
 *   2. The B2B customer's GSTIN state code — for a registered recipient the
 *      place of supply is their location
 *   3. The supplier's own state — an unregistered walk-in customer at the
 *      workshop is an intra-state supply, which is the common case here
 *
 * Returns { code, name, source } so the caller can tell a real determination
 * from a fallback (useful when deciding whether to warn the user).
 */
function resolvePlaceOfSupply(row, company) {
  const explicit = row?.place_of_supply_code;
  if (explicit && STATE_CODES[String(explicit)]) {
    return { code: String(explicit), name: stateName(explicit), source: 'explicit' };
  }

  if (row?.is_b2b && row?.b2b_gst_number) {
    const c = stateCodeFromGstin(row.b2b_gst_number);
    if (c) return { code: c, name: stateName(c), source: 'b2b_gstin' };
  }

  const own = supplierStateCode(company);
  if (own) return { code: own, name: stateName(own), source: 'supplier_default' };

  return { code: null, name: '', source: 'unknown' };
}

/**
 * Is this an inter-state supply (→ IGST)?
 *
 * Defaults to FALSE when either side is unknown. That's deliberate: CGST/SGST
 * is what this codebase has always produced and what's correct for the
 * overwhelming majority of a local workshop's business, so an unresolved state
 * should not silently flip every invoice to IGST.
 */
function isInterState(company, placeOfSupplyCode) {
  const own = supplierStateCode(company);
  if (!own || !placeOfSupplyCode) return false;
  return String(own) !== String(placeOfSupplyCode);
}

/**
 * Split a GST amount into the lines that should print.
 *
 * Returns [{ key, label, percent, amount }] — one IGST line, or a CGST and an
 * SGST line. The odd-paise remainder goes to CGST (matching the existing
 * frontend behaviour, so historical invoices keep splitting the same way).
 */
function splitGst(amount, ratePercent, interState) {
  const amt = Number(amount || 0);
  const rate = Number(ratePercent || 0);
  if (interState) {
    return [{ key: 'igst', label: 'IGST', percent: rate, amount: amt }];
  }
  const half = Math.ceil(amt * 100 / 2) / 100;
  return [
    { key: 'cgst', label: 'CGST', percent: rate / 2, amount: half },
    { key: 'sgst', label: 'SGST', percent: rate / 2, amount: Number((amt - half).toFixed(2)) },
  ];
}


// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE INVOICES — the supplier is the HUB, not the company
//
// Everything above assumes Spinoto is the supplier, which is true for an
// estimate and a customer invoice. A purchase invoice is the other direction:
// the hub supplies the work and Spinoto buys it, so that document is legally
// the HUB's sales invoice.
//
// Using the functions above on a purchase invoice put Spinoto's state on BOTH
// sides of the intra/inter-state comparison, so every hub's invoice printed
// CGST+SGST. A Maharashtra hub billing a Gujarat company owes IGST. The rupee
// total was right; it sat under the wrong heads, and that propagates into the
// hub's GSTR-1.
//
// These live here rather than as a branch inside documentAdapter so that every
// state decision in the codebase stays in one file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The supplier's state on a purchase invoice — the hub's.
 *
 * Priority mirrors supplierStateCode():
 *   1. supplier_state_code snapshotted on the row (migration 120) — frozen at
 *      issue, so correcting a hub's GSTIN never rewrites an old invoice
 *   2. the leading two digits of the hub's GSTIN, which IS the registered state
 *   3. the hub's state name, for a hub with no GSTIN
 *
 * Returns null when nothing resolves. Callers must treat null as "cannot
 * determine" and fall back to intra-state rather than guessing IGST — an
 * unregistered hub charges no tax at all, so the distinction is moot there.
 */
function hubSupplierStateCode(row) {
  const snapshot = row?.supplier_state_code;
  if (snapshot && STATE_CODES[String(snapshot).padStart(2, '0')]) {
    return String(snapshot).padStart(2, '0');
  }
  return stateCodeFromGstin(row?.hub_gstin || row?.hub_gst)
      || stateCodeFromName(row?.hub_state_name)
      || null;
}

/**
 * Place of supply on a purchase invoice — Spinoto's state, because Spinoto is
 * the recipient. A B2B supply to a registered recipient is supplied at the
 * recipient's location.
 *
 * The end customer's state is irrelevant here and must never leak in: that
 * governs the CUSTOMER invoice, a different document between different parties.
 */
function resolvePurchasePlaceOfSupply(row, company) {
  const explicit = row?.place_of_supply_code;
  if (explicit && STATE_CODES[String(explicit).padStart(2, '0')]) {
    const c = String(explicit).padStart(2, '0');
    return { code: c, name: stateName(c), source: 'explicit' };
  }
  const own = supplierStateCode(company); // the company is the RECIPIENT here
  if (own) return { code: own, name: stateName(own), source: 'recipient_company' };
  return { code: null, name: '', source: 'unknown' };
}

/**
 * Inter-state on a purchase invoice: hub's state vs Spinoto's state.
 *
 * Returns false when either side is unknown — the same conservative default as
 * isInterState(). Printing IGST on an unresolved supply would be a worse error
 * than printing CGST+SGST, because IGST on an intra-state supply is not
 * creditable to the recipient.
 */
function isPurchaseInterState(row, company) {
  const supplier = hubSupplierStateCode(row);
  const recipient = resolvePurchasePlaceOfSupply(row, company).code;
  if (!supplier || !recipient) return false;
  return String(supplier) !== String(recipient);
}

module.exports = {
  STATE_CODES,
  stateCodeFromGstin,
  stateCodeFromName,
  stateName,
  supplierStateCode,
  resolvePlaceOfSupply,
  isInterState,
  splitGst,
  // Purchase-invoice variants — supplier is the hub, recipient is the company.
  hubSupplierStateCode,
  resolvePurchasePlaceOfSupply,
  isPurchaseInterState,
};
