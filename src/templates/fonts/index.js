/**
 * templates/fonts/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ships the invoice fonts INSIDE the PDF, instead of hoping the host has them.
 *
 * The problem this solves
 * ──────────────────────
 * Every invoice theme asks for `Arial, Helvetica, sans-serif` (and luxury asks
 * for Georgia, advanced_gst_tally for Courier New). None of those fonts exist
 * on a Linux server. On Render that was harmless: its image happens to carry
 * ~300 fonts, so fontconfig quietly substituted Liberation Sans — which is
 * metrically identical to Arial, so nothing moved and nobody noticed.
 *
 * The AWS host has no such luck. The headless Chromium we now bundle
 * (@sparticuz/chromium) ships exactly four fonts: Open Sans Regular, Bold,
 * Light and Italic. Two consequences, both verified by rendering:
 *
 *   1. Open Sans is NOT metrically compatible with Arial. Every column width
 *      and line wrap shifts.
 *   2. Open Sans has no glyph at U+20B9. Every ₹ on every invoice renders as
 *      blank space — an invoice showing "1,23,456.78" with no currency mark.
 *
 * So we stop depending on the host entirely. The three fonts below are
 * embedded as base64 data URIs in a <style> block that utils/pdf.js injects
 * into every document just before rendering. The host's font situation stops
 * mattering: Render, AWS, a laptop and a Docker image all produce byte-similar
 * output.
 *
 * Why these font files
 * ───────────────────
 * Arimo, Tinos and Cousine are metrically compatible with Arial, Times New
 * Roman and Courier New respectively — identical advance widths, so a
 * substitution cannot reflow anything. See LICENSE.txt in this folder, which
 * also explains why they must not be swapped for a merely similar-looking
 * font.
 *
 * Why only three families are declared
 * ───────────────────────────────────
 * A CSS font stack falls through, so only the FIRST family in each stack needs
 * a definition — define `Arial` and `Helvetica` is never consulted. That keeps
 * the injected payload at ~290 KB instead of repeating the same base64 once
 * per alias. If a template ever introduces a stack that starts with something
 * else, add it to the alias list below rather than editing the template.
 *
 * Cost: ~290 KB of base64 appended to each document's HTML, built once at
 * first use and cached for the life of the process. It never touches the
 * network and never hits disk after the first render.
 */

const fs = require('fs');
const path = require('path');

/** Families whose FIRST-position use in a stack must be covered. */
const FAMILIES = [
  // Arial leads every sans stack in every theme, and in statementPdf.js.
  { name: 'Arial', faces: [
    ['Arimo-Regular.woff2',    400, 'normal'],
    ['Arimo-Bold.woff2',       700, 'normal'],
    ['Arimo-Italic.woff2',     400, 'italic'],
    ['Arimo-BoldItalic.woff2', 700, 'italic'],
  ] },
  // Georgia leads the serif stack in the `luxury` theme.
  { name: 'Georgia', faces: [
    ['Tinos-Regular.woff2',    400, 'normal'],
    ['Tinos-Bold.woff2',       700, 'normal'],
    ['Tinos-Italic.woff2',     400, 'italic'],
    ['Tinos-BoldItalic.woff2', 700, 'italic'],
  ] },
  // 'Courier New' leads the mono stack in `advanced_gst_tally`.
  { name: 'Courier New', faces: [
    ['Cousine-Regular.woff2', 400, 'normal'],
    ['Cousine-Bold.woff2',    700, 'normal'],
  ] },
];

/**
 * Cousine — like the Courier New it replaces — has no ₹ glyph. Nothing in the
 * tally theme currently prints one, but if that ever changes the character
 * would fall through to the host's fonts, i.e. to nothing, i.e. to blank
 * space. A second @font-face on the SAME family name, scoped by unicode-range
 * to that single codepoint, borrows Arimo's ₹ for it. Chromium resolves this
 * per-glyph, so it affects only the rupee sign; the rest of the line stays
 * monospaced.
 */
const MONO_RUPEE_PATCH = [
  ['Arimo-Regular.woff2', 400, 'normal'],
  ['Arimo-Bold.woff2',    700, 'normal'],
];

let _css = null;

function dataUri(file) {
  const buf = fs.readFileSync(path.join(__dirname, file));
  return `data:font/woff2;base64,${buf.toString('base64')}`;
}

// NOTE: the url(...) MUST be quoted. A base64 data URI contains a comma
// (right after `;base64`), and an unquoted CSS url() token may not contain
// one — Chromium rejects the whole @font-face rule and silently falls back,
// which looks exactly like "the fonts didn't ship".
function face(family, file, weight, style, extra = '') {
  return `@font-face{font-family:'${family}';`
       + `src:url("${dataUri(file)}") format('woff2');`
       + `font-weight:${weight};font-style:${style};font-display:block;${extra}}`;
}

/**
 * The <style> block to inject into a document before rendering.
 * Built once, then cached — reading and base64-ing 10 files per PDF would be
 * pure waste.
 */
function fontFaceCss() {
  if (_css) return _css;

  let css = '';
  for (const fam of FAMILIES) {
    for (const [file, weight, style] of fam.faces) {
      css += face(fam.name, file, weight, style);
    }
  }
  for (const [file, weight, style] of MONO_RUPEE_PATCH) {
    css += face('Courier New', file, weight, style, 'unicode-range:U+20B9;');
  }

  _css = css;
  return _css;
}

/**
 * Injects the font block into a complete HTML document.
 *
 * Insertion point matters more than it looks. The block is ~290 KB, and the
 * HTML spec only honours a <meta charset> that appears within the first 1024
 * bytes of the document. Injecting straight after <head> would push every
 * theme's `<meta charset="utf-8">` far past that window; Chromium would then
 * sniff the encoding, land on windows-1252, and every ₹ in the markup would
 * come out as "â\u0082¹". So the block goes AFTER the charset declaration when
 * one is present, and only falls back to right-after-<head> when it isn't.
 *
 * (page.setContent() also carries the encoding out-of-band, so this is belt
 * and braces — but the belt costs one regex and the failure mode is every
 * invoice in the system, so it stays.)
 *
 * Every theme and statementPdf.js emits `<html><head><meta charset="utf-8">`,
 * so the first branch is the one that fires in practice. The later fallbacks
 * exist so a future template that forgets a <head> degrades to "fonts still
 * applied" rather than "fonts silently dropped".
 */
function withEmbeddedFonts(html) {
  const block = `<style>${fontFaceCss()}</style>`;

  // 1. after <head> + its charset meta (the normal case)
  const headAndCharset = /(<head(?:\s[^>]*)?>\s*<meta\s+charset\s*=\s*["']?[\w-]+["']?\s*\/?>)/i;
  if (headAndCharset.test(html)) return html.replace(headAndCharset, (m) => m + block);

  // 2. after <head>, no charset meta to preserve
  const headOpen = /<head(?:\s[^>]*)?>/i;
  if (headOpen.test(html)) return html.replace(headOpen, (m) => m + block);

  // 3. no <head> at all
  return block + html;
}

module.exports = { fontFaceCss, withEmbeddedFonts };
