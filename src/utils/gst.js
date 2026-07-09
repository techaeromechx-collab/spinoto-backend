'use strict';

/**
 * GSTIN (Indian GST Identification Number) validation.
 *
 * Format — 15 characters:
 *   [0-1]   2-digit state code
 *   [2-11]  10-char PAN (5 letters, 4 digits, 1 letter)
 *   [12]    entity number for this PAN in this state (1-9 or A-Z)
 *   [13]    fixed literal 'Z'
 *   [14]    checksum character
 */

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Value map used by the checksum algorithm: 0-9 → 0-9, A-Z → 10-35.
const CODE_POINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function charValue(ch) {
  return CODE_POINTS.indexOf(ch);
}

// Computes the expected 15th (check) character for a 14-char GSTIN prefix
// using the standard mod-36 checksum algorithm.
function computeCheckDigit(gstin14) {
  const factor = 2;
  let sum = 0;
  for (let i = 0; i < gstin14.length; i++) {
    const value = charValue(gstin14[i]);
    // Alternate multiplier of 1/2 per character, starting at index 0 with 2.
    const mult = (i % 2 === 0) ? factor : 1;
    let product = value * mult;
    // Fold values >= 36 back down (sum of quotient + remainder).
    product = Math.floor(product / 36) + (product % 36);
    sum += product;
  }
  const checkValue = (36 - (sum % 36)) % 36;
  return CODE_POINTS[checkValue];
}

/**
 * Returns true if `str` is a structurally + checksum-valid GSTIN.
 * Case-sensitive — callers should uppercase/trim user input first.
 */
function isValidGSTIN(str) {
  if (typeof str !== 'string') return false;
  const gstin = str.trim().toUpperCase();
  if (!GSTIN_FORMAT.test(gstin)) return false;
  const expected = computeCheckDigit(gstin.slice(0, 14));
  return expected === gstin[14];
}

module.exports = { isValidGSTIN, GSTIN_FORMAT };
