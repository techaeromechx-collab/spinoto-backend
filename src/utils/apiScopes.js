'use strict';

/**
 * The scope vocabulary for read-only master-data API keys.
 *
 * Deliberately coarse — one scope per area, read only. Finer granularity
 * (per-endpoint, per-field) sounds safer and isn't: it produces keys nobody
 * can reason about, so in practice every key gets issued with everything
 * ticked. Six scopes is a list an admin can hold in their head while deciding
 * what a partner should see.
 *
 * There is no `:write`. Master data feeds live pricing — per CLAUDE.md a
 * pricing rule's specificity score decides what a customer is quoted, and
 * changing rules silently reprices future estimates. Nothing outside this
 * application should be able to do that over HTTP.
 */

const SCOPES = {
  'services:read': {
    label: 'Services & Categories',
    description: 'Service list, categories, SAC codes, GST rates and base customer rates.',
  },
  'pricing:read': {
    label: 'Pricing',
    description:
      'Resolved vehicle-specific prices. COMMERCIALLY SENSITIVE — a holder can read your entire price list.',
  },
  'parts:read': {
    label: 'Parts',
    description: 'Parts catalogue with customer-facing rates.',
  },
  'vehicles:read': {
    label: 'Vehicle Master',
    description: 'Makes, models, body types, segments and CC categories.',
  },
  'discounts:read': {
    label: 'Discounts',
    description: 'Active discount rules and their validity windows.',
  },
  'hubs:read': {
    label: 'Hubs',
    description: 'Hub/branch names and service locations. Never financial terms.',
  },
};

const SCOPE_CODES = Object.keys(SCOPES);

/**
 * Column names that must never appear in an API response.
 *
 * These are what the business PAYS, not what a customer is charged:
 * `hub_rate` is the hub's cut of a line, `commission`/`commission_percent`
 * are the platform's take. Publish any of them and a partner can derive the
 * margin on every job you do.
 *
 * Enforced by a test that inspects real response bodies rather than by
 * convention, because the realistic failure mode is someone adding a
 * `SELECT *` to a v1 endpoint months from now without knowing this.
 */
const FORBIDDEN_RESPONSE_FIELDS = ['hub_rate', 'commission', 'commission_percent'];

function isValidScope(s) {
  return Object.prototype.hasOwnProperty.call(SCOPES, s);
}

/** Validate a requested scope list. Returns { ok, invalid[] }. */
function validateScopes(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, invalid: [], reason: 'At least one scope is required' };
  }
  const invalid = list.filter(s => !isValidScope(s));
  return { ok: invalid.length === 0, invalid };
}

module.exports = {
  SCOPES,
  SCOPE_CODES,
  FORBIDDEN_RESPONSE_FIELDS,
  isValidScope,
  validateScopes,
};
