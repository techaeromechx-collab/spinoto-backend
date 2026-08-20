/**
 * Hub portal routing invariants.
 *
 * Evaluates the REAL source of appPaths.js and HubDashboardPage.jsx rather
 * than a copy, so drift between the path map, the tab list and the routes
 * fails here instead of in a hub's browser.
 */
const fs = require('fs');
const assert = require('assert');
const SRC = require('path').resolve(__dirname, '../../frontend/src') + '';

let n = 0;

// ── 1. The two path maps ────────────────────────────────────────────────────
const pathsSrc = fs.readFileSync(`${SRC}/lib/appPaths.js`, 'utf8')
  .replace(/^import .*$/gm, '')          // drop the React/auth import
  .replace(/^export /gm, '');            // plain consts
const { STAFF_PATHS, HUB_PATHS } =
  new Function(`${pathsSrc}; return { STAFF_PATHS, HUB_PATHS };`)();

// Identical key sets. A caller reads P.<key> without knowing which shell it
// is in, so a key present in one map and absent from the other yields
// `undefined` — which stringifies into the URL as "undefined/AbC123" and is
// far harder to spot than a null.
assert.deepStrictEqual(
  Object.keys(STAFF_PATHS).sort(), Object.keys(HUB_PATHS).sort(),
  'STAFF_PATHS and HUB_PATHS key sets have diverged'
); n++;

// Every staff value is a real path; hub values are a path or an explicit null.
for (const [k, v] of Object.entries(STAFF_PATHS)) {
  assert.ok(typeof v === 'string' && v.startsWith('/'), `STAFF_PATHS.${k} is not a path`); n++;
}
for (const [k, v] of Object.entries(HUB_PATHS)) {
  assert.ok(v === null || (typeof v === 'string' && v.startsWith('/hub')),
    `HUB_PATHS.${k} must be null or live under /hub, got ${v}`); n++;
}

// No trailing slashes — every caller builds `${P.x}/${token}`.
for (const v of [...Object.values(STAFF_PATHS), ...Object.values(HUB_PATHS)]) {
  if (typeof v === 'string' && v !== '/') {
    assert.ok(!v.endsWith('/'), `trailing slash on ${v} would produce a double slash`); n++;
  }
}

// The screens the hub portal genuinely does not have stay null, so callers are
// forced to hide the link rather than navigate somewhere that bounces.
for (const k of ['customers', 'leads', 'payouts', 'warrantyClaims']) {
  assert.strictEqual(HUB_PATHS[k], null, `HUB_PATHS.${k} should be null`); n++;
}

// ── 2. TABS / TAB_PATH / tabFromPath ────────────────────────────────────────
const hubSrc = fs.readFileSync(`${SRC}/pages/HubDashboardPage.jsx`, 'utf8');
const tabsLit = hubSrc.match(/const TABS = \[[\s\S]*?\n\];/);
const hiddenLit = hubSrc.match(/const HIDDEN_TABS = \[[\s\S]*?\n\];/);
const allLit  = hubSrc.match(/const ALL_TABS = .*;/);
const tabPath = hubSrc.match(/const TAB_PATH = .*;/);
const tabFrom = hubSrc.match(/function tabFromPath\(pathname\) \{[\s\S]*?\n\}/);
assert.ok(tabsLit && hiddenLit && allLit && tabPath && tabFrom,
  'could not locate TABS / HIDDEN_TABS / ALL_TABS / TAB_PATH / tabFromPath'); n++;

// Icons are lucide components; stub them so the literal evaluates.
const iconStub = 'const LayoutDashboard=0,Calendar=0,FileText=0,ReceiptText=0,Receipt=0,Wrench=0;';
const { TABS, HIDDEN_TABS, ALL_TABS, TAB_PATH, tabFromPath } = new Function(
  `${iconStub}${tabsLit[0]}${hiddenLit[0]}${allLit[0]}${tabPath[0]}${tabFrom[0]};` +
  ` return { TABS, HIDDEN_TABS, ALL_TABS, TAB_PATH, tabFromPath };`
)();

// A hidden tab is reachable and titled but must NOT appear in the sidebar —
// TABS is what the nav maps over, so leaking one in there is the mistake.
for (const h of HIDDEN_TABS) {
  assert.ok(!TABS.some(t => t.key === h.key), `hidden tab '${h.key}' leaked into the sidebar`); n++;
  assert.ok(h.label, `hidden tab '${h.key}' has no label — the topbar title would be blank`); n++;
  assert.strictEqual(tabFromPath(TAB_PATH[h.key]), h.key,
    `${h.key}: its own URL does not resolve back to it — the wrong nav row would highlight`); n++;
}

// Exactly one index tab, and every other segment unique.
const segs = ALL_TABS.map(t => t.seg);
assert.strictEqual(segs.filter(s => s === '').length, 1, 'expected exactly one index tab'); n++;
assert.strictEqual(new Set(segs).size, segs.length, 'duplicate tab segment'); n++;

// Round trip: every tab's own path resolves back to that tab.
for (const t of ALL_TABS) {
  assert.strictEqual(tabFromPath(TAB_PATH[t.key]), t.key, `${t.key}: path→tab round trip failed`); n++;
}

// A deep link carrying a record token still highlights its list tab — this is
// the case the old useState('dashboard') could never represent.
assert.strictEqual(tabFromPath('/hub/estimates/AbC123xyz'), 'estimates'); n++;
assert.strictEqual(tabFromPath('/hub/sales-invoices/Q7z'), 'sell-invoices'); n++;
assert.strictEqual(tabFromPath('/hub/appointments/tok'), 'appointments'); n++;

// Dashboard, with and without the trailing slash.
assert.strictEqual(tabFromPath('/hub'), 'dashboard'); n++;
assert.strictEqual(tabFromPath('/hub/'), 'dashboard'); n++;

// Unknown segment falls back rather than leaving nothing highlighted.
assert.strictEqual(tabFromPath('/hub/nonsense'), 'dashboard'); n++;

// ── 3. The three lists agree ────────────────────────────────────────────────
// Every non-index tab must be routable, and every hub path in the map must
// correspond to a real tab. Either half drifting gives a sidebar entry that
// 404s to the dashboard, or a cross-page link to a tab that does not exist.
const routed = [...hubSrc.matchAll(/<Route path="([a-z-]+)(?:\/:token\?)?"/g)].map(m => m[1]);
for (const t of ALL_TABS) {
  if (t.seg) assert.ok(routed.includes(t.seg), `tab '${t.seg}' has no <Route>`); n++;
}
for (const [k, v] of Object.entries(HUB_PATHS)) {
  if (!v || v === '/hub') continue;
  const seg = v.replace('/hub/', '');
  assert.ok(segs.includes(seg), `HUB_PATHS.${k} points at '${seg}', which is not a tab`); n++;
}

// ── 4. No stale no-op navigate left behind ──────────────────────────────────
// The old workaround silently swallowed every navigation for hub users. If one
// survives, that page's links look alive and do nothing.
for (const f of ['EstimatesPage', 'AppointmentsPage', 'CustomerInvoicesPage', 'PurchaseInvoicesPage']) {
  const src = fs.readFileSync(`${SRC}/pages/${f}.jsx`, 'utf8');
  assert.ok(!/\?\s*\(\)\s*=>\s*\{\}\s*:\s*rawNavigate/.test(src), `${f}: no-op navigate still present`); n++;
  // And no admin path hardcoded into a navigate() any more.
  const bad = [...src.matchAll(/navigate\((['`])\/(estimates|appointments|customers|customer-invoices|purchase-invoices|warranty-claims)/g)];
  assert.strictEqual(bad.length, 0, `${f}: ${bad.length} hardcoded navigate target(s)`); n++;
}

// ── 5. Every use of a nullable path is guarded ──────────────────────────────
// HUB_PATHS.customers / leads / payouts / warrantyClaims are null. An
// unguarded `navigate(`${P.customers}/${tok}`)` does not fail loudly — it puts
// the literal string "null/AbC123" in the address bar, which is exactly the
// mistake this whole module exists to prevent. Every line that USES a nullable
// key must sit inside a guard: the line itself tests it, or one of the
// preceding lines does (30-line window: JSX guards wrap blocks).
const NULLABLE = Object.entries(HUB_PATHS).filter(([, v]) => v === null).map(([k]) => k);

// Blank out comments while preserving line numbers — a prose mention of
// "P.customers is null" in a code comment is not a use.
function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g,       m => m.replace(/[^\n]/g, ' '))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep) => keep);
}

for (const f of ['EstimatesPage', 'AppointmentsPage', 'CustomerInvoicesPage', 'PurchaseInvoicesPage']) {
  const lines = stripComments(fs.readFileSync(`${SRC}/pages/${f}.jsx`, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const key of NULLABLE) {
      if (!line.includes(`P.${key}`)) continue;
      const win = lines.slice(Math.max(0, i - 30), i + 1).join('\n');
      const guarded = new RegExp(`P\\.${key}\\s*(\\?|&&)`).test(win);
      assert.ok(guarded, `${f}:${i + 1} uses P.${key} unguarded — would navigate to "null/…"\n    ${line.trim()}`);
      n++;
    }
  });
}

// ── 6. The hub shell hosts the search box ───────────────────────────────────
// pageSearchStore's contract: a list page publishes its search, a SHELL renders
// it, and "a page that does not call usePageSearch gets no search box at all."
// Only AppShell implemented the shell half, and the hub portal renders no
// AppShell — so all four hub lists published a box nobody drew.
const shell = fs.readFileSync(`${SRC}/pages/HubDashboardPage.jsx`, 'utf8');
assert.ok(/useTopbarSearch\(\)/.test(shell), 'hub portal does not host the search store'); n++;
assert.ok(/pageSearch\.active/.test(shell), 'hub search box is not gated on a page claiming it'); n++;
assert.ok(/pageSearch\.onChange\?\.\(e\.target\.value\)/.test(shell), 'hub search input is not wired to onChange'); n++;
assert.ok(/clearPageSearch\(\)/.test(shell), 'Escape does not clear the hub search'); n++;

// Every list reachable from a hub tab must actually publish one, or the box
// silently never appears on that tab.
for (const f of ['AppointmentsPage', 'EstimatesPage', 'CustomerInvoicesPage', 'PurchaseInvoicesPage']) {
  const src = fs.readFileSync(`${SRC}/pages/${f}.jsx`, 'utf8');
  assert.ok(/usePageSearch\(\{/.test(src), `${f} publishes no search`); n++;
}

console.log(`hub routing: ${n} checks passed`);
