'use strict';

/**
 * Hub Payouts is guarded in three places. They must agree.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * The sidebar, the route guard and the API each carried their own list of
 * permission codes for the same screen, kept in step by hand, and nothing
 * checked. They drifted into three DIFFERENT lists and every one of these was
 * live at the same time:
 *
 *   VIEW_HUB_PAYOUTS        the permission literally named for this screen,
 *                           and it appeared NOWHERE in the frontend. Ticking
 *                           its checkbox in Settings did nothing whatsoever.
 *   VIEW_HUB                sidebar ✓ route ✓ api ✗ — the link showed, the
 *                           page opened, every request on it 403'd.
 *   VIEW_PURCHASE_INVOICE   sidebar ✓ route ✗ — the link showed and clicking
 *                           it was refused by the route guard.
 *   VIEW_PAYMENTS           api ✓ only — allowed to read it, never shown it.
 *
 * None of that leaked data: the API is the real gate and it held throughout.
 * What it produced was DEAD LINKS, which is exactly why it survived so long —
 * a menu item that goes nowhere annoys people without ever producing a stack
 * trace, so nobody files it.
 *
 * ── WHAT IS ASSERTED, AND WHAT IS NOT ───────────────────────────────────────
 *
 * This is a source-parsing test, not a running-app test. It cannot tell you
 * that the page renders. What it CAN do is the thing a human reviewer reliably
 * fails at: notice that three lists in three files, in two languages, have
 * stopped matching. That is the failure that actually happened.
 *
 * The backend list is treated as canonical because it is the one that decides.
 * The other two only control what a person is SHOWN.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const read = (p) => {
  assert.ok(fs.existsSync(p), `${p.replace(path.resolve(BE, '..'), '')} not found`);
  return fs.readFileSync(p, 'utf8');
};

/** Every 'QUOTED_CODE' in a fragment, in order. */
const codesIn = (s) => (s.match(/'[A-Z_]+'/g) || []).map((x) => x.slice(1, -1));

/**
 * The codes inside the FIRST [ … ] after `key`, and nothing after it.
 *
 * Bounded on purpose. Reading to the end of the line swept up `section:
 * 'ACCOUNTING'`, which sits after `permissions:` on the same line — so the
 * sidebar appeared to grant a permission called ACCOUNTING and the comparison
 * failed for a reason that had nothing to do with permissions. Anything in
 * SCREAMING_CASE quotes elsewhere on that line would do the same.
 */
function bracketCodes(line, key) {
  const at = line.indexOf(key);
  assert.ok(at > -1, `\`${key}\` not found in:\n    ${line.trim()}`);
  const open = line.indexOf('[', at);
  const close = line.indexOf(']', open);
  assert.ok(open > -1 && close > open, `no [ … ] after \`${key}\` in:\n    ${line.trim()}`);
  return codesIn(line.slice(open, close));
}

// ── 1. The canonical list: backend canView ──────────────────────────────────

const routesSrc = read(`${BE}/src/routes/hub_payouts.routes.js`);
const canViewAt = routesSrc.indexOf('const canView = requirePermission(');
assert.ok(canViewAt > -1,
  'canView is no longer declared as `const canView = requirePermission(` — this test can no longer find the canonical list'); n++;
const canonical = codesIn(routesSrc.slice(canViewAt, routesSrc.indexOf(';', canViewAt)));

assert.ok(canonical.length >= 2,
  `parsed only ${canonical.length} code(s) from canView — the parse is broken, not the code`); n++;
assert.ok(canonical.includes('VIEW_HUB_PAYOUTS'),
  'VIEW_HUB_PAYOUTS is not in the API list for the Hub Payouts screen'); n++;

// ── 2. The sidebar entry ────────────────────────────────────────────────────

const shellSrc = read(`${FE}/src/components/AppShell.jsx`);
const navLine = shellSrc.split('\n').find((l) => /label:\s*'Hub Payouts'/.test(l));
assert.ok(navLine, "no sidebar entry labelled 'Hub Payouts' — did the nav change shape?"); n++;
const navCodes = bracketCodes(navLine, 'permissions:');

// ── 3. The route guard ──────────────────────────────────────────────────────

const appSrc = read(`${FE}/src/App.jsx`);
const routeLine = appSrc.split('\n').find((l) => /path="\/payouts"/.test(l));
assert.ok(routeLine, 'no <Route path="/payouts"> found — did the router change shape?'); n++;
const guardCodes = bracketCodes(routeLine, 'codes=');

// ── 4. All three must be the same SET ───────────────────────────────────────
//
// Compared as sorted sets, not as literal text: the order a reader finds most
// readable in a JSX prop is not necessarily the order that reads best in an
// Express guard, and forcing them to match character-for-character would make
// this test fire on a cosmetic reordering. What matters is who gets in.

const sorted = (a) => [...new Set(a)].sort();

assert.deepStrictEqual(sorted(navCodes), sorted(canonical),
  'the Hub Payouts SIDEBAR entry and the API disagree.\n'
  + `  sidebar: ${sorted(navCodes).join(', ')}\n`
  + `  api:     ${sorted(canonical).join(', ')}\n`
  + '  A code in the sidebar but not the API is a dead link: the item appears and\n'
  + '  every request behind it 403s. A code in the API but not the sidebar is a\n'
  + '  screen somebody is allowed to read and is never shown.'); n++;

assert.deepStrictEqual(sorted(guardCodes), sorted(canonical),
  'the /payouts ROUTE GUARD and the API disagree.\n'
  + `  route: ${sorted(guardCodes).join(', ')}\n`
  + `  api:   ${sorted(canonical).join(', ')}\n`
  + '  A code in the guard but not the API lets someone open a page that cannot\n'
  + '  load. A code in the API but not the guard blocks someone the API allows.'); n++;

// ── 5. Every code named must actually exist ─────────────────────────────────
//
// A typo'd code is silently a permission nobody has, so the guard becomes
// "deny everyone" — and reads, in review, exactly like a guard that works.

const permsSrc = read(`${BE}/src/utils/permissions.js`);
for (const code of sorted(canonical)) {
  assert.ok(new RegExp(`code:\\s*'${code}'`).test(permsSrc),
    `${code} guards the Hub Payouts screen but is not defined in utils/permissions.js — `
    + 'a permission nobody can hold, so this silently denies everyone'); n++;
}

// ── 6. The write permissions stay narrow ────────────────────────────────────
//
// The wide read list above is deliberate — seeing what has been paid is not
// the authority to pay. These two are the ones that move money, and the point
// of loosening reads is undone if a later edit lets the read codes leak into
// them. MANAGE_HUBS is the specific danger: it is held by people who
// administer hub records, which is not the same as sending funds.

const payAt = routesSrc.indexOf("const canPay = requirePermission(");
assert.ok(payAt > -1, 'canPay is no longer declared where this test expects it'); n++;
const payCodes = codesIn(routesSrc.slice(payAt, routesSrc.indexOf(';', payAt)));
assert.deepStrictEqual(payCodes, ['PAY_HUB_ONLINE'],
  `sending money is guarded by ${payCodes.join(', ')} — it must be PAY_HUB_ONLINE alone`); n++;

const regAt = routesSrc.indexOf('const canRegister = requirePermission(');
assert.ok(regAt > -1, 'canRegister is no longer declared where this test expects it'); n++;
const regCodes = codesIn(routesSrc.slice(regAt, routesSrc.indexOf(';', regAt)));
assert.ok(!regCodes.includes('MANAGE_HUBS'),
  'MANAGE_HUBS can register a hub bank account — that permission is for administering '
  + 'hub records, and the registered account is where every future payout goes'); n++;

for (const wide of ['VIEW_HUB_PAYOUTS', 'VIEW_PURCHASE_INVOICE', 'VIEW_PAYMENTS']) {
  assert.ok(!payCodes.includes(wide) && !regCodes.includes(wide),
    `${wide} is a READ permission and it can now move money`); n++;
}

// ── 7. The parse must be able to fail ───────────────────────────────────────
//
// Every assertion above rests on codesIn(). If it returned [] the set
// comparisons would compare nothing to nothing and pass forever — the standard
// way a source-scanning suite becomes decorative.

assert.deepStrictEqual(codesIn("codes={['A_B','C_D']}"), ['A_B', 'C_D'],
  'the code parser does not extract permission codes'); n++;
assert.deepStrictEqual(codesIn("permissions: ['X']"), ['X']); n++;
// The bound matters: this is the exact shape that broke the first run.
assert.deepStrictEqual(
  bracketCodes("{ label: 'x', permissions: ['A_B','C_D'], section: 'ACCOUNTING' }", 'permissions:'),
  ['A_B', 'C_D'],
  'bracketCodes reads past the closing ] and picks up unrelated quoted words'); n++;
assert.notDeepStrictEqual(sorted(['A']), sorted(['A', 'B']),
  'the set comparison cannot distinguish different lists'); n++;

console.log(`PASS  hub payout permissions aligned across 3 files (${canonical.join(', ')}) — ${n} checks`);
