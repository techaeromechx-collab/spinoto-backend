/**
 * Every icon a screen draws is an icon that screen imported.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * The credit banner on the invoice screen drew <Loader2 /> while the button
 * was busy. Loader2 was never added to that file's lucide-react import. In a
 * browser that is not a build error — an undefined identifier inside JSX is a
 * plain ReferenceError thrown at RENDER time. So the page loaded fine, the
 * list worked fine, and the crash waited in the one branch that only runs
 * while somebody is pressing Apply. It reached the user.
 *
 * ── Why the existing checks did not catch it ────────────────────────────────
 * The bundle check (`esbuild --bundle --packages=external`) passes, because a
 * free identifier is legal JavaScript: esbuild assumes it is a global and
 * emits the bundle. Nothing in the pipeline resolves it. Hot reload then hides
 * the evidence — after a refresh the component often is not re-rendered in the
 * busy state, so it looks "fixed" without anything having been fixed.
 *
 * ── What this checks ────────────────────────────────────────────────────────
 * The union of every name imported from lucide-react anywhere in the frontend
 * is the corpus of known icons. For each file, any corpus name used as a JSX
 * element must appear in that file's own lucide-react import. That is narrow
 * on purpose: it will not flag a locally defined component that happens to
 * share a name with an icon, and it needs no icon list to be kept up to date.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FE = path.resolve(__dirname, '../../frontend/src');
let n = 0;

// Comments and strings are not code. A commented-out <Trash2 /> is not a use,
// and neither is the word inside a className.
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(FE);
assert.ok(files.length > 50, 'the frontend tree was not found, so this suite checked nothing');

// One file's lucide-react import list.
//
// [^{}]* rather than [\s\S]*? — a lazy any-character run happily starts at the
// FIRST import in the file and swallows every import between it and the lucide
// one, which quietly pulls react and recharts names into the icon corpus and
// glues real icon names onto the end of the line before them. That bug made
// the first run of this suite report 42 failures, none of them real.
function importedIcons(src) {
  const names = new Set();
  let found = false;
  for (const m of src.matchAll(/import\s*\{([^{}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    found = true;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return found ? names : null;
}

// ── The corpus ──────────────────────────────────────────────────────────────
const corpus = new Set();
const sources = new Map();
for (const f of files) {
  const src = strip(fs.readFileSync(f, 'utf8'));
  sources.set(f, src);
  const set = importedIcons(src);
  if (set) for (const name of set) corpus.add(name);
}
assert.ok(corpus.size > 20,
  'no lucide-react imports were found at all — the scan is looking in the wrong place'); n++;

// Every name this file binds by importing it, from ANY module — not just
// lucide. Some names are an icon in one screen and something else entirely in
// another: BarChart is a lucide icon on the profile page and a recharts chart
// on the reports page. Sharing a name with an icon is not a bug; having no
// binding at all is.
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s*['"][^'"]+['"]/g)) {
    for (const raw of m[1].replace(/[{}]/g, ',').split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name && !name.startsWith('*')) names.add(name);
    }
  }
  return names;
}

// ── The check ───────────────────────────────────────────────────────────────
const missing = [];
for (const [f, src] of sources) {
  const bound = importedNames(src);
  const used = new Set();
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)) used.add(m[1]);
  for (const name of used) {
    if (!corpus.has(name) || bound.has(name)) continue;
    // Declared in this file rather than imported — a local component — is
    // equally resolvable. Kept deliberately narrow: a loose "the word appears
    // somewhere" test would excuse the very bug this suite exists for, since
    // the missing Loader2 appeared in the file too, in the JSX that crashed.
    const declared = new RegExp(
      `(?:function|const|let|class)\\s+${name}\\s*[=({]`
    ).test(src);
    if (!declared) missing.push(`${path.relative(FE, f)}: <${name} />`);
  }
}

assert.deepStrictEqual(missing, [],
  'these screens draw a lucide icon they never imported — each one is a ' +
  'ReferenceError the moment that branch renders:\n  ' + missing.join('\n  ')); n++;

// ── The specific one that got out ───────────────────────────────────────────
{
  const src = sources.get(path.join(FE, 'pages/CustomerInvoicesPage.jsx'));
  assert.ok(src, 'the customer invoices page was not found'); n++;
  const have = importedIcons(src);
  assert.ok(have.has('Loader2'),
    'the credit banner spinner is back to being an undefined identifier — it ' +
    'crashes the drawer the moment Apply is pressed'); n++;
  assert.ok(/\{applyingCredit \? <Loader2 /.test(src),
    'the Apply button no longer shows that it is working'); n++;
}

console.log(`icons a screen draws are icons it imported: ${n} checks passed`);
