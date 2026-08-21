'use strict';

/**
 * WhatsApp's *bold* / _italic_ / ~strike~ / ```mono```, read for display.
 *
 * ── WHAT IS AT STAKE ────────────────────────────────────────────────────────
 *
 * Nothing about SENDING. `*bold*` is an asterisk, the word, an asterisk — plain
 * characters WhatsApp styles on the customer's phone. That worked before any of
 * this existed and must keep working, which means the parser must never touch
 * what is stored or sent. It reads; it does not rewrite.
 *
 * What it can get wrong is subtler and worse: being MORE eager than WhatsApp.
 * A renderer that bolds `* spaced *` or `follow_up_date` shows an advisor
 * formatting the customer will never see, which is precisely the confusion the
 * preview was built to remove — now with the CRM's authority behind it. So
 * every rule here is a real WhatsApp behaviour and every one is pinned.
 *
 * ── AND THE INJECTION ───────────────────────────────────────────────────────
 *
 * Inbound WhatsApp messages are attacker text rendered inside a CRM session
 * that can read every lead in the business. The renderer must produce React
 * elements, never an HTML string — asserted directly, because the HTML-string
 * version is the shorter code and the one somebody reaches for.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..');
const FE = path.resolve(BE, '../frontend');
let n = 0;

const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

(async () => {

// require(esm) — the frontend is "type": "module" and Node 22 loads it
// directly. The REAL parser, not a copy of its rules: a test that reimplements
// what it checks agrees with itself no matter what the app does.
const { parseWaFormat, toggleMark } = require(path.join(FE, 'src/utils/waFormat.js'));

/** Compact shape for asserting: '[bold:hi]' or plain '"text"'. */
const shape = (t) => parseWaFormat(t).map(r => {
  const f = ['bold', 'italic', 'strike', 'mono'].filter(k => r[k]).join('+');
  return f ? `[${f}:${r.text}]` : JSON.stringify(r.text);
}).join(' ');

// ── The four marks ─────────────────────────────────────────────────────────
assert.strictEqual(shape('*hi* there'), '[bold:hi] " there"'); n++;
assert.strictEqual(shape('_hi_'), '[italic:hi]'); n++;
assert.strictEqual(shape('~hi~'), '[strike:hi]'); n++;
assert.strictEqual(shape('```hi```'), '[mono:hi]'); n++;

// Nesting is real on WhatsApp: *_both_* is bold AND italic, one run.
assert.strictEqual(shape('*_both_*'), '[bold+italic:both]'); n++;

// Nothing is parsed inside monospace. ```*not bold*``` is code showing an
// asterisk, which is the only reading that makes the mark useful.
assert.strictEqual(shape('```*x*```'), '[mono:*x*]'); n++;

// ── The eagerness rules: each one is text the customer sees literally ──────
//
// If any of these start rendering as formatting, the CRM is telling advisors
// something WhatsApp will not do.
const LITERAL = [
  '* not bold *',        // markers must hug the text
  'a*b*c',               // cannot open mid-word
  'follow_up_date',      // snake_case is not italic — the one that would bite daily
  '*unclosed',           // no closing marker
  '**',                  // empty
  '*bold*s',             // closing marker cannot be followed by a word character
  '2 * 3 * 4',           // arithmetic
  '5*6',
  /* These three each isolate ONE rule, and each was added because the loose
     version of this list did not: 'a*b*c' and '5*6' have no valid closing
     marker either way, so they stayed literal even with the opening rule
     deleted. A case only tests a rule if removing that rule changes it. */
  'a*b* c',              // cannot OPEN mid-word — closes validly, so only the open rule saves it
  '5*6* 7',              // digits are word characters, for exactly the same reason
  '*bold *',             // the CLOSING marker must hug its text too
];
for (const t of LITERAL) {
  assert.strictEqual(shape(t), JSON.stringify(t),
    `${JSON.stringify(t)} was formatted; WhatsApp shows it literally, so the CRM must too`); n++;
}

// Punctuation either side is fine — WhatsApp formats (*bold*).
assert.strictEqual(shape('(*bold*)'), '"(" [bold:bold] ")"'); n++;

// Line breaks survive as part of the run; the element around it decides
// whether they render, and every caller sets pre-wrap.
assert.strictEqual(shape('a\n*b*'), '"a\\n" [bold:b]'); n++;

// Empty and non-string inputs return nothing rather than throwing. This is
// rendered on every message in a thread, including ones with no body at all.
for (const v of ['', null, undefined, 42, {}]) {
  assert.deepStrictEqual(parseWaFormat(v), [],
    `parseWaFormat(${JSON.stringify(v)}) did not return an empty list`); n++;
}

// ── The real message this was built for ────────────────────────────────────
//
// Emoji either side of the markers, numbered headings, bullets, blank lines.
// Emoji are not word characters, so they must not block a marker from opening
// — which is the one thing that would silently break every heading in it.
const MENU = [
  '🚗✨ *Spinoto Premium Car Service Menu* ✨🚗',
  '',
  '🟢 *1. Basic Service* 🛠️',
  '• 🛢️ Engine Oil Replacement',
  '...and 4 more essential points!',
  '',
  '🔴 *3. Comprehensive Service* 🏆 (Ultimate Reset)',
].join('\n');

const bolded = parseWaFormat(MENU).filter(r => r.bold).map(r => r.text);
assert.deepStrictEqual(bolded, [
  'Spinoto Premium Car Service Menu',
  '1. Basic Service',
  '3. Comprehensive Service',
], `the menu's headings did not come out bold: ${JSON.stringify(bolded)}`); n++;

// Nothing is lost or invented. Re-joining every run must reproduce the input
// minus exactly the markers that were consumed — the guarantee that this is a
// reader and not a rewriter.
const rejoined = parseWaFormat(MENU).map(r => r.text).join('');
assert.strictEqual(rejoined, MENU.replace(/\*/g, ''),
  'the parser dropped or added text beyond the markers it consumed'); n++;

// The bullets and the emoji survive untouched.
assert.ok(rejoined.includes('• 🛢️ Engine Oil Replacement'),
  'a bullet line was mangled'); n++;
assert.ok(rejoined.includes('...and 4 more essential points!'),
  'a plain line was mangled'); n++;

// ── toggleMark: the B / I / S buttons ──────────────────────────────────────
assert.deepStrictEqual(toggleMark('hello world', 0, 5, '*'),
  { value: '*hello* world', start: 1, end: 6 },
  'wrapping a selection is wrong'); n++;

/* Pressing B twice must UNWRAP, not produce '**bold**'.
   WhatsApp renders that as a literal asterisk either side of bold text — a
   mistake that looks like a double-click and reaches the customer looking like
   a typo. Both selection shapes count: the markers inside the highlight, and
   the markers around it. */
assert.strictEqual(toggleMark('*hello* world', 0, 7, '*').value, 'hello world',
  'toggling off with the markers selected did not unwrap'); n++;
assert.strictEqual(toggleMark('*hello* world', 1, 6, '*').value, 'hello world',
  'toggling off with only the word selected did not unwrap'); n++;

// Nothing selected: insert the pair and put the caret between them, ready to
// type. A caret left outside means the next keystroke lands after the markers.
const empty = toggleMark('hi', 2, 2, '*');
assert.strictEqual(empty.value, 'hi**'); n++;
assert.strictEqual(empty.start, 3, 'the caret is not between the markers'); n++;
assert.strictEqual(empty.start, empty.end, 'an empty insert left a selection'); n++;

// Out-of-range offsets must not throw or corrupt. A stale ref after a
// re-render is the realistic way this gets called with nonsense.
assert.doesNotThrow(() => toggleMark('hi', 99, 200, '*')); n++;
assert.doesNotThrow(() => toggleMark(null, 0, 0, '*')); n++;

// ── The renderer produces ELEMENTS, never HTML ─────────────────────────────
const waText = strip(read(path.join(FE, 'src/components/WaText.jsx')));
assert.ok(!/dangerouslySetInnerHTML/.test(waText),
  'WaText injects HTML — an inbound WhatsApp message containing <script> would run in an '
  + "advisor's session, against a token that can read every lead in the business"); n++;
assert.match(waText, /parseWaFormat/,
  'WaText does not use the shared parser; the rules would exist twice'); n++;

// ── And it is actually USED, in every place the text is read ───────────────
const thread = strip(read(path.join(FE, 'src/components/WhatsAppThread.jsx')));
assert.match(thread, /<WaText text=\{m\.body_rendered\}/,
  'the chat bubble still shows raw markers — the advisor reads asterisks while the '
  + 'customer reads bold'); n++;
assert.match(thread, /<WaText text=\{qr\.message\}/,
  'the quick-reply pickers still show raw markers'); n++;
// Both pickers, not one: the ⚡ panel and the '/' suggestion list.
assert.strictEqual((thread.match(/<WaText text=\{qr\.message\}/g) || []).length, 2,
  'only one of the two quick-reply pickers renders formatting'); n++;

const qrTab = strip(read(path.join(FE, 'src/components/settings/WhatsAppQuickRepliesTab.jsx')));
assert.match(qrTab, /<WaText text=\{it\.message\}/,
  'the saved quick-reply list still shows raw markers'); n++;

/* One MessageField, used by both forms.
   Written inline twice, the pair that drifts is always the second one — the
   edit box that never got the buttons, found months later by somebody
   wondering why formatting only works on new replies. */
assert.match(qrTab, /function MessageField\(/, 'the shared message field is gone'); n++;
assert.strictEqual((qrTab.match(/<MessageField/g) || []).length, 2,
  'the add form and the edit form do not both use MessageField'); n++;
assert.ok(!/<textarea/.test(qrTab.slice(qrTab.indexOf('export default'))),
  'a raw textarea survives outside MessageField, so one of the forms has no buttons '
  + 'and no preview'); n++;

// The preview must render through the same parser the chat does, or it is a
// claim about the customer's screen that nothing verifies.
assert.match(qrTab, /waq-preview-bubble[\s\S]{0,120}<WaText text=\{value\}/,
  'the preview does not render the message through the shared renderer'); n++;

// The buttons must not steal the textarea's selection. A plain click blurs it
// first, and the wrap then lands on an empty selection at position zero.
assert.match(qrTab, /onMouseDown=\{e => e\.preventDefault\(\)\}/,
  'the formatting buttons blur the textarea before reading its selection'); n++;

// ── Nothing on the way out was changed ─────────────────────────────────────
//
// The markers ARE the formatting. Anything that strips them before sending
// delivers plain text to the customer while the CRM shows bold — the exact
// inverse of the bug this fixed, and harder to notice.
const interakt = strip(read(path.join(BE, 'src/utils/interakt.js')));
assert.ok(!/parseWaFormat|stripFormat|replace\(\/\\\*\//.test(interakt),
  'the sender rewrites the message text; the markers must travel untouched'); n++;

const lib = strip(read(path.join(BE, 'src/controllers/whatsapp.library.controller.js')));
assert.ok(!/parseWaFormat/.test(lib),
  'the quick-reply store parses formatting; it must store exactly what was typed'); n++;

console.log(`waformat: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
