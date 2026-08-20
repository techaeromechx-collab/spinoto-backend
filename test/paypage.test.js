/**
 * The public pay page's new content.
 *
 * Four of these assertions correspond to the four decisions taken: the hub is
 * named by the shared helper, the support number is Spinoto's, the invoice link
 * is the same token WhatsApp sends, and the marketing line is gone.
 */
const assert = require('assert');
const fs = require('fs');

const BE = require('path').resolve(__dirname, '..');
const FE = require('path').resolve(__dirname, '../../frontend/src');
let n = 0;

const ctrl = fs.readFileSync(`${BE}/src/controllers/public.payments.controller.js`, 'utf8');
const page = fs.readFileSync(`${FE}/pages/PublicPayPage.jsx`, 'utf8');
const adapter = fs.readFileSync(`${BE}/src/templates/documentAdapter.js`, 'utf8');

// Comments stripped for the "must not appear" checks. Both files explain in
// prose exactly which fields they deliberately do NOT read, and matching that
// prose is the opposite of a finding.
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ctrlCode = strip(ctrl);
const pageCode = strip(page);

// ── 1. The hub is named by the SHARED helper ────────────────────────────────
// Not by a raw hubs.hub_name read. This is what keeps the pay page and the
// invoice PDF naming the same business, and what makes hub_name_mode:'hidden'
// still mean hidden.
assert.ok(/hubLabel/.test(adapter.slice(adapter.indexOf('module.exports'))),
  'hubLabel is not exported from documentAdapter'); n++;
assert.ok(/require\('\.\.\/templates\/documentAdapter'\)/.test(ctrl),
  'the pay controller does not import the shared adapter'); n++;
assert.ok(/hubLabel\(cfg, \{ legalName:.*branchName:/.test(ctrl),
  'hub_label is not built through hubLabel()'); n++;
// It must pass BOTH names — hubLabel picks between them by mode, and passing
// only one silently collapses 'legal' and 'branch' into the same output.
const ctxBody = ctrl.slice(ctrl.indexOf('async function payPageContext'), ctrl.indexOf('const getPayPage'));
assert.ok(/legal_name/.test(ctxBody) && /branch_name/.test(ctxBody),
  'only one of the two hub names is selected — hub_name_mode cannot work'); n++;
assert.ok(/'Spinoto ' \|\| ar\.name/.test(ctxBody),
  'the branch name is not built the same way the invoice builds it'); n++;
// The page must tolerate a null label rather than substituting its own.
assert.ok(/invoice\?\.hub_label && \(/.test(page),
  'the page renders the hub block unconditionally — hub_name_mode:hidden would leak'); n++;
assert.ok(!/hub_name\b/.test(pageCode),
  'the page reads a raw hub_name instead of the resolved label'); n++;

// ── 2. The support number is the COMPANY's, never the hub's ─────────────────
assert.ok(/company\.phone/.test(ctxBody), 'support_phone does not come from company_settings'); n++;
for (const hubField of ['contact_number', 'owner_mobile', 'person_name']) {
  assert.ok(!new RegExp(`\\b${hubField}\\b`).test(ctrlCode),
    `the pay controller selects hubs.${hubField} — a personal mobile on a public URL`); n++;
}
assert.ok(/support_phone/.test(page), 'the page has no support number'); n++;
// Dialable: a tel: link with the spaces stripped, not a masked string.
assert.ok(/href=\{`tel:/.test(page), 'the support number is not tappable'); n++;
assert.ok(!/maskMobile\(.*support|mask.*support_phone/i.test(pageCode + ctrlCode),
  'the support number is masked — it could not be dialled'); n++;
// The CUSTOMER's mobile stays masked, though. Both rules at once.
assert.ok(/mobile: maskMobile\(invoice\.mobile\)/.test(ctrl),
  'the customer mobile is no longer masked'); n++;

// ── 3. The invoice link points at the BACKEND PDF, not at this SPA ─────────
//
// This is the bug that shipped once. /customer-invoices/<token> on the frontend
// is only mounted when NOBODY is signed in — App.jsx guards it with
// `!loading && !user`, because it shares a path with a staff deep link. Opening
// it from a signed-in browser falls through to the authenticated tree, where
// RequireAdmin sends a hub session to /hub. The customer saw a dashboard.
const appSrc = fs.readFileSync(`${FE}/App.jsx`, 'utf8');
assert.ok(/\{!loading && !user && \(\s*<Route path="\/customer-invoices\/:token"/.test(appSrc),
  'the guard this rule exists for has changed — re-check whether the SPA route is now safe to link'); n++;
assert.ok(/user\.hub_id\) return <Navigate to="\/hub"/.test(appSrc),
  'the hub redirect that caused the bug has moved — re-verify the link target'); n++;

// The backend hands over the TOKEN only.
assert.ok(/invoice_token: row\.public_token \|\| null/.test(ctrl),
  'the controller no longer returns the invoice token'); n++;
assert.ok(!/invoice_url/.test(ctrlCode),
  'the controller still builds a frontend invoice URL'); n++;

// The frontend builds a BACKEND url from the API base it already has.
assert.ok(/function invoiceUrl\(token\)/.test(page), 'invoiceUrl helper is missing'); n++;
// /invoice/<token> — the same address WhatsApp sends and the printed QR
// encodes, and public unconditionally so a signed-in session is not redirected.
assert.ok(/`\/invoice\/\$\{encodeURIComponent\(token\)\}`/.test(page),
  'the invoice link does not point at the shared /invoice/ address'); n++;
// Must NOT point back into this SPA.
assert.ok(!/\/customer-invoices\//.test(pageCode),
  'the page links to the ambiguous plural path'); n++;
assert.ok(!/req\.get\('host'\)|req\.headers\.host/.test(ctrlCode),
  'a URL is built from the request Host header — spoofable'); n++;
// Absent token → no link rendered, rather than a broken href.
assert.ok(/invoiceUrl\(invoice\.invoice_token\) && \(/.test(page),
  'the page renders the invoice link without checking the token exists'); n++;
assert.ok(/token \? `\/invoice\/[\s\S]{0,40}: null;/.test(page),
  'invoiceUrl does not return null for a missing token'); n++;

// The endpoint it links to really is unauthenticated — the whole point.
const pubDocRoutes = fs.readFileSync(`${BE}/src/routes/public.documents.routes.js`, 'utf8');
const pubDocCode = strip(pubDocRoutes);
assert.ok(/router\.get\('\/customer-invoice\/:token'/.test(pubDocCode),
  'the public invoice PDF route has moved'); n++;
assert.ok(!/requireAuth/.test(pubDocCode),
  'the public invoice PDF route now requires auth — the pay page link would break'); n++;
// It opens safely — target=_blank without rel=noopener hands the opener to the
// PDF host.
const linkCount = (page.match(/target="_blank"/g) || []).length;
const relCount = (page.match(/rel="noopener noreferrer"/g) || []).length;
assert.strictEqual(linkCount, relCount,
  `${linkCount} _blank links but only ${relCount} carry rel="noopener noreferrer"`); n++;
assert.ok(linkCount >= 3, 'the invoice link is missing from one of the three page states'); n++;

// ── The header is the LOGO, not the legal entity name ──────────────────────
// company_settings.company_name holds "… Automotive Pvt. Ltd." — correct on a
// tax invoice, wrong at the top of a payment page, where a name the customer
// has never heard of reads as a scam.
assert.ok(/src="\/logo\.svg"/.test(page), 'the pay page does not show the Spinoto logo'); n++;
assert.ok(/alt="Spinoto"/.test(page), 'the logo has no alt text'); n++;
assert.ok(/onError=/.test(page),
  'a missing logo asset would render a broken-image icon on a page asking for money'); n++;
assert.ok(!/support_name/.test(pageCode),
  'the page still displays the legal entity name'); n++;
assert.ok(!/support_name/.test(ctrlCode),
  'the API still returns the legal entity name to an anonymous caller'); n++;
// The double full stop the legal name produced: "…never reach … Pvt. Ltd.."
assert.ok(!/never reach\s*\n?\s*\{/.test(page),
  'the fine print interpolates a company name — it produced "Ltd.." in production'); n++;
assert.ok(/never reach Spinoto\./.test(page), 'the fine print no longer names anyone'); n++;
// The gateway window shows the same brand as the page.
assert.ok(/company: \{ name: 'Spinoto'/.test(page),
  'the checkout window shows a different name from the page'); n++;

// ── 4. The marketing line is gone ──────────────────────────────────────────
assert.ok(!/1000\+|Trusted by/i.test(pageCode), 'the marketing tagline survived'); n++;

// ── GST is not labelled with a hardcoded rate ──────────────────────────────
// gst_percent is per line item and one job mixes rates; "GST (18%)" would be a
// wrong tax figure on a page taking money.
assert.ok(!/GST \(\d+%?\)|18%/.test(pageCode), 'the page hardcodes a GST percentage'); n++;
assert.ok(/label="GST"/.test(page), 'the GST line is missing'); n++;
assert.ok(/total_gst/.test(ctxBody) && /subtotal_ex_gst/.test(ctxBody),
  'the invoice summary figures are not returned'); n++;
// Zero-GST invoices (Bill of Supply) must not print an empty GST row.
assert.ok(/Number\(invoice\.total_gst\) > 0/.test(page),
  'a zero GST line is rendered on Bill of Supply invoices'); n++;

// ── The expiry shows the REAL time ─────────────────────────────────────────
// Links die 7 days from creation, not at end of day. Rounding to 11:59 PM
// leaves someone with a dead link and no explanation.
assert.ok(/hour: 'numeric', minute: '2-digit'/.test(page),
  'the expiry time is not shown, only a date'); n++;
assert.ok(!/11:59/.test(pageCode), 'an assumed end-of-day expiry time is hardcoded'); n++;
assert.ok(/hoursLeft/.test(page), 'there is no warning when a link is about to expire'); n++;

// ── Still narrow: nothing new leaked into the public projection ────────────
const resBody = ctrl.slice(ctrl.indexOf('res.json({', ctrl.indexOf('const getPayPage')));
for (const leak = 0, forbidden = ['address', 'gstin', 'b2b_', 'cost', 'hub_gst',
                                  'purchase_invoice', 'margin', 'items']; ;) {
  for (const f of forbidden) {
    assert.ok(!new RegExp(f, 'i').test(resBody.slice(0, resBody.indexOf('});'))),
      `the public pay response now exposes '${f}'`); n++;
  }
  break;
}
// The customer's full mobile must not appear anywhere in the response.
assert.ok(!/mobile: invoice\.mobile/.test(ctrlCode), 'the unmasked mobile is returned'); n++;

// ── Payment-method marks are words, not trademarked logos ──────────────────
assert.ok(!/visa|mastercard|rupay/i.test(pageCode),
  'card-network brand marks are used — trademarks with usage rules, and they promise methods the account may not have enabled'); n++;
assert.ok(/UPI · Cards · Net banking · Wallets/.test(page),
  'the accepted methods are not listed'); n++;

// ── The security rules did not regress ─────────────────────────────────────
assert.ok(/do\s+NOT\s+pay again/i.test(page),
  'the failed-verification message no longer warns against paying twice'); n++;
assert.ok(/Confirming your payment with the bank/.test(page),
  'the verification wait is no longer explained'); n++;
assert.ok(!/RAZORPAY_KEY|VITE_RAZORPAY/.test(pageCode),
  'the page reads a gateway credential from its own environment'); n++;

console.log(`public pay page: ${n} checks passed`);
