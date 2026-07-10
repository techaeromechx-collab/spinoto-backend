'use strict';

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
// Pure function — knows nothing about other hubs. Collision resolution
// (appending a digit if a code is already taken) is resolveUniqueCode()
// below, applied by the caller against whatever codes already exist.
function baseHubCode(hubName) {
  const words = String(hubName || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'HUB';

  let code = words.slice(0, 3).map(w => w[0].toUpperCase()).join('');

  if (code.length < 3) {
    const lastWord = words[words.length - 1].toUpperCase();
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
