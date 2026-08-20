/**
 * Every reference to invoice_payment_lines names a column the view actually has.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The invoice screen went down with
 *
 *     error: column cip.id does not exist
 *
 * because _getPayments was switched from customer_invoice_payments to the view
 * in one word — the table name — and the view has no `id`. It has allocation_id
 * and payment_id, deliberately, since `id` would be ambiguous between the line
 * and the payment behind it.
 *
 * Nothing caught it. The source suites assert on text, and the text was fine.
 * The postgres suites build their own schemas and never ran this query. It took
 * a user opening an invoice.
 *
 * That is the whole class of bug this file closes: a query that reads the view
 * under a column name it does not have. It needs no database — the view's column
 * list is a fact stated in the migrations, and the references are a fact stated
 * in the source. The check is exact in both directions:
 *
 *   • a column that does not exist fails here, at test time;
 *   • adding a column to the view, or renaming one, updates this automatically,
 *     because the list is parsed rather than written down twice.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const MIG = path.join(BE, 'db/migrations');
const SRC = path.join(BE, 'src');
let n = 0;

// ── What the view actually has, taken from the last migration that defines it ─
const defs = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()
  .filter(f => /CREATE OR REPLACE VIEW invoice_payment_lines/i
    .test(fs.readFileSync(path.join(MIG, f), 'utf8')));
assert.ok(defs.length, 'no migration defines invoice_payment_lines'); n++;

const lastDef = fs.readFileSync(path.join(MIG, defs[defs.length - 1]), 'utf8')
  .replace(/--[^\n]*/g, '');
const selectList = lastDef.slice(
  lastDef.search(/CREATE OR REPLACE VIEW invoice_payment_lines AS\s+SELECT/i),
).replace(/^[\s\S]*?SELECT/i, '');
const fromAt = selectList.search(/\bFROM\b/i);

const COLUMNS = new Set(
  selectList.slice(0, fromAt).split(',').map(part => {
    const t = part.trim();
    const as = /\bAS\s+([a-z_][\w]*)\s*$/i.exec(t);
    if (as) return as[1];
    const dotted = /([a-z_][\w]*)\s*$/i.exec(t.split('.').pop() || '');
    return dotted ? dotted[1] : null;
  }).filter(Boolean),
);
assert.ok(COLUMNS.has('payment_id') && COLUMNS.has('allocation_id'),
  'the view no longer names the allocation and the payment apart'); n++;
assert.ok(!COLUMNS.has('id'),
  'the view now has a bare `id` — which of the two is it?'); n++;

// ── Every reference in the source ────────────────────────────────────────────
const KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'as', 'on', 'join', 'left', 'inner',
  'group', 'order', 'by', 'limit', 'having', 'asc', 'desc', 'not', 'null', 'is',
  'in', 'any', 'all', 'case', 'when', 'then', 'else', 'end', 'int', 'text',
  'numeric', 'date', 'union', 'distinct', 'lateral', 'true', 'false', 'exists',
  'max', 'min', 'sum', 'count', 'coalesce', 'avg', 'greatest', 'least', 'nullif',
]);

/** The smallest balanced-paren group containing `at`, or the whole query. */
function enclosingParens(q, at) {
  let depth = 0, open = -1;
  for (let i = at; i >= 0; i--) {
    if (q[i] === ')') depth++;
    else if (q[i] === '(') { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open < 0) return q;
  depth = 0;
  for (let i = open; i < q.length; i++) {
    if (q[i] === '(') depth++;
    else if (q[i] === ')' && --depth === 0) return q.slice(open, i + 1);
  }
  return q.slice(open);
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? jsFiles(path.join(dir, e.name))
      : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

const problems = [];
let sites = 0;

for (const file of jsFiles(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  // Each backtick-delimited literal is one query. Splitting on the delimiter
  // keeps an alias bound to the query it was declared in — `p` means
  // purchase_invoices in one literal and this view in another, and checking
  // across the boundary is how a scan invents failures that are not there.
  const literals = src.split('`');
  for (let i = 1; i < literals.length; i += 2) {
    const q = literals[i].replace(/--[^\n]*/g, '');
    if (!/invoice_payment_lines/.test(q)) continue;
    sites++;

    const rx = /invoice_payment_lines(?:\s+(?:AS\s+)?([a-z_][\w]*))?/gi;
    let m;
    while ((m = rx.exec(q))) {
      const alias = m[1] && !KEYWORDS.has(m[1].toLowerCase()) ? m[1] : null;
      const where = `${path.relative(BE, file)} :: ${q.trim().slice(0, 48).replace(/\s+/g, ' ')}…`;

      if (alias) {
        // Scope the alias to the sub-select that declares it. In one query `p`
        // is this view inside two scalar subqueries and purchase_invoices in a
        // LATERAL join below them — checking the whole literal would report the
        // LATERAL's p.id as a missing column of the view, which is a scan
        // inventing a bug rather than finding one.
        const scope = enclosingParens(q, m.index);
        // If something else in the same scope is aliased the same way, this
        // check cannot tell the two apart — say nothing rather than guess.
        const rival = new RegExp(`\\bFROM\\s+(?!invoice_payment_lines)[a-z_][\\w]*\\s+(?:AS\\s+)?${alias}\\b`, 'i');
        if (rival.test(scope)) continue;
        for (const col of new Set([...scope.matchAll(new RegExp(`\\b${alias}\\.([a-z_][\\w]*)`, 'gi'))].map(x => x[1]))) {
          if (!COLUMNS.has(col)) problems.push(`${alias}.${col} — ${where}`);
        }
      } else {
        // Un-aliased: the columns are the bare identifiers of the sub-select
        // that owns this FROM. Names introduced by AS are output labels, not
        // reads, so they are dropped before checking.
        const sub = q.slice(0, m.index).lastIndexOf('SELECT') >= 0
          ? q.slice(q.slice(0, m.index).lastIndexOf('SELECT'), q.indexOf(')', m.index) + 1 || undefined)
          : q;
        const cleaned = sub.replace(/\bAS\s+[a-z_][\w]*/gi, ' ')
          .replace(/\b[a-z_][\w]*\.[a-z_][\w]*/gi, ' ')  // other tables' columns
          .replace(/\$\d+|::[a-z_\[\]]+/gi, ' ');
        for (const col of new Set([...cleaned.matchAll(/\b([a-z_][\w]*)\b/gi)].map(x => x[1]))) {
          if (KEYWORDS.has(col.toLowerCase()) || col === 'invoice_payment_lines') continue;
          if (!COLUMNS.has(col)) problems.push(`${col} (un-aliased) — ${where}`);
        }
      }
    }
  }
}

assert.ok(sites >= 10, `expected the view to be read in many places, found ${sites}`); n++;
assert.deepStrictEqual(problems, [],
  `queries read columns invoice_payment_lines does not have:\n  ${problems.join('\n  ')}`); n += sites;

// ── The specific query that broke ────────────────────────────────────────────
const ci = fs.readFileSync(path.join(SRC, 'controllers/customer_invoices.controller.js'), 'utf8');
const getPayments = ci.slice(ci.indexOf('async function _getPayments'), ci.indexOf('const _recalcStatus'))
  .replace(/^\s*\/\/.*$/gm, '');   // the comments explain the bug and name it
assert.ok(/cip\.payment_id AS id/.test(getPayments),
  'the invoice screen does not get the ledger payment id — edit and delete take that id'); n++;
assert.ok(!/\bcip\.id\b/.test(getPayments),
  'the invoice payment list asks the view for `id` again'); n++;
// The screen must be able to tell an applied advance apart, because neither the
// edit nor the delete handler can act on one (its customer_invoice_id is NULL).
assert.ok(/cip\.payment_type/.test(getPayments) && /cip\.voucher_no/.test(getPayments),
  'the invoice screen cannot tell an applied advance from an ordinary payment'); n++;

console.log(`view columns: ${n} checks passed across ${sites} query sites`);
