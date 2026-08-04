'use strict';

// One free-text search implementation for every list screen (estimates,
// purchase invoices, customer invoices). They had three copies of the same
// `col ILIKE '%term%' OR col ILIKE '%term%'` line, which is how the pages
// drifted apart — only Estimates could ever find a document by its number.
//
// What it does that the old line did not:
//
//   1. Document numbers route to the PRIMARY KEY.
//      "CI-000048", "ci48", "#48" → `id = 48`. Invoice numbers in this schema
//      are the row id, so this is an index lookup rather than a table scan —
//      the cheapest query the database can answer, and the one users reach for
//      most often when a customer reads a number off a bill.
//
//   2. Words are AND-ed, not concatenated.
//      "raju swift" used to be matched as one literal string and found nothing.
//      Each word now has to match SOMETHING, but not the same something — so a
//      customer name plus a vehicle works.
//
//   3. Wildcards typed by the user are escaped.
//      A search for "50%" was previously a wildcard that matched every row.
//
// ── On performance ──────────────────────────────────────────────────────────
// The ILIKE patterns keep their leading %, which normally means no index. That
// is deliberate: migration 104 adds pg_trgm GIN indexes, and a trigram index
// DOES serve '%term%'. It needs 3 characters to work with, so 1–2 character
// searches still scan — which is why MIN_SEARCH_LENGTH exists and why the UI
// waits for the second character.

const MIN_SEARCH_LENGTH = 2;

// A cap, not a limit anyone will reach: it stops a pasted paragraph turning
// into a hundred AND-ed ILIKE conditions.
const MAX_TOKENS = 6;

// LIKE treats % and _ as wildcards, so a user typing them means the literal
// character. Backslash is the default LIKE escape in Postgres with
// standard_conforming_strings on (the default since 9.1).
function escapeLike(s) {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

function tokenize(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
}

/**
 * Does this token look like a document number?
 *
 *   "CI-000048" → { n: 48, explicit: true }    prefix given, so id ONLY
 *   "48"        → { n: 48, explicit: false }   ambiguous, so id OR text
 *   "GJ01AB"    → null
 *
 * `explicit` is the important half. Someone who types "CI-48" means invoice 48
 * and nothing else; someone who types "48" might mean invoice 48, or a phone
 * number, or part of a registration — so that case widens rather than narrows.
 */
function parseDocNumber(token, prefixes = []) {
  const m = /^([a-z]*)[-_#\s]*0*(\d{1,9})$/i.exec(token);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const n = Number(m[2]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  // A prefix that isn't ours means this is not a document number at all —
  // "AB12" should look for a registration, not invoice 12.
  if (prefix && !prefixes.includes(prefix)) return null;
  return { n, explicit: !!prefix };
}

/**
 * Build the WHERE fragment for a search box.
 *
 * @param {string}   search       raw user input
 * @param {any[]}    params       the query's parameter array — APPENDED TO
 * @param {string[]} textColumns  qualified columns to match, e.g. ['ci.customer_name']
 * @param {string}   idColumn     qualified pk column, e.g. 'ci.id' (optional)
 * @param {string[]} idPrefixes   accepted number prefixes, e.g. ['ci','inv']
 *
 * @returns {string|null} SQL to AND into the WHERE clause, or null for "no
 *                        search" — the caller must treat null as "add nothing",
 *                        never as "match nothing".
 *
 * Columns are interpolated directly, so they must be developer-authored
 * literals and never anything derived from a request. Only the VALUES are
 * parameterised. Every call site in this repo passes a hard-coded array.
 */
function buildSearchSql({ search, params, textColumns = [], idColumn = null, idPrefixes = [] }) {
  const raw = String(search || '').trim();
  if (raw.length < MIN_SEARCH_LENGTH) return null;

  // Try the WHOLE input as a document number before splitting on whitespace.
  // People type "CI 48" as readily as "CI-48", and tokenizing first would tear
  // the prefix off its number and turn an exact lookup into a text search for
  // "%CI%" AND "%48%" — which matches almost nothing.
  if (idColumn) {
    const whole = parseDocNumber(raw, idPrefixes);
    if (whole && whole.explicit) {
      params.push(whole.n);
      return `(${idColumn} = $${params.length})`;
    }
  }

  const tokens = tokenize(raw);
  if (!tokens.length) return null;

  const perToken = [];

  for (const token of tokens) {
    const ors = [];
    const doc = idColumn ? parseDocNumber(token, idPrefixes) : null;

    if (doc) {
      params.push(doc.n);
      ors.push(`${idColumn} = $${params.length}`);
      // "CI-48" is unambiguous — stop here rather than also dragging in every
      // row with "48" somewhere in a phone number.
      if (doc.explicit) { perToken.push(`(${ors.join(' OR ')})`); continue; }
    }

    if (!textColumns.length) {
      if (!ors.length) continue;
      perToken.push(`(${ors.join(' OR ')})`);
      continue;
    }

    params.push(`%${escapeLike(token)}%`);
    const n = params.length;
    for (const col of textColumns) ors.push(`${col} ILIKE $${n}`);
    perToken.push(`(${ors.join(' OR ')})`);
  }

  return perToken.length ? perToken.join(' AND ') : null;
}

module.exports = {
  buildSearchSql,
  parseDocNumber,
  escapeLike,
  tokenize,
  MIN_SEARCH_LENGTH,
  MAX_TOKENS,
};
