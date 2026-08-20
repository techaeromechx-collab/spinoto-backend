'use strict';

/**
 * The WhatsApp routing rota — who takes which kind of enquiry.
 *
 * Reads and writes the two tables migration 158 adds:
 *
 *   wa_categories  the answers the Interakt flow can send back
 *   wa_agents      which of those each user takes, and whether they are on duty
 *
 * Everything here is configuration, so it is all behind
 * MANAGE_WHATSAPP_TEMPLATES like the rest of Settings → WhatsApp. Deciding who
 * receives customers is not a thing an advisor should be able to change for
 * themselves.
 */

const { z } = require('zod');
const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch((err) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || 'Invalid request.' });
    }
    next(err);
  });
}

/**
 * Every user who could be given a lead, with their rota row.
 *
 * A LEFT JOIN, not a list of wa_agents rows: the screen is "your team", and a
 * user with no row yet must appear with everything unticked rather than be
 * missing. Otherwise adding somebody to the rota would mean first knowing they
 * were absent from a table nobody can see.
 *
 * Inactive users are excluded — they cannot be assigned anything (the picker
 * checks is_active), so offering their checkboxes would be a lie.
 *
 * Hub logins are excluded for the same reason. A row in users with hub_id set
 * is a workshop's portal account (migration 066) — QuickFix, SpeedCare — not a
 * person on your team. They do not work leads, they never open this CRM, and
 * offering to send them a customer conversation is a checkbox that can only
 * ever be a mistake. The picker refuses them too, so this is not merely
 * cosmetic: the two agree.
 */
function listRota(req, res, next) {
  handle(req, res, next, async () => {
    const cats = await pool.query(
      `SELECT id, name, sort_order, is_active
         FROM wa_categories
        WHERE is_active
        ORDER BY sort_order, id`);

    const users = await pool.query(
      `SELECT u.id, u.name, u.email, u.department,
              COALESCE(a.handles, '{}') AS handles,
              -- TRUE, not FALSE, for a user with no wa_agents row yet.
              --
              -- FALSE was wrong twice. It contradicted the column's own default
              -- — creating the row would set TRUE — and it rendered every user
              -- greyed out on first open, so a screen where nothing had been
              -- configured looked like a screen where everyone was disabled.
              --
              -- Nobody is assigned anything by being on duty; they are assigned
              -- by having a category ticked. Off duty means "ticked, but not
              -- today", which is a thing somebody chose, not a default.
              COALESCE(a.on_duty, TRUE) AS on_duty,
              COALESCE(a.takes_all, FALSE) AS takes_all,
              COALESCE(a.takes_unrouted, FALSE) AS takes_unrouted,
              -- ── Can this person actually OPEN a WhatsApp conversation? ──
              --
              -- Routing was happily handing customers to an advisor who could
              -- not read them: no badge, no thread, a red "you don't have
              -- permission" where the conversation should be, and a customer
              -- waiting for a reply nobody knew about. Nothing connected "on
              -- the rota" with "allowed to read WhatsApp", so the rota could
              -- name somebody structurally unable to do the job.
              --
              -- The same two codes routes/whatsapp.routes.js gates reading on.
              -- A super admin passes everything, which is why they are ORed in
              -- here rather than only checked in the app.
              (u.is_super_admin OR EXISTS (
                 SELECT 1 FROM user_permissions up
                  WHERE up.user_id = u.id
                    AND up.permission_code IN ('SEND_WHATSAPP', 'VIEW_WHATSAPP_LOGS')
              )) AS can_read_whatsapp,
              a.last_assigned_at,
              (a.user_id IS NOT NULL) AS on_rota
         FROM users u
         LEFT JOIN wa_agents a ON a.user_id = u.id
        WHERE u.is_active
          AND u.hub_id IS NULL
        ORDER BY LOWER(u.name), u.id`);

    res.json({ categories: cats.rows, users: users.rows });
  });
}

const rotaBody = z.object({
  rows: z.array(z.object({
    user_id: z.coerce.number().int().positive(),
    handles: z.array(z.string().trim().min(1).max(80)).max(50),
    on_duty: z.boolean(),
  })).max(500),
});

/**
 * Save the whole grid in one go.
 *
 * The screen is a table of checkboxes with one Save, so the request is the
 * whole table. A per-cell PATCH would be chattier and would let two people
 * editing at once produce a rota neither of them chose.
 *
 * last_assigned_at is NEVER touched here. It is the round-robin's position, and
 * resetting it on every save would restart the rotation from the top each time
 * somebody opened Settings — one person would get every lead after each edit.
 */
function saveRota(req, res, next) {
  handle(req, res, next, async () => {
    const body = rotaBody.parse(req.body);

    // Only categories that exist. A handle naming something that was deleted
    // can never match an incoming answer, so it is silent dead weight — better
    // dropped at the door than stored and wondered about later.
    const known = await pool.query(`SELECT name FROM wa_categories WHERE is_active`);
    const byNorm = new Map(known.rows.map(r => [r.name.trim().toLowerCase(), r.name]));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const row of body.rows) {
        // Stored in the canonical spelling from wa_categories, so the array
        // never accumulates 'car', 'Car ' and 'CAR' as three different things.
        const handles = [...new Set(
          row.handles.map(h => byNorm.get(h.trim().toLowerCase())).filter(Boolean)
        )];

        await client.query(
          `INSERT INTO wa_agents (user_id, handles, on_duty, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id) DO UPDATE
              SET handles = EXCLUDED.handles,
                  on_duty = EXCLUDED.on_duty,
                  updated_at = NOW()`,
          [row.user_id, handles, row.on_duty]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, saved: body.rows.length });
  });
}

const categoryBody = z.object({
  name: z.string().trim().min(1).max(80),
});

/**
 * Add a category — or bring back one that was retired.
 *
 * Retiring is a soft delete (is_active = FALSE), which keeps everyone's ticks
 * so the category can return intact. But the name stays taken: the unique index
 * is on LOWER(TRIM(name)) with no is_active predicate, deliberately, so two
 * rows can never both claim "Car".
 *
 * The first version of this refused the re-add with "already a category" —
 * pointing at a row the screen does not show. Delete Car, change your mind, and
 * the name was unusable forever with no way back and no explanation.
 *
 * So a name that exists but is retired is REACTIVATED rather than rejected,
 * which is what somebody typing it back in means.
 */
function createCategory(req, res, next) {
  handle(req, res, next, async () => {
    const { name } = categoryBody.parse(req.body);

    const dup = await pool.query(
      `SELECT id, is_active FROM wa_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`, [name]);

    if (dup.rowCount && dup.rows[0].is_active) {
      return res.status(409).json({ error: `"${name}" is already in the list.` });
    }

    if (dup.rowCount) {
      // Back from retirement, with its old ticks. Renamed to exactly what was
      // typed, so "car" typed today replaces the "Car " that was there before
      // and the list shows the spelling somebody actually chose.
      const back = await pool.query(
        `UPDATE wa_categories
            SET is_active = TRUE, name = $2,
                sort_order = COALESCE((SELECT MAX(sort_order) + 1 FROM wa_categories WHERE is_active), 1)
          WHERE id = $1
          RETURNING id, name, sort_order, is_active`,
        [dup.rows[0].id, name]
      );
      return res.status(200).json(back.rows[0]);
    }

    const r = await pool.query(
      `INSERT INTO wa_categories (name, sort_order)
       VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM wa_categories WHERE is_active), 1))
       RETURNING id, name, sort_order, is_active`,
      [name]
    );
    res.status(201).json(r.rows[0]);
  });
}

const allOwnerBody = z.object({
  // null turns the mode off. Not an omitted field: "clear it" and "I forgot to
  // send it" must not be the same request.
  user_id: z.coerce.number().int().positive().nullable(),
});

/**
 * Hand every WhatsApp lead to one person — or stop.
 *
 * Its own endpoint rather than a column in the grid's PUT, because it is one
 * choice about the whole business, not a per-user setting. A checkbox column
 * would let two people be ticked, which is the single thing this mode exists to
 * prevent, and the error would only surface at the database.
 *
 * The clear-then-set is why this needs a transaction: for the instant between
 * the two statements there is no owner, and a message arriving in that gap must
 * not read a half-applied rota.
 */
function setAllOwner(req, res, next) {
  handle(req, res, next, async () => {
    const { user_id: userId } = allOwnerBody.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Unconditionally, even when setting the same person again — it is the
      // only statement that guarantees exactly one row is left holding it.
      await client.query(`UPDATE wa_agents SET takes_all = FALSE WHERE takes_all`);

      if (userId) {
        // hub_id IS NULL for the same reason listRota filters on it: a hub
        // portal account is a workshop, not a colleague, and handing it every
        // customer conversation in the business is not a thing to allow by
        // accident.
        const u = await client.query(
          `SELECT id, name FROM users WHERE id = $1 AND is_active AND hub_id IS NULL`, [userId]);
        if (!u.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'That user does not exist, is deactivated, or is a hub login rather than a team member.',
          });
        }

        // They may have no rota row yet — being handed every lead is a perfectly
        // reasonable way to join the rota. on_duty TRUE on insert, because a
        // user created off duty would have this mode do nothing at all and look
        // broken.
        await client.query(
          `INSERT INTO wa_agents (user_id, takes_all, on_duty, updated_at)
           VALUES ($1, TRUE, TRUE, NOW())
           ON CONFLICT (user_id) DO UPDATE
              SET takes_all = TRUE, on_duty = TRUE, updated_at = NOW()`,
          [userId]
        );
      }

      await client.query('COMMIT');
      return res.json({ ok: true, user_id: userId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Who takes the leads the rules cannot sort. (migration 160)
 *
 * Deliberately a near-copy of setAllOwner rather than a shared helper with a
 * column name passed in. The two endpoints are four lines of SQL each, they
 * validate the same user the same way because that check is about who may be
 * given customers at all, and a generic "set a boolean flag on wa_agents by
 * name" function is one refactor away from an endpoint that can set any column
 * the caller names.
 *
 * The one real difference is on_duty. setAllOwner forces it TRUE, because
 * "everything comes to me" while off duty does nothing at all and looks broken.
 * Here it is left alone: the fallback owner is usually already on the rota with
 * their own categories, and quietly putting somebody back on duty because an
 * admin picked them from a dropdown would undo a choice they made about their
 * own day.
 *
 * A user with no rota row at all is the exception — they are inserted on duty,
 * since the column defaults that way and being off duty from the instant of
 * being given the job is not what anyone meant.
 */
function setUnroutedOwner(req, res, next) {
  handle(req, res, next, async () => {
    const { user_id: userId } = allOwnerBody.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`UPDATE wa_agents SET takes_unrouted = FALSE WHERE takes_unrouted`);

      if (userId) {
        const u = await client.query(
          `SELECT id, name FROM users WHERE id = $1 AND is_active AND hub_id IS NULL`, [userId]);
        if (!u.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'That user does not exist, is deactivated, or is a hub login rather than a team member.',
          });
        }

        await client.query(
          `INSERT INTO wa_agents (user_id, takes_unrouted, updated_at)
           VALUES ($1, TRUE, NOW())
           ON CONFLICT (user_id) DO UPDATE
              SET takes_unrouted = TRUE, updated_at = NOW()`,
          [userId]
        );
      }

      await client.query('COMMIT');
      return res.json({ ok: true, user_id: userId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Retire a category.
 *
 * Deactivated, not deleted, and the handles arrays are left alone: they are
 * filtered against the ACTIVE list on both read and write, so a retired
 * category stops routing immediately and comes back with its ticks intact if
 * somebody reactivates it. Deleting would silently rewrite everyone's rota.
 */
function deleteCategory(req, res, next) {
  handle(req, res, next, async () => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    const r = await pool.query(
      `UPDATE wa_categories SET is_active = FALSE WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });
}

module.exports = {
  listRota, saveRota, setAllOwner, setUnroutedOwner, createCategory, deleteCategory,
};
