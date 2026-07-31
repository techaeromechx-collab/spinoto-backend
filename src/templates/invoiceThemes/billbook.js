/**
 * RETIRED — the "Billbook" theme (and its A5 variant) were removed.
 *
 * This file is no longer required by registry.js and renders nothing. It is
 * kept only as a tombstone so the removal is obvious to anyone who goes
 * looking for the theme; it is safe to delete.
 *
 * Companies still holding 'billbook' or 'billbook_a5' in their saved
 * document_config are handled without a migration: those keys are no longer in
 * VALID_THEMES, so resolveDocumentConfig() falls back to the default theme,
 * and getTheme() falls back to 'spinoto' — neither errors.
 */
module.exports = null;
