'use strict';

/**
 * chat.directory.controller.js — who you can message.
 *
 * ══ WHY THIS IS NOT /api/users/assignable ══════════════════════════════════
 *
 * That endpoint is the closest thing that already exists and it is unusable
 * here. Its query is:
 *
 *   SELECT id, name FROM users
 *    WHERE is_active = TRUE
 *      AND hub_id IS NULL
 *      AND is_super_admin = FALSE     ← this line
 *      AND id != $1
 *
 * It excludes super admins, which in this business means it excludes the owner.
 * A staff directory that cannot reach the owner is not a staff directory, and
 * the first thing anybody would try to do with chat is message him.
 *
 * Reusing it and "just removing that line" was the other option. It is used by
 * every Assign To dropdown in the app, where excluding super admins is
 * deliberate — you do not assign a lead to the owner. Widening it for chat
 * would have quietly put him in every assignment dropdown in the CRM.
 *
 * /api/users itself needs MANAGE_USERS or VIEW_TEAM_LEADS, which most staff do
 * not have. So: a new endpoint, and a deliberately thin one.
 *
 * ══ WHAT IT RETURNS, AND WHAT IT WILL NOT ══════════════════════════════════
 *
 * { id, name } and nothing else. No email, no mobile, no permissions, no hub,
 * no manager, no last-seen. This is the widest-audience user list in the
 * application — every USE_CHAT holder can read it — so it holds the least it
 * can while still being useful, which is a name to pick from a list.
 *
 * ══ STAFF ONLY, ENFORCED TWICE ═════════════════════════════════════════════
 *
 * hub_id IS NULL here, and App.jsx's RequireAdmin already sends hub users to
 * their own portal. Both, because they answer to different owners: one is this
 * query, the other is a router somebody may refactor.
 *
 * The reason is not tidiness. utils/maskMobile.js masks the KEYS `mobile` and
 * `whatsapp` for hub sessions — it cannot mask a phone number an advisor types
 * into a sentence, and nothing in this codebase can. Until there is a decision
 * about what a hub user may be told in prose, staff↔hub chat does not exist.
 */

const { pool } = require('../config/db');
const { MIN_SEARCH_LENGTH } = require('../utils/listSearch');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

/**
 * GET /api/chat/directory?q=
 *
 * No pagination. This is one workshop's staff list — tens of people, not
 * thousands — and a picker that pages is a picker nobody finds anybody in. The
 * LIMIT is a backstop against a directory that grows past what the assumption
 * can carry, not a page size.
 */
function listDirectory(req, res, next) {
  handle(req, res, next, async () => {
    const q = (req.query.q || '').trim();

    /* Same minimum as every other search in the app (utils/listSearch.js), so a
       single keystroke does not run a LIKE over the whole table. Below the
       minimum the search is ignored rather than refused — the full list is a
       perfectly good answer for a directory this size. */
    const useSearch = q.length >= MIN_SEARCH_LENGTH;

    const params = [req.user.id];
    let filter = '';
    if (useSearch) {
      params.push(`%${q}%`);
      filter = `AND u.name ILIKE $${params.length}`;
    }

    const r = await pool.query(
      `SELECT u.id, u.name
         FROM users u
        WHERE u.is_active = TRUE
          AND u.hub_id IS NULL
          AND u.id <> $1
          ${filter}
        ORDER BY u.name ASC
        LIMIT 200`,
      params
    );

    res.json({ items: r.rows, searched: useSearch });
  });
}

module.exports = { listDirectory };
