'use strict';

/**
 * hubScope.js — server-side hub tenancy.
 * ────────────────────────────────────────────────────────────────────────────
 * A hub-portal login (`users.hub_id IS NOT NULL`) must only ever see its own
 * hub's records. Until this file existed that was enforced entirely in React:
 * every list page seeded a hub filter from `user.hub_id` and sent
 * `?hub_ids=<n>`. The API trusted it. A hub partner calling the endpoint
 * directly — or a stale filter restored from sessionStorage after an admin
 * logged out of the same tab — saw every hub's appointments, estimates,
 * invoices and payouts.
 *
 * The rule these helpers implement is an OVERRIDE, not a filter:
 *
 *     if the session has a hub_id, that hub replaces whatever the query
 *     string asked for. The two are never merged.
 *
 * Merging would be pointless — `?hub_ids=1,2` intersected with "your hub is 2"
 * is just "2" — and intersecting is easy to get subtly wrong. Overriding is
 * one branch and cannot widen.
 *
 * This is the pattern warranty_claims.controller.js already used
 * (`if (req.user.hub_id) hubId = req.user.hub_id`); this file makes it
 * reusable so it can be applied consistently rather than remembered.
 *
 * NULL hub_id rows (a booking-site appointment before a hub is assigned, a
 * standalone estimate) are deliberately invisible to hub users: the comparison
 * is a plain `= $n`, and NULL never equals anything. An unassigned job is not
 * yet theirs.
 */

/**
 * Returns a SQL fragment scoping a query to the session's hub, or `null` for
 * staff/super-admin sessions (which are unrestricted here and keep whatever
 * `?hub_ids=` handling the caller already has).
 *
 * Usage — the hub branch must come BEFORE the caller's own query-param filter,
 * and that filter must be skipped when this returns a fragment:
 *
 *     const hubSql = hubScopeSql(req, params, 'ci.hub_id');
 *     if (hubSql) {
 *       conditions.push(hubSql);
 *     } else if (req.query.hub_ids) {
 *       ...existing behaviour...
 *     }
 *
 * @param {object} req      Express request (needs `req.user`).
 * @param {any[]}  params   The query's parameter array — mutated in place.
 * @param {string} column   Qualified column, e.g. 'a.hub_id'. INTERPOLATED into
 *                          the SQL, so it must be a hardcoded literal at the
 *                          call site — never anything derived from user input.
 *                          Same rule as utils/listSearch.js.
 * @returns {string|null}
 */
function hubScopeSql(req, params, column) {
  const hubId = req?.user?.hub_id;
  if (!hubId) return null;
  params.push(hubId);
  return `${column} = $${params.length}`;
}

/** True when this request comes from a hub-portal login. */
function isHubUser(req) {
  return Boolean(req?.user?.hub_id);
}

/**
 * Throws when a hub user reaches a record belonging to another hub.
 *
 * Deliberately 404, not 403. A 403 confirms the row exists, which turns id
 * enumeration into a census — "how many invoices does the hub down the road
 * have?" is answerable from the status code alone. 404 is indistinguishable
 * from an id that was never real.
 *
 * Call it AFTER loading the row and BEFORE returning or mutating it.
 *
 * @param {object} req
 * @param {object|null|undefined} row
 * @param {string} field  Property on `row` holding the hub id.
 * @param {string} label  Noun used in the 404 message.
 */
function assertHubOwns(req, row, field = 'hub_id', label = 'Record') {
  const hubId = req?.user?.hub_id;
  if (!hubId) return;
  // A row with no hub is not this hub's row either — see the NULL note above.
  if (!row || row[field] !== hubId) {
    const err = new Error(`${label} not found`);
    err.status = 404;
    throw err;
  }
}

module.exports = { hubScopeSql, isHubUser, assertHubOwns };
