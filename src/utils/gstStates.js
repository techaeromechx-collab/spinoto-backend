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

module.exports = {
  STATE_CODES,
  stateCodeFromGstin,
  stateCodeFromName,
  stateName,
  supplierStateCode,
  resolvePlaceOfSupply,
  isInterState,
  splitGst,
};
