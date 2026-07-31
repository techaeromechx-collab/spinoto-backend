/**
 * registry.js — maps a company_settings.invoice_theme key to its render
 * module. Keep this list in sync with:
 *   - backend/src/controllers/settings.controller.js's VALID_INVOICE_THEMES
 *   - frontend/src/components/settings/InvoiceThemeSettings.jsx's THEMES list
 *
 * Every theme has its own template. The "(A5)" variant reuses its A4
 * counterpart's render function verbatim — the template is told which sheet
 * it's on and scales itself (see docShared.pageScaleCss), so no second file
 * and no second set of hand-tuned dimensions.
 *
 * `fixedPageSize` means the sheet is INTRINSIC to the theme — choosing the
 * "(A5)" theme is how a user asks for A5, so it must win over the global
 * page-size setting. Themes without it follow that setting.
 *
 * It is deliberately not called `pageSize`: every theme module used to export
 * `pageSize: 'A4'` as a default, which meant `theme.pageSize || global` always
 * short-circuited on 'A4' and the global A5 setting silently did nothing.
 *
 * getTheme() falls back to 'spinoto' for an unknown key, so a company still
 * holding a retired theme id (e.g. the removed 'billbook') keeps printing
 * rather than erroring.
 */

const simple             = require('./simple');
const modern             = require('./modern');
const luxury             = require('./luxury');
const stylish            = require('./stylish');
const advancedGst        = require('./advanced_gst');
const advancedGstTally   = require('./advanced_gst_tally');
const spinoto            = require('./spinoto');

const THEMES = {
  spinoto,
  simple,
  modern,
  luxury,
  stylish,
  advanced_gst:       advancedGst,
  advanced_gst_tally: advancedGstTally,
  advanced_gst_a5:    { ...advancedGst, fixedPageSize: 'A5' },
};

function getTheme(key) {
  return THEMES[key] || THEMES.spinoto;
}

module.exports = { THEMES, getTheme };
