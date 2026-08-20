/**
 * The public document addresses.
 *
 *   /invoice/<token>   and  /estimate/<token>   — public, unconditionally
 *   /customer-invoices/<token>, /estimates/<token> — kept, redirecting here
 *
 * The rules worth pinning are the two that would break silently: a future
 * refactor re-gating the public routes behind `!user`, and someone deleting the
 * old paths that paper QR codes and existing WhatsApp messages still carry.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const app = fs.readFileSync(`${FE}/App.jsx`, 'utf8');
const wa  = fs.readFileSync(`${BE}/src/services/whatsapp.dispatcher.js`, 'utf8');
const qr  = fs.readFileSync(`${BE}/src/utils/qr.js`, 'utf8');
const pay = fs.readFileSync(`${FE}/pages/PublicPayPage.jsx`, 'utf8');

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const appCode = strip(app);
const waCode  = strip(wa);
const qrCode  = strip(qr);
const payCode = strip(pay);

// ── The new routes exist and are NOT gated ─────────────────────────────────
// The entire point. A `!user` wrapper here would put back the exact bug this
// change removes, and it would only show up when someone signed in clicked a
// customer link.
for (const [path, page] of [['/invoice/:token', 'PublicInvoicePage'],
                            ['/estimate/:token', 'PublicEstimatePage']]) {
  const re = new RegExp(`<Route path="${path.replace(/[/:]/g, m => '\\' + m)}"\\s+element=\\{<${page} />\\} />`);
  assert.ok(re.test(app), `${path} is not mounted to ${page}`); n++;

  // Walk outward from the route and prove no `!user` / `!loading` wrapper
  // encloses it. Checking the same LINE is not enough — the gate is a JSX
  // expression on the lines above.
  const at = app.search(re);
  const before = app.slice(Math.max(0, at - 400), at);
  const openGates = (before.match(/\{!loading && !user && \(/g) || []).length;
  const closeGates = (before.match(/^\s*\)\}\s*$/gm) || []).length;
  assert.ok(openGates <= closeGates,
    `${path} sits inside a "!loading && !user" gate — it must be public for everyone`); n++;
}

// ── The old paths still exist, still gated, and redirect ───────────────────
// Paper QR codes and sent WhatsApp messages carry these. Deleting either is
// how a customer's printed invoice stops resolving.
for (const [oldPath, target] of [['/customer-invoices/:token', 'invoice'],
                                 ['/estimates/:token', 'estimate']]) {
  const re = new RegExp(
    `<Route path="${oldPath.replace(/[/:]/g, m => '\\' + m)}" element=\\{<LegacyDocRedirect to="${target}" />\\} />`);
  assert.ok(re.test(app), `${oldPath} no longer redirects to /${target}/ — printed QR codes would break`); n++;

  // The !user gate MUST remain on the old paths: without it a signed-in staff
  // member's deep link into the CRM is hijacked to the public page.
  const at = app.search(re);
  const before = app.slice(Math.max(0, at - 200), at);
  assert.ok(/\{!loading && !user && \(/.test(before),
    `${oldPath} lost its !user gate — the staff deep link into the CRM is now hijacked`); n++;
}

// The redirect preserves the token and does not push a history entry.
assert.ok(/function LegacyDocRedirect\(\{ to \}\)/.test(app), 'LegacyDocRedirect is missing'); n++;
assert.ok(/const \{ token \} = useParams\(\)/.test(app), 'the redirect does not read the token'); n++;
assert.ok(/to=\{`\/\$\{to\}\/\$\{encodeURIComponent\(token \|\| ''\)\}`\}/.test(app),
  'the redirect does not carry the token through, or does not encode it'); n++;
assert.ok(/<Navigate to=\{`\/\$\{to\}[\s\S]{0,60}replace \/>/.test(app),
  'the redirect pushes a history entry — Back would fire it again and trap the customer'); n++;
assert.ok(/useParams/.test(app.split('\n')[0] + app.slice(0, 200)),
  'useParams is not imported'); n++;

// Exactly one mount of each public page — the redirect exists so there is not
// a second copy to keep in step.
for (const page of ['PublicInvoicePage', 'PublicEstimatePage']) {
  const mounts = (appCode.match(new RegExp(`element=\\{<${page} />\\}`, 'g')) || []).length;
  assert.strictEqual(mounts, 1, `${page} is mounted ${mounts} times — one implementation, one mount`); n++;
}

// ── What WhatsApp sends ────────────────────────────────────────────────────
assert.ok(/\$\{publicAppUrl\}\/invoice\/\$\{row\.public_token\}/.test(waCode),
  'the WhatsApp invoice link does not use /invoice/'); n++;
assert.ok(/\$\{publicAppUrl\}\/estimate\/\$\{row\.public_token\}/.test(waCode),
  'the WhatsApp estimate link does not use /estimate/'); n++;
assert.ok(!/\/customer-invoices\/\$\{/.test(waCode),
  'the WhatsApp invoice link still uses the ambiguous plural path'); n++;
assert.ok(!/\/estimates\/\$\{/.test(waCode),
  'the WhatsApp estimate link still uses the ambiguous plural path'); n++;
// PUBLIC_APP_URL unset must still block the send rather than message a customer
// a link to nowhere — behaviour that predates this change and must survive it.
assert.ok(/publicAppUrl && row\.public_token/.test(waCode),
  'an unset PUBLIC_APP_URL no longer blocks the send'); n++;

// ── What a freshly printed QR encodes ──────────────────────────────────────
assert.ok(/estimate: 'estimate'/.test(qrCode), 'the estimate QR still encodes the plural path'); n++;
assert.ok(/customer_invoice: 'invoice'/.test(qrCode), 'the invoice QR still encodes the plural path'); n++;
// purchase_invoice is untouched: it has no public page and is hub-facing.
assert.ok(/purchase_invoice: 'purchase-invoices'/.test(qrCode),
  'the purchase invoice path was changed — it has no public page to point at'); n++;

// ── The pay page uses the same address ─────────────────────────────────────
assert.ok(/function invoiceUrl\(token\)/.test(pay), 'invoiceUrl helper is missing'); n++;
assert.ok(/`\/invoice\/\$\{encodeURIComponent\(token\)\}`/.test(pay),
  'the pay page does not link to /invoice/<token>'); n++;
assert.ok(!/api\/public\/documents/.test(payCode),
  'the pay page still links straight to the API PDF instead of the shared address'); n++;
assert.ok(!/\/customer-invoices\//.test(payCode),
  'the pay page still links to the ambiguous plural path'); n++;
// Absent token → no link, rather than href="/invoice/"
assert.ok(/token \? `\/invoice\/[\s\S]{0,40}: null;/.test(pay),
  'invoiceUrl does not return null for a missing token'); n++;

// ── The public PDF endpoint the pages redirect to is unchanged ─────────────
const pubDoc = strip(fs.readFileSync(`${BE}/src/routes/public.documents.routes.js`, 'utf8'));
assert.ok(/router\.get\('\/customer-invoice\/:token'/.test(pubDoc),
  'the API document route moved — the public pages redirect to it'); n++;
assert.ok(!/requireAuth/.test(pubDoc), 'the API document route now requires auth'); n++;

// ── The pages themselves still target the API, not each other ─────────────
const pubInv = fs.readFileSync(`${FE}/pages/PublicInvoicePage.jsx`, 'utf8');
// The path is composed now — the same shell serves the invoice and the advance
// receipt voucher, differing by one prop. What must hold is that the DEFAULT is
// still the invoice endpoint, or the existing route silently changes meaning.
assert.ok(/api\/public\/documents\/\$\{endpoint\}\//.test(pubInv),
  'PublicInvoicePage no longer redirects to the API PDF'); n++;
assert.ok(/endpoint = 'customer-invoice'/.test(pubInv),
  'the default endpoint is no longer the customer invoice — /invoice/:token would open something else'); n++;
assert.ok(/Tap here if it doesn/.test(pubInv),
  'the manual fallback link is gone — Android browsers that block the auto-open show a blank screen'); n++;

console.log(`public document routes: ${n} checks passed`);
