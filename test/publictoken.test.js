'use strict';

/**
 * public_token — every row gets one, and a missing one never becomes a URL.
 *
 * ── THE BUG THIS LOCKS DOWN ─────────────────────────────────────────────────
 *
 * A lead with public_token = NULL produced the URL /leads/null, because a
 * template literal stringifies null to the four characters "null". That string
 * is truthy, so the `if (!token)` guard in the page's resolver did not catch
 * it, and the app asked the API for a lead whose token is literally "null" —
 * a 404 on every click, "null" in the breadcrumb, and a record that could not
 * be shared or reopened by refreshing.
 *
 * It hid for a long time because the record still OPENED: the numeric id
 * travels separately from the token. Only the URL was broken, which reads as a
 * cosmetic glitch rather than a dead route.
 *
 * Two sources of null tokens, and this suite pins both shut:
 *
 *   1. controllers/import.controller.js — the Bulk Upload INSERT listed 16
 *      columns and public_token was not one of them. Part 1 below.
 *   2. migration 085 added the column and never backfilled. Migration 165
 *      repairs that; part 3 checks 165 is present and says what it must.
 *
 * Part 2 checks the frontend guards, because the data fix alone is not enough:
 * the next INSERT that forgets a token would reintroduce the broken URL, and
 * URLs already bookmarked as /leads/null must stop 404ing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

/** Comments legitimately discuss public_token; the rules here are about CODE. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — every INSERT INTO a token-bearing table supplies a token
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN_TABLES = [
  'leads', 'appointments', 'estimates', 'purchase_invoices', 'customer_invoices',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const offenders = [];
let insertsChecked = 0;

for (const file of walk(`${BE}/src`)) {
  const code = strip(fs.readFileSync(file, 'utf8'));
  for (const table of TOKEN_TABLES) {
    const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'g');
    let m;
    while ((m = re.exec(code))) {
      insertsChecked++;
      // The column list runs from the INSERT to the VALUES/SELECT that follows.
      // Bounded rather than open-ended: a later unrelated statement in the same
      // file mentioning public_token must not make this pass.
      const after = code.slice(m.index, m.index + 900);
      const head = after.split(/\bVALUES\b|\bSELECT\b/i)[0];
      if (!/public_token/.test(head)) {
        const line = code.slice(0, m.index).split('\n').length;
        offenders.push(`${file.replace(BE, '')}:${line} INSERT INTO ${table} without public_token`);
      }
    }
  }
}

assert.ok(insertsChecked >= 8,
  `only found ${insertsChecked} INSERTs across ${TOKEN_TABLES.length} tables — the scan is broken, not the code`); n++;
assert.deepStrictEqual(offenders, [],
  `these INSERTs would create a row with a null public_token, which becomes the URL /x/null:\n${offenders.join('\n')}`); n++;

// The scan must be capable of failing. Without this, a regex that matches
// nothing would report a clean bill of health forever — the exact trap a
// source-scanning assertion falls into.
const fakeMiss = 'INSERT INTO leads (name, mobile) VALUES ($1, $2)';
assert.ok(!/public_token/.test(fakeMiss.split(/\bVALUES\b/i)[0]),
  'the detection logic cannot recognise a missing public_token'); n++;

// And the import path specifically — the one that was broken — uses the SHARED
// generator rather than rolling its own. A second implementation could drift in
// length or alphabet, and the column's whole job is to be indistinguishable
// regardless of which code path created the row.
const importSrc = fs.readFileSync(`${BE}/src/controllers/import.controller.js`, 'utf8');
assert.ok(/require\(['"]\.\.\/utils\/publicToken['"]\)/.test(importSrc),
  'import.controller.js does not import the shared token generator'); n++;
assert.ok(/generatePublicToken\(\)/.test(strip(importSrc)),
  'import.controller.js imports the generator but never calls it'); n++;

// A batch insert must generate one token PER ROW. Hoisting the call out of the
// per-row loop would violate the unique index on the second row of the very
// first import — and the error would name the index, not the cause.
// The end marker must be searched for AFTER the loop starts. There is an
// earlier `RETURNING id` in this file, and slicing to it produces a BACKWARDS
// range — an empty string, in which nothing is found, so the assertion fails
// for a reason that has nothing to do with the code. (It did exactly that on
// the first run. Left documented rather than quietly corrected, because a
// source-scanning test whose range silently inverts is worse than no test.)
const loopAt = importSrc.indexOf('for (const batch of chunk(toInsert');
assert.ok(loopAt > -1, 'the batch-insert loop was not found — import.controller.js changed shape'); n++;
const endAt = importSrc.indexOf('RETURNING id', loopAt);
assert.ok(endAt > loopAt, 'no RETURNING id after the batch loop'); n++;
const batchBody = importSrc.slice(loopAt, endAt);
const forEachAt = batchBody.indexOf('batch.forEach');
const genAt = batchBody.indexOf('generatePublicToken()');
assert.ok(forEachAt > -1, 'the per-row forEach was not found inside the batch loop'); n++;
assert.ok(genAt > forEachAt,
  'generatePublicToken() is called outside the per-row loop — every row in a batch would share one token'); n++;

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — the frontend never routes to a token it does not have
// ═══════════════════════════════════════════════════════════════════════════

const PAGES = [
  ['LeadsPage.jsx', 'leads'],
  ['AppointmentsPage.jsx', 'appointments'],
  ['EstimatesPage.jsx', 'estimates'],
  ['CustomerInvoicesPage.jsx', 'customer-invoices'],
  ['PurchaseInvoicesPage.jsx', 'purchase-invoices'],
];

for (const [page] of PAGES) {
  const p = `${FE}/src/pages/${page}`;
  if (!fs.existsSync(p)) { assert.fail(`${page} not found`); }
  const code = strip(fs.readFileSync(p, 'utf8'));

  // (a) Every navigate() that interpolates a public_token sits behind a
  //     truthiness check on that token.
  //
  //     The guard may be on the same line (`if (x.public_token) navigate(…)`)
  //     or open an enclosing block a few lines above — both shapes are already
  //     in this codebase and both are correct, so the window is four lines
  //     rather than one. Checking only the same line rejected two call sites
  //     that were properly guarded by an enclosing `if`.
  const lines = code.split('\n');
  const navAt = lines
    .map((l, i) => [l, i])
    .filter(([l]) => /navigate\(`[^`]*\$\{[^}]*public_token\}[^`]*`\)/.test(l));
  assert.ok(navAt.length > 0, `${page}: no token navigation found — did the page change shape?`); n++;
  for (const [line, i] of navAt) {
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    assert.ok(/if\s*\([^)]*public_token/.test(window),
      `${page}: unguarded token navigation — a null token becomes the URL "/x/null":\n    ${line.trim()}`); n++;
  }

  // (b) The by-token resolver treats the literal strings "null" and
  //     "undefined" as no token. Without this, a URL already bookmarked as
  //     /leads/null keeps 404ing forever, guard or no guard.
  assert.ok(/token !== 'null'/.test(code) && /token !== 'undefined'/.test(code),
    `${page}: the by-token resolver still accepts the literal string "null"`); n++;

  // (c) …and the fetch actually uses the sanitised value. Computing `real` and
  //     then fetching `${token}` anyway is the obvious way to half-fix this.
  assert.ok(!/by-token\/\$\{token\}/.test(code),
    `${page}: computes a sanitised token but still fetches with the raw one`); n++;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — the backfill migration exists and repairs every affected table
// ═══════════════════════════════════════════════════════════════════════════

const MIG = `${BE}/db/migrations/165_backfill_public_tokens.sql`;
assert.ok(fs.existsSync(MIG), 'migration 165 (public_token backfill) is missing'); n++;
const sql = fs.readFileSync(MIG, 'utf8');
// The prohibitions below are about SQL that RUNS. This migration's header
// explains at length why it does not use CREATE EXTENSION or a DEFAULT —
// matching that prose would fail the file for saying why it is correct.
const sqlCode = sql.replace(/^\s*--.*$/gm, '');

// Checked against the BACKFILL block specifically, not the whole file.
//
// The file names the five tables twice: once in the block that writes tokens,
// and again in the block that verifies none are left null. Searching the whole
// file let a table be dropped from the backfill list and still pass, because
// the verification list still mentioned it — caught by mutation-testing this
// suite, which is the only way that kind of false pass ever surfaces.
//
// (Dropping one is not silent in production: the verify block would RAISE at
// migration time. But a test that claims to check the backfill list must
// actually check the backfill list.)
const blocks = sqlCode.split(/DO \$\$/).slice(1);
assert.ok(blocks.length >= 2,
  'migration 165 no longer has the two DO blocks this test reasons about'); n++;
const backfillBlock = blocks[0];
assert.ok(/UPDATE %I SET public_token/.test(backfillBlock),
  'the first DO block is not the one that writes tokens — the blocks were reordered'); n++;
const verifyBlock = blocks[1];
assert.ok(/RAISE EXCEPTION/.test(verifyBlock),
  'the second DO block does not fail on leftover nulls'); n++;

for (const table of TOKEN_TABLES) {
  assert.ok(new RegExp(`'${table}'`).test(backfillBlock),
    `migration 165 does not BACKFILL ${table} — 085 added the column to all five`); n++;
  assert.ok(new RegExp(`'${table}'`).test(verifyBlock),
    `migration 165 does not VERIFY ${table} is free of nulls`); n++;
}

// The token it writes must match utils/publicToken.js in SHAPE, or backfilled
// rows are distinguishable from application-generated ones and the column stops
// being opaque. publicToken.js is randomBytes(10).toString('base64url') → 14
// chars, base64url alphabet, no padding.
assert.ok(/FOR 10\b/.test(sqlCode), 'migration 165 does not take 10 bytes — the token length would differ'); n++;
assert.ok(/translate\(/.test(sqlCode) && /'\+\/=', '-_'/.test(sqlCode),
  'migration 165 does not convert base64 to base64url — tokens would contain + / = '); n++;

// gen_random_uuid() is core from PG13. pgcrypto's gen_random_bytes() would be
// the more natural call and needs CREATE EXTENSION, which is a permission
// problem on a managed database — at migration time, in production.
assert.ok(/gen_random_uuid\(\)/.test(sqlCode), 'migration 165 does not use the core UUID generator'); n++;
assert.ok(!/CREATE EXTENSION/i.test(sqlCode),
  'migration 165 requires an extension — this repo has never needed one and a managed DB may refuse'); n++;

// It must fail loudly rather than reporting success with rows still null.
assert.ok(/RAISE EXCEPTION/.test(sqlCode),
  'migration 165 cannot fail — a partial backfill would report success'); n++;
assert.ok(/unique_violation/.test(sqlCode),
  'migration 165 does not handle a token collision; a single collision would abort the whole migration'); n++;

// A DEFAULT would silently paper over the next caller that forgets a token —
// which is exactly the bug being cleaned up here.
assert.ok(!/SET\s+DEFAULT/i.test(sqlCode),
  'migration 165 sets a column DEFAULT — that would hide the next forgotten token instead of surfacing it'); n++;

console.log(`PASS  public_token integrity (${insertsChecked} INSERTs, ${PAGES.length} pages, migration 165) — ${n} checks`);
