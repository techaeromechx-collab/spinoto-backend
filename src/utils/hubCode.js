'use strict';

// Strips everything except A-Z out of a string, uppercased. Used so hub
// names with punctuation ("(Spinoto)", "V care-Thaltej", "_2W(Tragad)")
// contribute real letters to the code instead of symbols — see bug note
// below.
function lettersOnly(str) {
  return String(str || '').toUpperCase().replace(/[^A-Z]/g, '');
}

// Generates a short, human-readable code from a hub name — e.g. "QuickFix
// Auto Hub" -> "QAH". Rule: first letter of each word, up to the first 3
// words. If that's fewer than 3 characters (1 or 2 word names), pad by
// continuing to pull consecutive letters from the last word so codes stay a
// consistent ~3 characters:
//
//   "QuickFix Auto Hub"        -> Q, A, H              -> "QAH"
//   "UrbanMoto Service Center" -> U, S, C               -> "USC"
//   "SpeedCare Garage"         -> S, G, +1 from "Garage" -> "SGA"
//   "SpeedCare" (one word)     -> S, +2 from "SpeedCare" -> "SPE"
//
// A "word" here means a whitespace-separated token with the punctuation
// stripped out first — "(Spinoto)" contributes "S" (from SPINOTO), not "("
// (its literal first character). Bug found 2026-07-10: the original version
// used word[0] directly, so hub names like "Kaarwash_24_Gota (Spinoto)"
// produced codes like "K(S" instead of "KSP". Tokens with no letters at all
// (pure numbers/punctuation) are skipped entirely rather than contributing
// nothing useful.
//
// Pure function — knows nothing about other hubs. Collision resolution
// (appending a digit if a code is already taken) is resolveUniqueCode()
// below, applied by the caller against whatever codes already exist.
function baseHubCode(hubName) {
  const words = String(hubName || '').trim().split(/\s+/).filter(Boolean);
  const letterWords = words.map(lettersOnly).filter(w => w.length > 0);
  if (letterWords.length === 0) return 'HUB';

  let code = letterWords.slice(0, 3).map(w => w[0]).join('');

  if (code.length < 3) {
    const lastWord = letterWords[letterWords.length - 1];
    let i = 1; // skip index 0 — that letter is already in `code`
    while (code.length < 3 && i < lastWord.length) {
      code += lastWord[i];
      i++;
    }
  }

  return code || 'HUB';
}

// Returns a guaranteed-unique code given a base code and a Set of codes
// already in use — appends 2, 3, 4... until it finds one that's free.
function resolveUniqueCode(base, existingCodes) {
  if (!existingCodes.has(base)) return base;
  let n = 2;
  while (existingCodes.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

module.exports = { baseHubCode, resolveUniqueCode };
