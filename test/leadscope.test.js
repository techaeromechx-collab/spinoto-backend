'use strict';

/**
 * Who can see which lead.
 *
 * ── THE RULE THIS PINS ──────────────────────────────────────────────────────
 *
 * An unassigned WhatsApp lead is visible to Super Admin and VIEW_LEAD only.
 * Nobody else — not the advisor who would have worked it, not their manager.
 *
 * That is a deliberate operational choice and it reverses what the code used to
 * do. A clause was concatenated into the two lower scopes making every
 * unassigned WhatsApp lead visible to EVERY advisor: a shared queue anyone
 * could pick from. Correct for an install where routing assigns automatically
 * and the unassigned pile is a handful of leftovers. Wrong for this one, where
 * assignment is done by a manager on purpose — "unassigned" means "not yet
 * allocated", which is an in-tray rather than a free-for-all.
 *
 * ── WHY A TEST AND NOT JUST A DELETION ──────────────────────────────────────
 *
 * The clause lived in FOUR queries: the lead list, the export, the stage stats
 * behind the board, and the duplicate-number check. Putting it back in one of
 * them is a two-line change that looks local and is not — an advisor would see
 * a lead in their duplicate warning that they cannot open, or export rows the
 * list never showed them. Nothing errors. Nobody notices for months.
 *
 * The reverse mistake is worse and is pinned harder: an advisor MUST still see
 * a lead assigned TO them. Lose that and handing somebody a lead stops working,
 * which is the entire workflow this change assumes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const src = strip(read(path.join(BE, 'src/controllers/leads.controller.js')));

// ── The shared queue is gone, and cannot come back quietly ─────────────────
assert.ok(!/SHARED_SQL/.test(src),
  'the shared WhatsApp queue clause is back — every advisor can see every unassigned '
  + 'WhatsApp lead again'); n++;

/* Spelled out inline rather than via the constant is the same mistake wearing a
   different hat, and the more likely one: somebody pastes the condition into
   the query they are looking at instead of reintroducing a named export. */
assert.ok(!/lead_source[^\n]{0,60}whatsapp[^\n]{0,80}assigned_to IS NULL/i.test(src),
  'the shared-queue condition has been written out inline in a scope filter'); n++;

// ── Super Admin and VIEW_LEAD are filtered by NOTHING ──────────────────────
//
// If a condition ever gets attached to them, "view all leads" silently stops
// meaning all.
/* There is now ONE implementation, not three copies.
   The list, the export and the single-lead read all call scopeConditions, and
   checkMobile shares its team lookup. Counting inline copies used to be the
   only way to check they agreed; the honest check now is that the shared helper
   is right and that nobody has gone back to writing their own. */
assert.match(src, /function scopeConditions\(user, teamIds, params\)/,
  'the shared scope helper is gone; the rule is being written per handler again'); n++;

const iScope  = src.indexOf('function scopeConditions(user, teamIds, params)');
const scopeFn = src.slice(iScope, src.indexOf('\n}', iScope));
assert.match(scopeFn, /user\.is_super_admin \|\| user\.permissions\.has\('VIEW_LEAD'\)/,
  'scopeConditions no longer lets Super Admin and VIEW_LEAD through unfiltered'); n++;
assert.match(scopeFn, /return \[\];/,
  'the full-access branch does not return an EMPTY condition list — a filter of any kind '
  + 'means "view all leads" has silently stopped meaning all'); n++;

/* And the team lookup exists once.
   There were four copies and they HAD drifted — one built its array as
   [self, ...team] and another as [...team, self]. Harmless in itself, and
   exactly how a difference that is not harmless arrives unnoticed. */
const lookups = (src.match(/SELECT id FROM users WHERE manager_id = \$1/g) || []).length;
assert.strictEqual(lookups, 1,
  `${lookups} copies of the team lookup; there should be one`); n++;

// An advisor MUST still see a lead assigned to them. This is the half of the
// rule that makes manual assignment work at all.
/* The own-lead scope must include assigned_to. This is the half of the rule
   that makes handing somebody a lead work at all — lose it and an advisor
   cannot see the lead they were just given. */
assert.match(scopeFn, /l\.created_by = \$\{me\} OR l\.assigned_to = \$\{me\}/,
  'the own-lead scope no longer checks assigned_to — an advisor who is GIVEN a lead '
  + 'would not be able to see it, which breaks the entire workflow'); n++;

// The duplicate-number check uses the same rule, built differently. Its own
// assertion because it is the one that reads as cosmetic and is not: a
// duplicate warning naming a lead the advisor cannot open is worse than no
// warning, since the only next step is to ask somebody.
const iDup = src.indexOf('canViewSql');
assert.ok(iDup > -1, 'the duplicate-lead visibility check is gone'); n++;
const dupBlock = src.slice(iDup, iDup + 800);
assert.match(dupBlock, /l\.assigned_to/,
  'the duplicate check no longer lets an advisor see their own assigned leads'); n++;
assert.ok(!/whatsapp/i.test(dupBlock),
  'the duplicate check still has the shared WhatsApp clause'); n++;
// NULL is not FALSE. assigned_to = 1 against NULL is NULL, and 'false OR NULL'
// is NULL — harmless in a WHERE, wrong in a returned boolean.
assert.match(src, /COALESCE\(\$\{canViewSql\}, FALSE\)/,
  'can_view can return NULL instead of false, so the frontend renders a View button that 403s'); n++;

// ── Four queries, one rule ─────────────────────────────────────────────────
//
// Counted, because the failure mode is fixing three and missing one.
assert.match(scopeFn, /l\.created_by = ANY\(/,
  'the team scope no longer restricts by creator'); n++;

/* Every handler that scopes goes through the helper, or shares its lookup.
   checkMobile is the one exception and it is a real one: it needs the predicate
   as an expression in the SELECT list with hand-computed placeholder numbers,
   not appended to a params array. It shares teamIdsIfNeeded even so — that was
   the part that had drifted between the old copies. */
const viaHelper = (src.match(/scopeConditions\(user, /g) || []).length;
assert.ok(viaHelper >= 3,
  `only ${viaHelper} call sites use the shared scope helper; the list, the export and the `
  + 'single-lead read should all go through it'); n++;

// ── The reports page must not leak them either ─────────────────────────────
//
// It never used the shared clause — it scopes on created_by/assigned_to, and an
// auto-created unassigned lead matches neither. Asserted anyway: it counts
// UNASSIGNED leads specifically, so it is the one place where dropping the
// scope would expose exactly the rows this change is hiding.
const reports = strip(read(path.join(BE, 'src/controllers/reports.controller.js')));
const iUn = reports.indexOf('l.assigned_to IS NULL');
assert.ok(iUn > -1, 'the unassigned-leads count is gone from reports'); n++;
/* Bounded to the END OF THIS QUERY, not a fixed number of characters. A 300
   char window runs past the closing backtick into the NEXT query, which is
   scoped — so deleting the scope from this one still found an `isAll` and
   passed. The template literal's own terminator is the honest boundary. */
const unQuery = reports.slice(iUn, reports.indexOf('`', iUn));
assert.match(unQuery, /isAll \?/,
  'the unassigned-leads count is no longer scoped by viewer — every user would see the '
  + 'manager-only pile in their own dashboard total'); n++;

console.log(`leadscope: ${n} checks passed`);
