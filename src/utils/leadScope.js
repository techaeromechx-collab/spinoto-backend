'use strict';

/**
 * leadScope.js — which leads a user may see at all.
 *
 * ══ WHY THIS IS ITS OWN FILE ═══════════════════════════════════════════════
 *
 * It lived in leads.controller.js, where it belonged as long as the Leads page
 * was the only thing that needed the answer. The comment it carried there is the
 * reason it does not live there any more:
 *
 *   "The same helper the list uses, rather than a fourth copy of the rule.
 *    There were three copies and they had already drifted — one built its team
 *    array as [self, ...team] and another as [...team, self], which is harmless
 *    and is exactly how the difference that is NOT harmless gets in unnoticed."
 *
 * Internal chat needs the same answer: whether a lead somebody shared in a
 * message may be NAMED to the person reading it. That is a second caller, and
 * the options were to copy the rule (the mistake the comment describes), or to
 * import a 113KB controller into a chat service and with it the whole lead
 * subsystem — whatsappAutomations, activityLog, sendPush, publicToken — none of
 * which chat has any business loading.
 *
 * So the rule moved somewhere neither caller owns. leads.controller.js imports
 * it and behaves exactly as before; services/chatRefs.service.js imports the
 * same functions. A change to lead visibility now reaches both without anybody
 * remembering to look in the second place.
 *
 * ══ THE CONTRACT ═══════════════════════════════════════════════════════════
 *
 * These build SQL fragments and PUSH INTO `params`, so a caller must:
 *   - alias the leads table `l`
 *   - pass the same array it is interpolating placeholders from
 *   - splice the returned conditions in with AND
 *
 * Nothing here is a permission check. The route still decides whether somebody
 * may look at leads at all (VIEW_LEAD / VIEW_TEAM_LEADS / VIEW_OWN_LEADS on
 * routes/leads.routes.js). This decides WHICH ones, once they may.
 */

const { pool } = require('../config/db');

/** Push a value and return its placeholder. Keeps params and $n in step. */
function ph(params, value) {
  params.push(value);
  return `$${params.length}`;
}

/**
 * Who reports to this manager, plus themselves.
 *
 * Read ONCE per request and passed to scopeConditions, which the list calls four
 * times — once for the page and once per count base. Left inside
 * scopeConditions it was four identical round trips to build one answer that
 * cannot change between them.
 */
async function teamIdsFor(user) {
  const r = await pool.query(`SELECT id FROM users WHERE manager_id = $1`, [user.id]);
  return [...r.rows.map((x) => x.id), user.id];
}

/**
 * teamIdsFor, but only when the answer will be used.
 *
 * A super admin and a VIEW_LEAD holder are not scoped at all, and an advisor
 * with VIEW_OWN_LEADS is scoped by their own id — neither needs the lookup, and
 * running it anyway is a query per request for a value that gets discarded.
 */
async function teamIdsIfNeeded(user) {
  if (user.is_super_admin || user.permissions.has('VIEW_LEAD')) return null;
  if (!user.permissions.has('VIEW_TEAM_LEADS')) return null;
  return teamIdsFor(user);
}

/** Which leads this user may see at all. Pushes into `params`. */
function scopeConditions(user, teamIds, params) {
  if (user.is_super_admin || user.permissions.has('VIEW_LEAD')) return [];

  if (teamIds) return [`(l.created_by = ANY(${ph(params, teamIds)}))`];

  // VIEW_OWN_LEADS — created by them OR given to them. The second half is what
  // makes handing somebody a lead work at all.
  const me = ph(params, user.id);
  return [`(l.created_by = ${me} OR l.assigned_to = ${me})`];
}

module.exports = { ph, teamIdsFor, teamIdsIfNeeded, scopeConditions };
